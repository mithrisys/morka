const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, openSync, closeSync, statSync, writeFileSync, unlinkSync } = require("node:fs");
const { isAbsolute, join, resolve } = require("node:path");

const root = resolve(__dirname, "../..");

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  return result.status === 0;
}

function lock(path) {
  try {
    return openSync(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(path, "utf8"));
    if (pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (probe) {
        if (probe.code !== "ESRCH") throw probe;
        unlinkSync(path);
        return openSync(path, "wx", 0o600);
      }
    } else if (Date.now() - statSync(path).mtimeMs > 30_000) {
      unlinkSync(path);
      return openSync(path, "wx", 0o600);
    }
    throw new Error("App installation is already in progress.");
  }
}

function install() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--open")) throw new Error("Usage: npm run install:app");
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Install Node.js 24 or newer.");
  const npm = process.env.npm_execpath;
  if (!npm || !isAbsolute(npm)) throw new Error("Run this installer with npm run install:app.");
  const runtime = "node_modules/@morkaai/runtime";
  const cli = join(root, runtime, "bin", "morka.cjs");
  const expected = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages;
  const installedLock = join(root, "node_modules", ".package-lock.json");
  let installed;
  try {
    installed = JSON.parse(readFileSync(installedLock, "utf8")).packages;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const needsInstall = !existsSync(cli) || !installed || Object.entries(expected).some(([name, pkg]) =>
    name && !pkg.optional && (installed[name]?.integrity !== pkg.integrity ||
      installed[name]?.version !== pkg.version || !existsSync(join(root, name, "package.json"))));
  if (needsInstall && !run([npm, "ci", "--include=dev", "--no-audit", "--no-fund"])) return;
  run([cli, "install", ...args]);
}

try {
  const path = join(root, ".morka", "install.lock");
  const file = lock(path);
  try {
    writeFileSync(file, String(process.pid));
    install();
  } finally {
    closeSync(file);
    unlinkSync(path);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
