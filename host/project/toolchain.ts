import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { parseEnv, promisify } from "node:util";

let developerDirectory: Promise<string | undefined> | undefined;
function developerTools() {
  developerDirectory ??= promisify(execFile)("/usr/bin/xcode-select", ["-p"]).then(async result => {
    const path = await realpath(result.stdout.trim());
    return path.startsWith("/Library/Developer/") || path.endsWith(".app/Contents/Developer") ? path : undefined;
  }).catch(() => undefined);
  return developerDirectory;
}

export type Toolchain = { root: string; node: string; npm: string; identity: string; platform: string; arch: string; system?: boolean; headers?: string };

export async function npmEntry(node: string, configured?: string) {
  const bin = dirname(await realpath(node));
  const candidates = [
    configured,
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(bin, "..", "share", "nodejs", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || basename(candidate).toLowerCase() !== "npm-cli.js") continue;
    try {
      const npm = await realpath(candidate);
      const metadata = JSON.parse(await readFile(join(npm, "..", "..", "package.json"), "utf8"));
      if (metadata.name === "npm") return npm;
    } catch { /* Try the next installation layout. */ }
  }
  throw new Error("Morka needs Node.js 24 or newer and npm. Run this project with npm start.");
}

export async function bundledToolchain(root?: string): Promise<Toolchain> {
  if (!root && process.env.MORKA_LOCAL_NODE && process.env.MORKA_LOCAL_NPM) {
    const node = await realpath(process.env.MORKA_LOCAL_NODE);
    const npm = await npmEntry(node, process.env.MORKA_LOCAL_NPM);
    const { stdout } = await promisify(execFile)(node, ["-p",
      "JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,abi:process.versions.modules})"],
    { timeout: 5000, env: { ...process.env, NODE_OPTIONS: "" }, windowsHide: true });
    const info = JSON.parse(stdout);
    if (info.platform !== process.platform || info.arch !== process.arch || Number(info.node.split(".")[0].slice(1)) < 24) {
      throw new Error("Use Node.js 24 or newer for this platform and architecture.");
    }
    const npmPackage = JSON.parse(await readFile(join(npm, "..", "..", "package.json"), "utf8"));
    const identity = JSON.stringify({ version: 1, node: info.node, npm: npmPackage.version,
      platform: info.platform, arch: info.arch, abi: info.abi });
    const nodeRoot = dirname(dirname(node));
    const headers = await realpath(join(nodeRoot, "include", "node", "node.h")).then(() => nodeRoot, () => undefined);
    return { root: dirname(node), node, npm, identity, platform: info.platform, arch: info.arch, system: true, headers };
  }
  root ??= join(__dirname, "../toolchain");
  const metadata = JSON.parse(await readFile(join(root, "toolchain.json"), "utf8"));
  if (metadata.version !== 1 || metadata.platform !== process.platform || metadata.arch !== process.arch) {
    throw new Error("The bundled Node runtime does not match this computer's platform and architecture.");
  }
  root = await realpath(root);
  return { root, node: join(root, "bin", "node"), npm: join(root, "npm", "bin", "npm-cli.js"), headers: root,
    identity: JSON.stringify(metadata), platform: metadata.platform, arch: metadata.arch };
}

export function runtimeEnvironment(toolchain: Toolchain, home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const windows = process.platform === "win32";
  const temp = join(home, "tmp");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const systemPath = windows
    ? [join(systemRoot, "System32"), systemRoot, process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "cmd")]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"];
  return {
    LANG: process.env.LANG || "en_US.UTF-8",
    PATH: [dirname(toolchain.node), ...systemPath].filter(Boolean).join(delimiter),
    ...extra,
    HOME: home, TMPDIR: temp,
    ...(windows ? { SystemRoot: systemRoot, ComSpec: join(systemRoot, "System32", "cmd.exe"), USERPROFILE: home,
      APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}),
  };
}

