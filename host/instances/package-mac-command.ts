import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { requireCompatibleDesktopRuntime } from "./desktop-runtimes";
import { runtimeRequirement } from "./runtime-compatibility";

async function main() {
  if (process.platform !== "darwin") throw new Error("Build the macOS package on a Mac.");
  if (process.argv.length > 3) throw new Error("Usage: npm run package:mac -- [repository]");
  const repository = resolve(process.argv[2] ?? process.cwd());
  const local = createRequire(join(repository, "package.json"));
  const requirement = runtimeRequirement(JSON.parse(await readFile(join(repository, ".morka", "release.json"), "utf8")));
  const library = join(homedir(), "Library", "Application Support", "Morka Apps");
  if (requirement.runtimeVersion !== undefined || requirement.runtimeApi !== undefined) {
    const runtime = await requireCompatibleDesktopRuntime(library, requirement);
    const bundled = createRequire(join(runtime.appDirectory, "package.json"));
    const { readRelease } = bundled("./dist/instances/repository.js") as typeof import("./repository");
    const { exportDesktopMacRelease } = bundled("./dist/instances/distribution.js") as typeof import("./distribution");
    const release = readRelease(join(repository, ".morka", "release.json"));
    console.log(await exportDesktopMacRelease(runtime, repository, { ...release, ...requirement }));
    return;
  }
  const engine = dirname(local.resolve("@morkaai/runtime/package.json"));
  const { buildMacRelease } = createRequire(join(engine, "package.json"))("./dist/instances/distribution.js") as typeof import("./distribution");
  console.log(await buildMacRelease(engine, repository, library));
}

void main().catch(error => { console.error(error.message); process.exitCode = 1; });
