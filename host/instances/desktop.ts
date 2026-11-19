import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { app, shell } from "electron";
import { promises as nativeFs } from "original-fs";
import { writeTextAtomically } from "../app-runtime/text-file";
import { info } from "../project/files";
import { setBundleIdentity, signBundle } from "./distribution";
import { projectIcon } from "./macos";
import { appIcon, appsDirectory, portableAppName, repositoryFile, repositoryProfileId, type AppRelease } from "./repository";

type LaunchConfig = {
  repository: string; profile: string; node: string; npm: string; electron: string; bundledNode: boolean; toolchainRevision?: string;
};

const launchFile = "morka-launch.json";
const bootstrap = `
const { join } = require("node:path");
const launch = require("./${launchFile}");
const toolchain = join(__dirname, "toolchain");
const engine = join(launch.repository, "node_modules", "@morka", "runtime");
process.env.MORKA_NPM_REPOSITORY = launch.repository;
process.env.MORKA_NPM_KIT = join(launch.repository, ".morka", "npm");
process.env.MORKA_LOCAL_NODE = launch.bundledNode ? join(toolchain, "bin", "node") : launch.node;
process.env.MORKA_LOCAL_NPM = launch.bundledNode ? join(toolchain, "npm", "bin", "npm-cli.js") : launch.npm;
process.env.MORKA_DESKTOP_TOOLCHAIN = launch.bundledNode ? toolchain : "";
delete process.env.MORKA_INSTALL_APP;
delete process.env.MORKA_INSTALL_TOOLCHAIN;
try {
  require(join(engine, "dist", "electron", "main.js"));
} catch (error) {
  const { app, dialog } = require("electron");
  dialog.showErrorBox(app.name, "The project runtime could not be opened. Run npm run install:app in " + launch.repository);
  app.exit(1);
}
`;

async function writeBootstrap(directory: string, name: string, config: LaunchConfig) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeTextAtomically(join(directory, "package.json"), JSON.stringify({ name: "morka-project", productName: name, main: "main.cjs" })),
    writeTextAtomically(join(directory, launchFile), JSON.stringify(config)),
    writeTextAtomically(join(directory, "main.cjs"), bootstrap),
  ]);
}

async function requireClosed(library: string, profile: string) {
  const lock = await readlink(join(library, "instances", profile, "SingletonLock")).catch(() => "");
  const pid = Number(/-(\d+)$/.exec(lock)?.[1]);
  if (!pid) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error("Close the project before updating its installed app.");
}

