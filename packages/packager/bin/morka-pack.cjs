#!/usr/bin/env node
const { createRequire } = require("node:module");
const { mkdir, writeFile } = require("node:fs/promises");
const { dirname, join, resolve } = require("node:path");

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["package:mac", "local-build", "shadow-validate", "shadow-pack"].includes(command) || args.length > 1) {
    throw new Error("Usage: morka-pack package:mac|local-build|shadow-validate|shadow-pack [repository]");
  }
  const repository = resolve(args[0] || process.cwd());
  const local = createRequire(join(repository, "package.json"));
  if (command === "local-build") {
    const { repositoryProject } = local("@morka/runtime/dist/instances/repository.js");
    const { snapshot } = local("@morka/runtime/dist/project/files.js");
    const { compileProject } = local("@morka/runtime/dist/project/project.js");
    await compileProject(await snapshot(await repositoryProject(repository)));
    const windows = process.platform === "win32";
    const extension = windows ? "cmd" : process.platform === "darwin" ? "command" : "sh";
    const output = join(repository, "dist", `run-morka.${extension}`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, windows
      ? '@echo off\r\ncd /d "%~dp0.." || exit /b 1\r\ncall npm start\r\n'
      : '#!/bin/sh\ncd "$(dirname "$0")/.." || exit 1\nexec npm start\n',
    { mode: 0o755 });
    console.log(output);
    return;
  }
  if (command !== "package:mac") {
    const { readShadowWorkspace, packShadowRepository } = local("@morka/runtime/dist/instances/shadow-repository.js");
    if (command === "shadow-pack") console.log(await packShadowRepository(repository));
    else {
      const { name } = await readShadowWorkspace(repository);
      console.log(`Valid Shadow: ${name}`);
    }
    return;
  }
  const runtime = dirname(local.resolve("@morka/runtime/package.json"));
  const { buildMacRelease } = local("@morka/runtime/dist/instances/distribution.js");
  console.log(await buildMacRelease(runtime, repository));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
