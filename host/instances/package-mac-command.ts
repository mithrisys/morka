import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isRuntimeVersion, requireDesktopRuntime } from "./desktop-runtimes";

async function main() {
  if (process.platform !== "darwin") throw new Error("Build the macOS package on a Mac.");
  if (process.argv.length > 3) throw new Error("Usage: npm run package:mac -- [repository]");
  const repository = resolve(process.argv[2] ?? process.cwd());
  const local = createRequire(join(repository, "package.json"));
  const { runtimeVersion } = JSON.parse(await readFile(join(repository, ".morka", "release.json"), "utf8"));
  const library = join(homedir(), "Library", "Application Support", "Morka Apps");
  let engine: string;
  if (runtimeVersion === undefined) {
    engine = dirname(local.resolve("@morkaai/runtime/package.json"));
  } else {
    if (!isRuntimeVersion(runtimeVersion)) throw new Error("The Morka runtime version must be an exact release version.");
    engine = (await requireDesktopRuntime(library, runtimeVersion)).appDirectory;
  }
  const { buildMacRelease } = createRequire(join(engine, "package.json"))("./dist/instances/distribution.js") as typeof import("./distribution");
  console.log(await buildMacRelease(engine, repository, library));
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
