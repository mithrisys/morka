import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { buildMacBundle } = require("../dist/instances/distribution.js");
const output = join(root, "release");
await mkdir(output, { recursive: true });
const stage = await mkdtemp(join(output, ".build-"));
const stagedApp = join(stage, "Morka.app");
const finalApp = join(output, "Morka.app");
try {
  await buildMacBundle(root, stagedApp, join(root, "dist", "npm"));
  await rm(finalApp, { recursive: true, force: true });
  await rename(stagedApp, finalApp);
  console.log(finalApp);
} finally {
  await rm(stage, { recursive: true, force: true });
}
