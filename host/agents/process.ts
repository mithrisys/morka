import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join } from "node:path";

export function agentPath() {
  const paths = (process.env.PATH || process.env.Path || "").split(delimiter)
    .filter(path => isAbsolute(path) && !(basename(path) === ".bin" && basename(dirname(path)) === "node_modules"));
  const defaults = process.platform === "win32"
    ? [join(homedir(), ".local", "bin"), process.env.APPDATA && join(process.env.APPDATA, "npm"),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")]
    : [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set([...paths, ...defaults.filter(Boolean)])].join(delimiter);
}

const packages = {
  codex: ["@openai", "codex", "bin", "codex.js"],
  claude: ["@anthropic-ai", "claude-code", "cli.js"],
};
export type LocalProvider = keyof typeof packages;

export async function agentLaunch(provider: LocalProvider, args: string[]) {
  const override = process.env[provider === "codex" ? "CODEX_BIN" : "CLAUDE_BIN"];
  const windows = process.platform === "win32";
  const path = agentPath();
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path };
  if (windows) delete env.Path;
  const paths = path.split(delimiter).filter(Boolean);
  const executable = override || provider;
  const candidates = isAbsolute(executable) ? [executable] : paths.map(directory => join(directory, executable));
  const exists = (file: string) => access(file).then(() => true, () => false);
  for (const candidate of candidates) {
    if (!windows) {
      if (await exists(candidate)) return { command: candidate, args, env };
      continue;
    }
    const extension = extname(candidate).toLowerCase();
    const native = extension ? candidate : candidate + ".exe";
    if ((!extension || extension === ".exe" || extension === ".com") && await exists(native)) {
      return { command: native, args, env };
    }
    // npm's .cmd wrappers require a command shell. Run the known JavaScript
    // entry point directly so project paths and prompts stay literal arguments.
    if (extension !== ".js" && extension !== "" && extension !== ".cmd" && extension !== ".bat") continue;
    if (extension !== ".js" && !(await exists(extension ? candidate : candidate + ".cmd"))) continue;
    const directory = dirname(candidate);
    const modules = basename(directory) === ".bin" ? dirname(directory) : join(directory, "node_modules");
    const entry = extension === ".js" ? candidate : join(modules, ...packages[provider]);
    if (!(await exists(entry))) continue;
    for (const node of [process.env.MORKA_LOCAL_NODE, ...paths.map(directory => join(directory, "node.exe"))]) {
      if (node && isAbsolute(node) && await exists(node)) return { command: node, args: [entry, ...args], env };
    }
  }
  const name = provider === "codex" ? "Codex" : "Claude Code";
  throw new Error(`${name} was not found. Open AI setup or set ${provider === "codex" ? "CODEX_BIN" : "CLAUDE_BIN"} to the CLI path.`);
}
