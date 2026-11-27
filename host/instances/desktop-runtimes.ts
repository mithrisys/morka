import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { writeTextAtomically } from "../app-runtime/text-file";
import { info } from "../project/files";

export const desktopRuntimeFile = "morka-runtime.json";
export const desktopProjectArgument = "--morka-project=";

export function isRuntimeVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}

export type DesktopRuntime = { version: string; resources: string; executable: string; appDirectory: string };

export async function writeDesktopRuntime(resources: string, version: string, executable: string) {
  if (!isRuntimeVersion(version)) throw new Error("Invalid desktop runtime version.");
  await writeFile(join(resources, desktopRuntimeFile), JSON.stringify({
    version, executable, platform: process.platform, arch: process.arch,
  }), { mode: 0o644 });
}

async function readJson(file: string) {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  return text === undefined ? undefined : JSON.parse(text);
}

export async function readDesktopRuntime(resources: string): Promise<DesktopRuntime | undefined> {
  const manifest = await readJson(join(resources, desktopRuntimeFile));
  if (!manifest || !isRuntimeVersion(manifest.version) || manifest.platform !== process.platform ||
      manifest.arch !== process.arch || typeof manifest.executable !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(manifest.executable) || basename(manifest.executable) !== manifest.executable) return;
  const physicalResources = await realpath(resources);
  const executable = join(physicalResources, "..", ...(process.platform === "darwin" ? ["MacOS"] : []), manifest.executable);
  if (!(await info(executable))?.isFile()) return;
  const appDirectory = join(physicalResources, "app");
  const launcher = await readJson(join(appDirectory, "package.json"));
  if (launcher?.version !== manifest.version || !(await info(join(appDirectory, "dist", "toolchain", "toolchain.json")))?.isFile()) return;
  return { version: manifest.version, resources: physicalResources, executable, appDirectory };
}

function runtimeRegistration(library: string, version: string) {
  if (!isRuntimeVersion(version)) throw new Error("Invalid desktop runtime version.");
  return join(library, "runtimes", `${process.platform}-${process.arch}`, `${version}.json`);
}

export async function findDesktopRuntime(library: string, version: string) {
  const saved = await readJson(runtimeRegistration(library, version));
  if (typeof saved?.resources !== "string" || !isAbsolute(saved.resources)) return;
  const runtime = await readDesktopRuntime(saved.resources);
  if (runtime?.version === version) return runtime;
}

export async function requireDesktopRuntime(library: string, version: string) {
  const runtime = await findDesktopRuntime(library, version);
  if (!runtime) throw new Error(`This project requires Morka ${version}. Install that version, open it once, then try again.`);
  return runtime;
}

export async function registerDesktopRuntime(library: string, runtime: DesktopRuntime) {
  const existing = await findDesktopRuntime(library, runtime.version);
  if (existing) return existing;
  // Register the native install in place. The registry does not contain a second bundle.
  await writeTextAtomically(runtimeRegistration(library, runtime.version), JSON.stringify({ resources: runtime.resources }));
  return runtime;
}