async function installMacApp(name: string, config: LaunchConfig, library: string, toolchain?: string) {
  const applications = join(app.getPath("home"), "Applications");
  const bundle = join(applications, `${name}.app`);
  const binary = join("Contents", "MacOS", basename(process.execPath));
  const appResources = join("Contents", "Resources", "app");
  const existing = await info(bundle);
  if (existing) {
    const saved = existing.isDirectory()
      ? await readFile(join(bundle, appResources, launchFile), "utf8").then(JSON.parse).catch(() => undefined)
      : undefined;
    if (saved?.profile !== config.profile || saved.repository !== config.repository) {
      throw new Error(`An app named “${name}” already exists in Applications.`);
    }
    if (JSON.stringify(saved) === JSON.stringify(config) && (await info(join(bundle, binary)))?.isFile()) return bundle;
    await requireClosed(library, config.profile);
  }

  await mkdir(applications, { recursive: true });
  const stage = await mkdtemp(join(applications, ".morka-install-"));
  const replacement = join(stage, basename(bundle));
  const backup = join(stage, "previous.app");
  let keepStage = false;
  try {
    await nativeFs.cp(resolve(process.execPath, "../../.."), replacement,
      { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const resources = join(replacement, "Contents", "Resources");
    await nativeFs.rm(join(resources, "default_app.asar"), { force: true });
    await writeBootstrap(join(replacement, appResources), name, config);
    await copyFile(repositoryFile(config.repository, "icons", appIcon), join(resources, appIcon));
    if (toolchain) {
      await cp(toolchain, join(replacement, appResources, "toolchain"),
        { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    }
    await setBundleIdentity(join(replacement, "Contents", "Info.plist"), {
      CFBundleName: name, CFBundleDisplayName: name, CFBundleIconFile: appIcon,
      CFBundleIdentifier: `local.morka.project.${config.profile}`,
    });
    await signBundle(replacement, true);
    if (existing) {
      await requireClosed(library, config.profile);
      await rename(bundle, backup);
    }
    try {
      await rename(replacement, bundle);
    } catch (error) {
      if (existing) {
        try {
          await rename(backup, bundle);
        } catch (restoreError) {
          keepStage = true;
          throw new AggregateError([error, restoreError], `The previous app is still at ${backup}.`);
        }
      }
      throw error;
    }
    return bundle;
  } finally {
    if (!keepStage) await nativeFs.rm(stage, { recursive: true, force: true });
  }
}

function iconFile(png: Buffer) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

async function writeWindowsShortcut(directory: string, name: string, args: string, cwd: string, icon: string) {
  const menu = join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Morka");
  const shortcut = join(menu, `${name}.lnk`);
  await mkdir(menu, { recursive: true });
  const existing = await info(shortcut);
  if (existing && (!existing.isFile() || shell.readShortcutLink(shortcut).args !== args)) {
    throw new Error(`A shortcut named “${name}” already exists in the Start menu.`);
  }
  const temporary = await mkdtemp(join(directory, ".shortcut-"));
  try {
    const staged = join(temporary, basename(shortcut));
    if (!shell.writeShortcutLink(staged, { target: process.execPath, args, cwd, icon, iconIndex: 0, description: name })) {
      throw new Error("Could not create the Start menu shortcut.");
    }
    if (existing) await rename(staged, shortcut);
    else await copyFile(staged, shortcut, constants.COPYFILE_EXCL);
    return shortcut;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function desktopValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function desktopArg(value: string) {
  return `"${value.replace(/["\\$`]/g, "\\$&").replace(/%/g, "%%")}"`;
}

function desktopEntry(name: string, executable: string, directory: string, icon: string) {
  const command = executable.includes("=") ? ["/bin/sh", "-c", 'exec "$@"', "morka", executable, directory]
    : [executable, directory];
  return [
    "[Desktop Entry]", "Type=Application", `Name=${desktopValue(name)}`,
    `Exec=${desktopValue(command.map(desktopArg).join(" "))}`,
    `Icon=${desktopValue(icon)}`, "Terminal=false", "",
  ].join("\n");
}

export async function installDesktopApp(repository: string, spec: AppRelease, open: boolean) {
  const name = portableAppName(spec.name);
  const home = app.getPath("home");
  const library = appsDirectory(app.getPath("appData"));
  const toolchain = process.platform === "darwin" ? process.env.MORKA_INSTALL_TOOLCHAIN : undefined;
  const node = process.env.MORKA_LOCAL_NODE;
  const npm = process.env.MORKA_LOCAL_NPM;
  if (!node || !npm || !isAbsolute(node) || !isAbsolute(npm)) throw new Error("Node.js and npm are required to install this app.");
  const config: LaunchConfig = { repository, profile: repositoryProfileId(spec, repository), node, npm,
    electron: process.versions.electron ?? "", bundledNode: Boolean(toolchain),
    toolchainRevision: toolchain ? await readFile(join(toolchain, "toolchain.json"), "utf8") : undefined };
  let entry: string;
  const executable = process.execPath;
  let args: string[] = [];
  if (process.platform === "darwin") {
    entry = await installMacApp(name, config, library, toolchain);
  } else if (process.platform === "win32" || process.platform === "linux") {
    const directory = join(library, "desktop", config.profile);
    await writeBootstrap(directory, name, config);
    const png = projectIcon(spec.iconColor).resize({ width: 256, height: 256 }).toPNG();
    const icon = join(directory, process.platform === "win32" ? "icon.ico" : "icon.png");
    await writeFile(icon, process.platform === "win32" ? iconFile(png) : png);
    args = [directory];
    if (process.platform === "win32") {
      entry = await writeWindowsShortcut(directory, name, `"${directory}"`, repository, icon);
    } else {
      const configured = process.env.XDG_DATA_HOME;
      const data = configured && isAbsolute(configured) ? configured : join(home, ".local", "share");
      entry = join(data, "applications", `local.morka.project.${config.profile}.desktop`);
      await writeTextAtomically(entry, desktopEntry(name, executable, directory, icon));
    }
  } else {
    throw new Error("App installation is available on macOS, Windows, and Linux.");
  }
  console.log(`Installed app at ${entry}`);
  if (!open) return;
  if (process.platform === "darwin") {
    // LaunchServices starts the installed bundle as its own application, as Finder does.
    await promisify(execFile)("/usr/bin/open", [entry]);
    return;
  }
  const child = spawn(executable, args, { cwd: repository, detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}
