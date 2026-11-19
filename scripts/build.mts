import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
const require = createRequire(import.meta.url);

await rm(output, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc")], { cwd: root, stdio: "inherit" });

if (process.platform === "darwin" && !process.argv.includes("--portable")) {
  const { bundleToolchain } = require(join(output, "project", "bundle-toolchain.js"));
  await bundleToolchain(join(output, "toolchain"));
}
