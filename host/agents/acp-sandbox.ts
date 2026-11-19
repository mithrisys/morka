import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { agentConfigNames, info } from "../project/files";
import { agentPath } from "./process";

export type AcpProfile = {
  id: string; name: string; command: string; args: string[]; env?: Record<string, string>; readPaths?: string[];
};

async function findExecutable(command: string) {
  const paths = isAbsolute(command) ? [command] : agentPath().split(delimiter).filter(isAbsolute).map(path => join(path, command));
  for (const path of paths) {
    if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  throw new Error(`Agent executable not found: ${command}.`);
}

async function hermesScope(state: string, draft: string, catalog: boolean) {
  const root = join(state, ".hermes");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  const name = catalog ? "catalog" : hash(draft);
  const scopes = join(state, "hermes-workspaces");
  const home = join(scopes, name);
  for (const folder of [root, scopes, home]) {
    await mkdir(folder, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await info(folder))?.isDirectory()) throw new Error("Invalid Hermes profile directory.");
  }
  // Hermes shares a gateway across named profiles in a root. Each workspace
  // needs its own root so the gateway inherits that workspace's write sandbox.
  for (const file of ["config.yaml", ".env", "auth.json"]) {
    const source = join(root, file);
    const destination = join(home, file);
    const from = await info(source);
    const to = await info(destination);
    if (from?.isFile() && (!to || (to.isFile() && from.mtimeMs > to.mtimeMs))) await copyFile(source, destination);
  }
  const sockets = join("/private/tmp", "morka-acp-" + hash(home));
  await mkdir(sockets, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const socketDir = await info(sockets);
  if (!socketDir?.isDirectory() || socketDir.uid !== process.getuid?.() || (socketDir.mode & 0o077)) {
    throw new Error("The Hermes control socket requires a private directory.");
  }
  return { home, sockets };
}

export async function spawnAcp(profile: AcpProfile, workspace: string, statePath: string, projectRoot: string,
  purpose: "chat" | "catalog" = "chat", attachmentPaths: string[] = []) {
  if (process.platform !== "darwin") throw new Error("This build requires macOS to run ACP agents.");
  const home = await realpath(homedir());
  const executable = await findExecutable(profile.command);
  const binary = await realpath(executable);
  const draft = await realpath(workspace);
  const privateName = "home";
  await mkdir(join(statePath, privateName, "tmp"), { recursive: true, mode: 0o700 });
  const state = await realpath(join(statePath, privateName));
  const hermes = profile.id === "hermes" ? await hermesScope(state, draft, purpose === "catalog") : undefined;
  const writable = [state, draft, ...(hermes ? [hermes.sockets] : [])];
  const allowed = [...writable, ...profile.readPaths ?? [], ...attachmentPaths];
  const readable = (await Promise.all(allowed.map(path => realpath(path).catch(() => undefined))))
    .filter((path): path is string => Boolean(path && path !== "/" && path !== home));
  const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  const ancestors = new Set([home]);
  for (const path of [...readable, executable, binary]) {
    for (let parent = dirname(path); parent.startsWith(home + "/"); parent = dirname(parent)) {
      ancestors.add(parent);
    }
  }
  const draftSettings = agentConfigNames.map(name => subpath(join(draft, name))).join(" ");
  const rules = [
    "(version 1)",
    "(allow default)",
    `(deny file-read* ${subpath(home)})`,
    `(allow file-read-metadata ${[...ancestors].map(literal).join(" ")})`,
    `(allow file-read* ${[...readable.map(subpath), literal(executable), literal(binary)].join(" ")})`,
    `(deny file-read* ${subpath(projectRoot)} ${draftSettings})`,
    "(deny file-write*)",
    `(allow file-write* ${writable.map(subpath).join(" ")} ${literal("/dev/null")})`,
    `(deny file-write* ${subpath(projectRoot)} ${draftSettings})`,
  ].join("\n");
  const forwarded = Object.fromEntries(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY",
    "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"]
    .flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  return spawn("/usr/bin/sandbox-exec", ["-p", rules, executable, ...profile.args], {
    cwd: draft,
    env: {
      ...forwarded, ...profile.env, HOME: state,
      PATH: [profile.env?.PATH, agentPath()].filter(Boolean).join(delimiter), TMPDIR: join(state, "tmp"),
      XDG_CONFIG_HOME: join(state, ".config"), XDG_DATA_HOME: join(state, ".local/share"),
      XDG_STATE_HOME: join(state, ".local/state"), XDG_CACHE_HOME: join(state, ".cache"),
      HERMES_HOME: hermes?.home ?? join(state, ".hermes"), PI_CODING_AGENT_DIR: join(state, ".pi/agent"),
      ...(hermes ? { XDG_RUNTIME_DIR: hermes.sockets } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}

export function stopAgent(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
