#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { existsSync, realpathSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, resolve } = require("node:path");
const { createRequire } = require("node:module");

async function main() {
  const [command = "launcher", ...args] = process.argv.slice(2);
  const installing = command === "install";
  if (!["run", "launcher", "install"].includes(command) ||
      args.length > (command === "launcher" ? 0 : 1) ||
      (installing && args.length && args[0] !== "--open")) {
    throw new Error("Usage: morka launcher | morka run [repository] | morka install [--open]");
  }
  const repository = resolve(command === "run" && args[0] || process.cwd());
  const installed = existsSync(join(__dirname, "../dist/electron/main.js"));
  const engine = resolve(__dirname, installed ? ".." : "../../..");
  const local = createRequire(join(engine, "package.json"));
  const { npmEntry } = local("./dist/project/toolchain.js");
  const env = {
    ...process.env,
    MORKA_LOCAL_NODE: realpathSync(process.execPath),
    MORKA_LOCAL_NPM: await npmEntry(process.execPath, process.env.npm_execpath),
    MORKA_NPM_REPOSITORY: command === "launcher" ? "" : repository,
    MORKA_INSTALL_APP: installing ? args.length ? "open" : "1" : "",
    MORKA_NPM_KIT: process.env.MORKA_NPM_KIT ?? (installed
      ? local("./dist/instances/repository.js").repositoryFile(repository, "npm") : join(engine, "dist", "npm")),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let executable = local("electron");
  if (command === "run" && process.platform === "darwin") {
    const { readRelease, repositoryFile } = local("./dist/instances/repository.js");
    const { prepareMacProjectExecutable } = local("./dist/instances/distribution.js");
    const root = realpathSync(repository);
    executable = await prepareMacProjectExecutable(executable, join(homedir(), "Library", "Application Support"),
      root, readRelease(repositoryFile(root, "release.json")));
  }
  const child = spawn(executable, [engine], { stdio: "inherit", env, windowsHide: true });
  const stop = () => child.kill();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code, signal) => done(code ?? (signal === "SIGTERM" ? 0 : 1)));
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
