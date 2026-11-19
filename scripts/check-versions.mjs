import { readFileSync } from "node:fs";

function readManifest(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const { version } = readManifest("package.json");
const runtime = readManifest("packages/runtime/package.json");
const packager = readManifest("packages/packager/package.json");
const lock = readManifest("package-lock.json");

if (typeof version !== "string" || !version.trim()) {
  throw new Error("package.json must declare the shared release version.");
}

for (const [field, actual] of [
  ["packages/runtime/package.json version", runtime.version],
  ["packages/packager/package.json version", packager.version],
  ["packages/packager/package.json peerDependencies.@morka/runtime", packager.peerDependencies?.["@morka/runtime"]],
  ["package-lock.json version", lock.version],
  ['package-lock.json packages[""].version', lock.packages?.[""]?.version],
]) {
  if (actual !== version) {
    console.error(`${field} must be ${version} (found ${actual ?? "no version"}).`);
    process.exitCode = 1;
  }
}
