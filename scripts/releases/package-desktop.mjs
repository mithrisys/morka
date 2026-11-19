import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { desktopAssets } from "./metadata.mjs";

const require = createRequire(import.meta.url);
const { buildMacBundle, writeDesktopResources } = require("../../dist/instances/distribution.js");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const asset = desktopAssets(version)[process.platform];
const arch = process.platform === "darwin" ? "arm64" : "x64";
if (!asset || process.arch !== arch) throw new Error(`No release target for ${process.platform}-${process.arch}.`);
const output = resolve("release/downloads");
await mkdir(output, { recursive: true });
const stage = await mkdtemp(resolve("release/.desktop-"));
const kit = resolve("dist/npm");
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
try {
  const image = join(stage, "image");
  await mkdir(image);
  if (process.platform === "darwin") {
    const bundle = join(image, "Morka.app");
    await buildMacBundle(process.cwd(), bundle, kit);
    await symlink("/Applications", join(image, "Applications"));
    run("hdiutil", ["create", "-quiet", "-format", "UDZO", "-volname", "Morka", "-srcfolder", image, join(stage, asset)]);
  } else {
    const windows = process.platform === "win32";
    const app = join(image, "morka");
    const electron = dirname(require("electron"));
    await cp(electron, app, {
      recursive: true, verbatimSymlinks: true,
      filter: path => dirname(path) !== join(electron, "locales") || /^en(?:-[A-Z]+)?\.pak$/.test(basename(path)),
    });
    const resources = join(app, "resources");
    await rm(join(resources, "default_app.asar"));
    await rename(join(app, windows ? "electron.exe" : "electron"), join(app, windows ? "Morka.exe" : "morka"));
    await writeDesktopResources(process.cwd(), resources, "Morka", kit);
    if (windows) {
      const { build, Platform, Arch } = require("electron-builder");
      await build({
        targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
        prepackaged: app,
        publish: "never",
        config: {
          appId: "local.morka.desktop", productName: "Morka",
          directories: { output: stage },
          win: { icon: resolve("host/branding/morka-icon.png") },
          nsis: {
            artifactName: asset, oneClick: false, perMachine: false, allowElevation: false,
            multiLanguageInstaller: false, runAfterFinish: false,
          },
        },
      });
    } else {
      run("tar", ["-czf", join(stage, asset), "-C", image, "morka"]);
    }
  }
  await rename(join(stage, asset), join(output, asset));
  console.log(join(output, asset));
} finally {
  await rm(stage, { recursive: true, force: true });
}