// Package lifecycle scripts can build native addons and use the network, but
// cannot read other projects, user data, the host HOME or agent credentials.
export async function packageProcess(toolchain: Toolchain, args: string[], directory: string, profile: string,
  cache: string, options: { signal?: AbortSignal; onLog?: (text: string) => void; auth?: boolean } = {}) {
  const mac = process.platform === "darwin";
  const buildHome = join(dirname(directory), "home");
  await mkdir(join(buildHome, "tmp"), { recursive: true, mode: 0o700 });
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const roots = await Promise.all([dirname(directory), profile, cache].map(path => realpath(path)));
  const toolchainPaths = toolchain.system ? [join(toolchain.npm, "..", "..")] : [toolchain.root];
  if (toolchain.system && toolchain.headers) toolchainPaths.push(join(toolchain.headers, "include", "node"));
  const executables = [toolchain.node, join(dirname(toolchain.node), "npm"), join(dirname(toolchain.node), "npx")];
  const developer = mac ? await developerTools() : undefined;
  const developerRoot = developer?.endsWith(".app/Contents/Developer") ? dirname(dirname(developer)) : developer;
  const sdk = developer ? await realpath(join(developer, developer.endsWith("Contents/Developer") ?
    "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk" : "SDKs/MacOSX.sdk")).catch(() => undefined) : undefined;
  const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  const ancestors = new Set<string>(["/", "/var", "/tmp", "/etc", "/var/db", "/private/var/db", "/var/db/xcode_select_link", "/private/var/db/xcode_select_link", "/Library", "/Library/Preferences", "/Library/Preferences/com.apple.dt.Xcode.plist"]);
  for (const root of [...roots, ...toolchainPaths, toolchain.node, ...(developerRoot ? [developerRoot] : []), "/opt/homebrew"]) {
    for (let parent = dirname(root); parent !== dirname(parent); parent = dirname(parent)) ancestors.add(parent);
  }
  const rules = ["(version 1)", "(allow default)", "(deny appleevent-send)", "(deny file-read*)",
    `(allow file-read* ${[...roots, ...toolchainPaths, ...(developerRoot ? [developerRoot] : []), "/System", "/usr", "/bin", "/sbin", "/Library/Developer", "/Library/Apple", "/private/etc", "/private/var/select", "/dev", "/opt/homebrew/bin", "/opt/homebrew/include", "/opt/homebrew/lib", "/opt/homebrew/opt", "/opt/homebrew/Cellar"].map(subpath).join(" ")} ${executables.map(literal).join(" ")})`,
    `(allow file-read* ${[...ancestors].map(literal).join(" ")})`, "(deny file-write*)",
    `(allow file-write* ${[roots[0], roots[2]].map(subpath).join(" ")} ${literal("/dev/null")})`,
  ].join("\n");
  const settings = await readFile(join(profile, options.auth === false ? "build.env" : "npm.env"), "utf8").catch(() => "");
  const configured = parseEnv(settings);
  const registryConfig = await readFile(join(profile, "npmrc"), "utf8").catch(() => "");
  const secrets = [
    ...Object.entries(configured).filter(([key]) => /token|password|secret|auth|key/i.test(key)).map(([, value]) => value),
    ...[...registryConfig.matchAll(/(?:_authToken|_auth|_password|password)\s*=\s*([^\r\n]+)/gi)].map(match => match[1].trim()),
  ].filter((value): value is string => typeof value === "string" && value.length >= 4);
  const redact = (value: string) => secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  const canonicalHome = join(roots[0], "home");
  const env = runtimeEnvironment(toolchain, canonicalHome, {
    ...configured,
    npm_config_cache: roots[2], npm_config_userconfig: join(roots[1], options.auth === false ? "empty-user-npmrc" : "npmrc"),
    npm_config_globalconfig: join(roots[1], "empty-global-npmrc"), npm_config_audit: "false", npm_config_fund: "false",
    npm_config_update_notifier: "false", npm_config_engine_strict: "true", NODE_ENV: "development",
    ...(toolchain.headers ? { npm_package_config_node_gyp_nodedir: toolchain.headers } : {}),
    npm_config_install_links: "true",
    ...(developer ? { DEVELOPER_DIR: developer,
      CC: configured.CC ?? join(developer, developer.endsWith("Contents/Developer") ? "Toolchains/XcodeDefault.xctoolchain/usr/bin/clang" : "usr/bin/clang"),
      CXX: configured.CXX ?? join(developer, developer.endsWith("Contents/Developer") ? "Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++" : "usr/bin/clang++"),
    } : {}), xcrun_nocache: "1",
    ...(sdk ? { SDKROOT: configured.SDKROOT ?? sdk } : {}),
  });
  let logs = "";
  let pendingLog = "";
  const command = mac ? "/usr/bin/sandbox-exec" : toolchain.node;
  const nodeArgs = [toolchain.npm, ...args];
  const child = spawn(command, mac ? ["-p", rules, toolchain.node, ...nodeArgs] : nodeArgs, {
    cwd: await realpath(directory), env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  const emit = (value: string) => { const clean = redact(value); logs = (logs + clean).slice(-12000); options.onLog?.(clean); };
  const log = (data: Buffer) => {
    pendingLog += data.toString();
    const last = pendingLog.lastIndexOf("\n");
    if (last >= 0) { emit(pendingLog.slice(0, last + 1)); pendingLog = pendingLog.slice(last + 1); }
    if (pendingLog.length > 64_000) { emit(pendingLog); pendingLog = ""; }
  };
  child.stdout?.on("data", log); child.stderr?.on("data", log);
  try { await waitForProcess(child, options.signal, 10 * 60_000); }
  catch (error) { emit(pendingLog); pendingLog = ""; throw new Error(`npm ${args.join(" ")} failed: ${error instanceof Error ? error.message : error}\n${logs.trim()}`); }
  emit(pendingLog);
}

export function killProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const taskkill = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, timeout: 5000 }, error => {
      if (error && child.exitCode === null && child.signalCode === null) child.kill(signal);
    });
    return;
  }
  try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

export async function waitForProcess(child: ChildProcess, signal?: AbortSignal, timeout = 30_000) {
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let stopReason: unknown;
    const stop = (reason: unknown) => {
      if (stopReason) return;
      stopReason = reason;
      killProcess(child, "SIGKILL");
    };
    const abort = () => stop(signal?.reason || new Error("The process was cancelled."));
    const onError = (error: Error) => finish(stopReason ?? error);
    const onClose = (code: number | null, killed: NodeJS.Signals | null) => {
      finish(stopReason ?? (code === 0 ? undefined : new Error(killed ? `Terminated by ${killed}` : `Exit code ${code}`)));
    };
    const finish = (error?: unknown) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      child.off("error", onError); child.off("close", onClose);
      error ? reject(error) : resolve();
    };
    timer = setTimeout(() => stop(new Error("The process timed out.")), timeout);
    child.once("error", onError); child.once("close", onClose);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}
