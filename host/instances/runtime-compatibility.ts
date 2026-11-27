// Release builds advertise only contracts their embedded runtime can execute.
export const legacyRuntimeApi = 1;
export const runtimeContract = { runtimeApi: 1, supportedRuntimeApis: [1] };
export const starterRuntime = { runtimeVersion: "0.3.0-beta.4", runtimeApi: 1 };

export type RuntimeRequirement = { runtimeVersion?: string; runtimeApi?: number };
export type RuntimeContract = { runtimeApi: number; supportedRuntimeApis: number[] };

export function isRuntimeApi(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isRuntimeVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const match = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return Boolean(match && !match[1]?.split(".").some(part => /^0\d+$/.test(part)));
}

export function runtimeRequirement(value: RuntimeRequirement): RuntimeRequirement {
  const { runtimeVersion, runtimeApi } = value;
  if (runtimeVersion !== undefined && !isRuntimeVersion(runtimeVersion)) {
    throw new Error("The minimum Morka runtime version must be a release version.");
  }
  if (runtimeApi !== undefined && !isRuntimeApi(runtimeApi)) {
    throw new Error("The Morka runtime API must be a positive integer.");
  }
  return { ...(runtimeVersion === undefined ? {} : { runtimeVersion }), ...(runtimeApi === undefined ? {} : { runtimeApi }) };
}

export function compareRuntimeVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const separator = value.indexOf("-");
    const core = separator < 0 ? value : value.slice(0, separator);
    return { core: core.split("."), prerelease: separator < 0 ? [] : value.slice(separator + 1).split(".") };
  };
  const numeric = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
  const a = parse(left), b = parse(right);
  for (const [index, part] of a.core.entries()) {
    const order = numeric(part, b.core[index]);
    if (order) return order;
  }
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (const [index, part] of a.prerelease.entries()) {
    const next = b.prerelease[index];
    if (next === undefined) return 1;
    if (part === next) continue;
    const aNumeric = /^\d+$/.test(part), bNumeric = /^\d+$/.test(next);
    if (aNumeric && bNumeric) {
      const order = numeric(part, next);
      if (order) return order;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return part < next ? -1 : 1;
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

export function runtimeCompatibility(project: RuntimeRequirement, runtime: RuntimeContract & { version: string }) {
  const api = project.runtimeApi ?? legacyRuntimeApi;
  if (project.runtimeVersion && compareRuntimeVersions(runtime.version, project.runtimeVersion) < 0) return "update";
  if (runtime.supportedRuntimeApis.includes(api)) return "compatible";
  return api < runtime.runtimeApi ? "upgrade" : "update";
}

export function checkStarterRuntime(version: string) {
  if (!isRuntimeVersion(version) || runtimeCompatibility(starterRuntime, { ...runtimeContract, version }) !== "compatible") {
    throw new Error("The bundled Morka runtime must support the starter project's minimum version and API.");
  }
}
