import { readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { writeTextAtomically } from "../app-runtime/text-file";
import { info } from "../project/files";
import { compareRuntimeVersions, isRuntimeApi, isRuntimeVersion, legacyRuntimeApi, runtimeCompatibility,
  runtimeContract, type RuntimeContract, type RuntimeRequirement } from "./runtime-compatibility";

export const desktopRuntimeFile = "morka-runtime.json";
export const desktopProjectArgument = "--morka-project=";
export const macProjectLaunchFile = "morka-project-launch.json";
export const macUpdateConfigFile = "app-update.yml";

export type DesktopRuntime = RuntimeContract & { version: string; resources: string; executable: string; appDirectory: string };

export async function isProjectRunning(library: string, profile: string) {
  const lock = await readlink(join(library, "instances", profile, "SingletonLock")).catch(error => {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return "";
    throw error;
  });
  const pid = Number(/-(\d+)$/.exec(lock)?.[1]);
  if (!pid) return false;
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }
  return true;
}

export async function writeDesktopRuntime(resources: string, version: string, executable: string) {
  if (!isRuntimeVersion(version)) throw new Error("Invalid desktop runtime version.");
  await writeFile(join(resources, desktopRuntimeFile), JSON.stringify({
    version, executable, platform: process.platform, arch: process.arch, ...runtimeContract,
  }), { mode: 0o644 });
}

async function readJson(file: string) {
  const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
    throw error;
  });
  return text === undefined ? undefined : JSON.parse(text);
}

export async function readMacProjectLaunch(resources: string): Promise<{ repository: string; runtimeResources: string } | undefined> {
  const launch = await readJson(join(resources, macProjectLaunchFile));
  if (launch === undefined) return;
  if (typeof launch?.repository !== "string" || !isAbsolute(launch.repository) ||
      typeof launch.runtimeResources !== "string" || !isAbsolute(launch.runtimeResources)) {
    throw new Error("Invalid macOS project launch configuration.");
  }
  return launch;
}

export async function readDesktopRuntime(resources: string): Promise<DesktopRuntime | undefined> {
  const manifest = await readJson(join(resources, desktopRuntimeFile));
  if (!manifest || !isRuntimeVersion(manifest.version) || manifest.platform !== process.platform ||
      manifest.arch !== process.arch || typeof manifest.executable !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(manifest.executable) || basename(manifest.executable) !== manifest.executable) return;
  // In-place installations built before the API field use the original project contract.
  const runtimeApi = manifest.runtimeApi ?? legacyRuntimeApi;
  const supportedRuntimeApis = manifest.supportedRuntimeApis ?? [legacyRuntimeApi];
  if (!isRuntimeApi(runtimeApi) || !Array.isArray(supportedRuntimeApis) ||
      !supportedRuntimeApis.every(isRuntimeApi) || !supportedRuntimeApis.includes(runtimeApi)) return;
  const physicalResources = await realpath(resources);
  const executable = join(physicalResources, "..", ...(process.platform === "darwin" ? ["MacOS"] : []), manifest.executable);
  if (!(await info(executable))?.isFile()) return;
  const appDirectory = join(physicalResources, "app");
  const launcher = await readJson(join(appDirectory, "package.json"));
  if (launcher?.version !== manifest.version || !(await info(join(appDirectory, "dist", "toolchain", "toolchain.json")))?.isFile()) return;
  return { version: manifest.version, resources: physicalResources, executable, appDirectory, runtimeApi, supportedRuntimeApis };
}

function runtimeDirectory(library: string) { return join(library, "runtimes", `${process.platform}-${process.arch}`); }

export function activeRuntimeFile(library: string) { return join(runtimeDirectory(library), "active-executable"); }

function runtimeRegistration(library: string, version: string) {
  if (!isRuntimeVersion(version)) throw new Error("Invalid desktop runtime version.");
  return join(runtimeDirectory(library), `${version}.json`);
}

export async function findDesktopRuntime(library: string, version: string) {
  const saved = await readJson(runtimeRegistration(library, version));
  if (typeof saved?.resources !== "string" || !isAbsolute(saved.resources)) return;
  const runtime = await readDesktopRuntime(saved.resources);
  if (runtime?.version === version) return runtime;
}

export async function newestDesktopRuntime(library: string, requirement?: RuntimeRequirement) {
  const entries = await readdir(runtimeDirectory(library)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const versions = entries.filter(file => file.endsWith(".json")).map(file => file.slice(0, -5)).filter(isRuntimeVersion);
  versions.sort((left, right) => compareRuntimeVersions(right, left));
  for (const version of versions) {
    const runtime = await findDesktopRuntime(library, version);
    if (runtime && (!requirement || runtimeCompatibility(requirement, runtime) === "compatible")) return runtime;
  }
}

export async function requireCompatibleDesktopRuntime(library: string, requirement: RuntimeRequirement) {
  const runtime = await newestDesktopRuntime(library, requirement);
  if (!runtime) throw new Error("A compatible Morka runtime is required. Open the project from Morka to check compatibility or upgrade it.");
  return runtime;
}

export async function updateActiveDesktopRuntime(library: string) {
  const runtime = await newestDesktopRuntime(library);
  if (runtime) await writeTextAtomically(activeRuntimeFile(library), runtime.executable + "\n");
  return runtime;
}

export async function registerDesktopRuntime(library: string, runtime: DesktopRuntime) {
  const existing = await findDesktopRuntime(library, runtime.version);
  if (existing) return existing;
  // Register the native install in place. The registry does not contain a second bundle.
  await writeTextAtomically(runtimeRegistration(library, runtime.version), JSON.stringify({ resources: runtime.resources }));
  return runtime;
}
