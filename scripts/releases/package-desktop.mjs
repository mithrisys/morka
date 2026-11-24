import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { desktopAssets } from "./metadata.mjs";

const require = createRequire(import.meta.url);
const { buildMacBundle, writeDesktopResources } = require("../../dist/instances/distribution.js");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const target = `${process.platform}-${process.arch}`;
const assets = desktopAssets(version)[target];
if (!assets) throw new Error(`No release target for ${target}.`);
// Linux installers generate desktop entries and icons for users other than the builder.
if (process.platform === "linux") process.umask(0o022);
const output = resolve("release/downloads");
await mkdir(output, { recursive: true });
const stage = await mkdtemp(resolve("release/.desktop-"));
const defaultKit = resolve("dist/npm");
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });
try {
  const releaseLock = process.env.MORKA_RELEASE_PROJECT_LOCK;
  const kit = releaseLock ? join(stage, "npm") : defaultKit;
  if (releaseLock) {
    await cp(defaultKit, kit, { recursive: true });
    await cp(releaseLock, join(kit, "project-lock.json"));
  }
  const image = join(stage, "image");
  await mkdir(image);
  if (process.platform === "darwin") {
    const bundle = join(image, "Morka.app");
    await buildMacBundle(process.cwd(), bundle, kit);
    await symlink("/Applications", join(image, "Applications"));
    run("hdiutil", ["create", "-quiet", "-format", "UDZO", "-volname", "Morka", "-srcfolder", image, join(stage, assets.dmg)]);
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
    const { build, Platform, Arch } = require("electron-builder");
    if (windows) {
      await build({
        targets: Platform.WINDOWS.createTarget("nsis", Arch[process.arch]),
        prepackaged: app,
        publish: "never",
        config: {
          appId: "local.morka.desktop", productName: "Morka",
          directories: { output: stage },
          win: { icon: resolve("host/branding/morka-icon.png") },
          nsis: {
            artifactName: assets.nsis, oneClick: false, perMachine: false, allowElevation: false,
            multiLanguageInstaller: false, runAfterFinish: false,
          },
        },
      });
    } else {
      // Electron's archive may unpack with owner-only modes. System packages run as desktop users.
      run("chmod", ["-R", "a+rX,go-w", app]);
      run("tar", ["-czf", join(stage, assets.tar), "-C", image, "morka"]);
      await build({
        targets: Platform.LINUX.createTarget(["deb", "rpm"], Arch[process.arch]),
        prepackaged: app,
        publish: "never",
        config: {
          appId: "local.morka.desktop", productName: "Morka",
          directories: { output: stage },
          linux: {
            executableName: "morka", icon: join(resources, "app/dist/branding/morka-icon.png"),
            category: "Development", syncDesktopName: true,
            desktop: { entry: { Icon: "/opt/Morka/resources/app/dist/branding/morka-icon.png" } },
            maintainer: "Morka <74207454+mithrisys@users.noreply.github.com>",
          },
          deb: {
            artifactName: assets.deb,
            fpm: ["--depends", "libgbm1", "--depends", "libasound2 | libasound2t64"],
          },
          rpm: {
            artifactName: assets.rpm,
            fpm: ["--depends", "mesa-libgbm", "--depends", "alsa-lib", "--depends", "libsecret"],
          },
        },
      });
    }
  }
  for (const asset of Object.values(assets)) {
    await rename(join(stage, asset), join(output, asset));
    console.log(join(output, asset));
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
