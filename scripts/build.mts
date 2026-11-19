import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
const require = createRequire(import.meta.url);

await rm(output, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc")], { cwd: root, stdio: "inherit" });

for (const asset of ["renderer/index.html", "renderer/launcher.html", "renderer/launcher", "renderer/styles.css", "renderer/markdown.css", "renderer/chat-tools.css", "renderer/icons", "branding", "skills", "app-runtime/starter"]) {
  await cp(join(root, "host", asset), join(output, asset), { recursive: true });
}
await cp(join(root, "node_modules/highlight.js/styles/github.css"), join(output, "renderer/highlight.css"));
// Keep the upstream notices with libraries bundled into the renderer.
const licenses = join(output, "renderer", "licenses");
await mkdir(licenses, { recursive: true });
for (const dependency of ["dompurify", "github-slugger", "highlight.js", "marked", "marked-gfm-heading-id"]) {
  await cp(join(root, "node_modules", dependency, "LICENSE"), join(licenses, dependency + ".txt"));
}
await cp(join(root, "host/renderer/licenses/marked-footnote.txt"), join(licenses, "marked-footnote.txt"));
await build({
  entryPoints: {
    "renderer/renderer": join(root, "host/renderer/renderer.ts"),
    "app-runtime/bridge": join(root, "host/app-runtime/bridge.ts"),
  },
  outdir: output,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome140",
});
if (process.platform === "darwin" && !process.argv.includes("--portable")) {
  const { bundleToolchain } = require(join(output, "project", "bundle-toolchain.js"));
  await bundleToolchain(join(output, "toolchain"));
}
execFileSync(process.execPath, [join(root, "scripts", "npm-kit.mts")], { cwd: root, stdio: "inherit" });
