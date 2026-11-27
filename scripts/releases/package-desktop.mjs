import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { desktopAssets, macUpdateAssets, writeMacUpdateMetadata } from "./metadata.mjs";
import { macSigningConfig, signAndNotarizeMacUpdate } from "./macos-signing.mjs";

const require = createRequire(import.meta.url);
const { buildMacBundle, configureMacDesktopUpdates, writeDesktopResources } = require("../../dist/instances/distribution.js");
const { writeDesktopRuntime } = require("../../dist/instances/desktop-runtimes.js");
const { checkStarterRuntime, runtimeContract } = require("../../dist/instances/runtime-compatibility.js");
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const product = `Morka-${version}`;
const linuxExecutable = `morka-${version.toLowerCase()}`;
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
    const signing = macSigningConfig(process.env);
    const bundle = join(image, signing ? "Morka.app" : `${product}.app`);
    await buildMacBundle(process.cwd(), bundle, kit);
    if (signing) {
      await configureMacDesktopUpdates(process.cwd(), bundle, version, signing.buildNumber);
      await signAndNotarizeMacUpdate(bundle, signing);
      const update = macUpdateAssets(version);
      run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, join(stage, update.zip)]);
      await writeMacUpdateMetadata(stage, version, runtimeContract.supportedRuntimeApis);
      Object.assign(assets, update);
    }
    await symlink("/Applications", join(image, "Applications"));
    run("hdiutil", ["create", "-quiet", "-format", "UDZO", "-volname", "Morka", "-srcfolder", image, join(stage, assets.dmg)]);
  } else {
    checkStarterRuntime(version);
    const windows = process.platform === "win32";
    const executable = windows ? `${product}.exe` : linuxExecutable;
    const app = join(image, "morka");
    const electron = dirname(require("electron"));
    await cp(electron, app, {
      recursive: true, verbatimSymlinks: true,
      filter: path => dirname(path) !== join(electron, "locales") || /^en(?:-[A-Z]+)?\.pak$/.test(basename(path)),
    });
    const resources = join(app, "resources");
    await rm(join(resources, "default_app.asar"));
    await rename(join(app, windows ? "electron.exe" : "electron"), join(app, executable));
    await writeDesktopResources(process.cwd(), resources, "Morka", kit, undefined, `${linuxExecutable}.desktop`);
    await writeDesktopRuntime(resources, version, executable);
    const { build, Platform, Arch } = require("electron-builder");
    if (windows) {
      const { convertIcon } = require("app-builder-lib/out/util/iconConverter");
      const { editWindowsResources } = require("app-builder-lib/out/util/resEdit");
      const { icons } = await convertIcon({
        sources: [resolve("host/branding/morka-icon.png")], fallbackSources: [],
        roots: [process.cwd()], format: "ico", outDir: join(stage, ".icon-ico"),
      });
      const iconPath = icons[0]?.file;
      if (!iconPath) throw new Error("The Windows application icon could not be built.");
      // electron-builder skips executable resource editing for prepackaged apps.
      await editWindowsResources({
        file: join(app, executable), iconPath,
        versionStrings: { FileDescription: "Morka", ProductName: "Morka", OriginalFilename: executable },
        fileVersion: version, productVersion: version.split("-")[0],
      });
      await build({
        targets: Platform.WINDOWS.createTarget("nsis", Arch[process.arch]),
        prepackaged: app,
        publish: "never",
        config: {
          appId: `local.morka.desktop.${version}`, productName: product,
          directories: { output: stage },
          win: { icon: iconPath },
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
          appId: `local.morka.desktop.${version}`, productName: product,
          extraMetadata: { desktopName: `${linuxExecutable}.desktop` },
          directories: { output: stage },
          linux: {
            executableName: linuxExecutable,
            icon: join(resources, "app/dist/branding/morka-icon.png"),
            category: "Development", syncDesktopName: true,
            desktop: { entry: { Icon: `/opt/${product}/resources/app/dist/branding/morka-icon.png` } },
            maintainer: "Morka <74207454+mithrisys@users.noreply.github.com>",
          },
          deb: {
            packageName: linuxExecutable,
            artifactName: assets.deb,
            fpm: ["--depends", "libgbm1", "--depends", "libasound2 | libasound2t64"],
          },
          rpm: {
            packageName: linuxExecutable,
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
