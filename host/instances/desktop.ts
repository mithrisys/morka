import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { app, shell } from "electron";
import { promises as nativeFs } from "original-fs";
import { writeTextAtomically } from "../app-runtime/text-file";
import { info } from "../project/files";
import { bundledToolchain } from "../project/toolchain";
import { setBundleIdentity, signBundle } from "./distribution";
import { projectIcon } from "./macos";
import { appIcon, appsDirectory, portableAppName, repositoryFile, repositoryProfileId, type AppRelease } from "./repository";
import { activeRuntimeFile, desktopProjectArgument, readDesktopRuntime, registerDesktopRuntime,
  updateActiveDesktopRuntime, type DesktopRuntime } from "./desktop-runtimes";

type ProjectLaunchConfig = { repository: string; profile: string };
type LaunchConfig = ProjectLaunchConfig & {
  node: string; npm: string; electron: string; bundledNode: boolean; toolchainRevision?: string;
};
type SharedMacLaunchConfig = ProjectLaunchConfig & { host: string; activeRuntime?: string };

const launchFile = "morka-launch.json";
const macResources = join("Contents", "Resources");
const macAppResources = join(macResources, "app");
const macLauncher = "MorkaProject";
const macLauncherBinary = join("Contents", "MacOS", macLauncher);
const bootstrap = `
const { join } = require("node:path");
const launch = require("./${launchFile}");
const toolchain = join(__dirname, "toolchain");
const engine = join(launch.repository, "node_modules", "@morkaai", "runtime");
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

function macApplication(name: string) {
  return join(app.getPath("home"), "Applications", `${name}.app`);
}

function launchConfig(directory: string): Promise<(ProjectLaunchConfig & Partial<SharedMacLaunchConfig>) | undefined> {
  return readFile(join(directory, launchFile), "utf8").then(JSON.parse).catch(() => undefined);
}

function sharedMacLauncher(runtime?: DesktopRuntime) {
  return join(runtime?.appDirectory ?? app.getAppPath(), "dist", "instances", macLauncher);
}

async function usesSharedMacRuntime() {
  return process.platform === "darwin" && app.isPackaged && (await info(sharedMacLauncher()))?.isFile();
}

export async function currentDesktopRuntime() {
  if (app.isPackaged && process.resourcesPath) return readDesktopRuntime(process.resourcesPath);
}

export async function registerCurrentDesktopRuntime() {
  const runtime = await currentDesktopRuntime();
  if (!runtime) return;
  const library = appsDirectory(app.getPath("appData"));
  await registerDesktopRuntime(library, runtime);
  return updateActiveDesktopRuntime(library);
}

function runtimePin(repository: string, spec: AppRelease) {
  return join(appsDirectory(app.getPath("appData")), "desktop", repositoryProfileId(spec, repository), "runtime-version");
}

export async function projectRuntimeVersion(repository: string, spec: AppRelease) {
  return spec.runtimeVersion ?? readFile(runtimePin(repository, spec), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
}

async function installMacBundle(
  name: string, config: ProjectLaunchConfig, library: string, configDirectory: string, binary: string,
  build: (bundle: string) => Promise<void>,
) {
  const bundle = macApplication(name);
  const applications = dirname(bundle);
  const existing = await info(bundle);
  if (existing) {
    const saved = existing.isDirectory() ? await launchConfig(join(bundle, configDirectory)) : undefined;
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
    await build(replacement);
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

async function installMacApp(name: string, config: LaunchConfig, library: string, toolchain?: string) {
  const binary = join("Contents", "MacOS", basename(process.execPath));
  return installMacBundle(name, config, library, macAppResources, binary, async bundle => {
    await nativeFs.cp(resolve(process.execPath, "../../.."), bundle,
      { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const resources = join(bundle, macResources);
    await nativeFs.rm(join(resources, "default_app.asar"), { force: true });
    await writeBootstrap(join(bundle, macAppResources), name, config);
    await copyFile(repositoryFile(config.repository, "icons", appIcon), join(resources, appIcon));
    if (toolchain) {
      await cp(toolchain, join(bundle, macAppResources, "toolchain"),
        { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    }
    await setBundleIdentity(join(bundle, "Contents", "Info.plist"), {
      CFBundleName: name, CFBundleDisplayName: name, CFBundleIconFile: appIcon,
      CFBundleIdentifier: `local.morka.project.${config.profile}`,
    });
    await signBundle(bundle, true);
  });
}

async function installSharedMacProject(repository: string, spec: AppRelease, runtime?: DesktopRuntime) {
  const name = portableAppName(spec.name);
  const library = appsDirectory(app.getPath("appData"));
  const config: SharedMacLaunchConfig = {
    repository, profile: repositoryProfileId(spec, repository),
    host: resolve(runtime?.resources ?? process.resourcesPath, "../.."),
    ...(runtime ? { activeRuntime: activeRuntimeFile(library) } : {}),
  };
  const bundle = await installMacBundle(name, config, library, macResources, macLauncherBinary, async bundle => {
    const resources = join(bundle, macResources);
    const executable = join(bundle, macLauncherBinary);
    const plist = join(bundle, "Contents", "Info.plist");
    await Promise.all([mkdir(resources, { recursive: true }), mkdir(dirname(executable), { recursive: true })]);
    await Promise.all([
      copyFile(sharedMacLauncher(runtime), executable),
      copyFile(repositoryFile(repository, "icons", appIcon), join(resources, appIcon)),
      writeTextAtomically(join(resources, launchFile), JSON.stringify(config)),
      writeFile(plist, JSON.stringify({
        CFBundleName: name, CFBundleDisplayName: name, CFBundleIconFile: appIcon,
        CFBundleIdentifier: `local.morka.project.${config.profile}`, CFBundleExecutable: macLauncher,
        CFBundlePackageType: "APPL", CFBundleInfoDictionaryVersion: "6.0",
      })),
    ]);
    await promisify(execFile)("/usr/bin/plutil", ["-convert", "xml1", plist]);
    await signBundle(bundle);
  });
  await launchMacApp(bundle);
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

async function writeProjectIcon(directory: string, spec: AppRelease) {
  const png = projectIcon(spec.iconColor).resize({ width: 256, height: 256 }).toPNG();
  const windows = process.platform === "win32";
  const icon = join(directory, windows ? "icon.ico" : "icon.png");
  await writeFile(icon, windows ? iconFile(png) : png);
  return icon;
}

async function writeWindowsShortcut(directory: string, name: string, args: string, cwd: string, icon: string,
  target = process.execPath, previousArgs?: string) {
  const shortcut = windowsShortcutPath(name);
  await mkdir(dirname(shortcut), { recursive: true });
  const existing = await info(shortcut);
  if (existing && (!existing.isFile() || ![args, ...(previousArgs ? [previousArgs] : [])].includes(shell.readShortcutLink(shortcut).args ?? ""))) {
    throw new Error(`A shortcut named “${name}” already exists in the Start menu.`);
  }
  const temporary = await mkdtemp(join(directory, ".shortcut-"));
  try {
    const staged = join(temporary, basename(shortcut));
    if (!shell.writeShortcutLink(staged, { target, args, cwd, icon, iconIndex: 0, description: name })) {
      throw new Error("Could not create the Start menu shortcut.");
    }
    if (existing) await rename(staged, shortcut);
    else await copyFile(staged, shortcut, constants.COPYFILE_EXCL);
    return shortcut;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function windowsShortcutPath(name: string) {
  return join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Morka", `${name}.lnk`);
}

export async function launchDesktopApp(args: string[], cwd: string, executable = process.execPath) {
  const child = spawn(executable, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

function windowsRuntimeShortcut(library: string, argument: string) {
  // Pass literal paths as PowerShell data. The shortcut never evaluates the project's path as code.
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const script = `$runtime = Get-Content -LiteralPath ${literal(activeRuntimeFile(library))} -Encoding UTF8 -ErrorAction SilentlyContinue\n` +
    `if ($runtime -and (Test-Path -LiteralPath $runtime -PathType Leaf)) { & $runtime ${literal(argument)} } else {\n` +
    `Add-Type -AssemblyName PresentationFramework\n` +
    `[void][System.Windows.MessageBox]::Show('Open Morka once, then try opening the project again.', 'Morka')\n}`;
  return {
    target: join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`,
  };
}

async function installWindowsProject(repository: string, spec: AppRelease, runtime?: DesktopRuntime) {
  const name = portableAppName(spec.name);
  const library = appsDirectory(app.getPath("appData"));
  const directory = join(library, "desktop", repositoryProfileId(spec, repository));
  await mkdir(directory, { recursive: true });
  const icon = await writeProjectIcon(directory, spec);
  const argument = desktopProjectArgument + repository;
  const cwd = runtime?.appDirectory ?? app.getAppPath();
  const shortcut = runtime ? windowsRuntimeShortcut(library, argument) : { target: process.execPath, args: `"${argument}"` };
  await writeWindowsShortcut(directory, name, shortcut.args, runtime ? directory : cwd, icon, shortcut.target, `"${argument}"`);
  await launchDesktopApp([argument], cwd, runtime?.executable);
}

function desktopValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function desktopArg(value: string) {
  return `"${value.replace(/["\\$`]/g, "\\$&").replace(/%/g, "%%")}"`;
}

function desktopEntry(name: string, executable: string, directory: string, icon: string, runtimeFile?: string) {
  const command = runtimeFile ? ["/bin/sh", "-c", 'runtime=$(cat -- "$1") && exec "$runtime" "$2"', "morka", runtimeFile, directory]
    : executable.includes("=") ? ["/bin/sh", "-c", 'exec "$@"', "morka", executable, directory]
    : [executable, directory];
  return [
    "[Desktop Entry]", "Type=Application", `Name=${desktopValue(name)}`,
    `Exec=${desktopValue(command.map(desktopArg).join(" "))}`,
    `Icon=${desktopValue(icon)}`, "Terminal=false", "",
  ].join("\n");
}

function linuxShortcutPath(profile: string) {
  const configured = process.env.XDG_DATA_HOME;
  const data = configured && isAbsolute(configured) ? configured : join(app.getPath("home"), ".local", "share");
  return join(data, "applications", `local.morka.project.${profile}.desktop`);
}

async function writeLinuxShortcut(name: string, profile: string, argument: string, icon: string, runtimeFile?: string) {
  const entry = linuxShortcutPath(profile);
  await writeTextAtomically(entry, desktopEntry(name, process.execPath, argument, icon, runtimeFile));
  return entry;
}

async function launchMacApp(entry: string) {
  // LaunchServices starts the installed bundle as its own application, as Finder does.
  await promisify(execFile)("/usr/bin/open", [entry]);
}

export async function openInstalledProject(repository: string, spec: AppRelease) {
  const runtime = await registerCurrentDesktopRuntime();
  const executable = runtime?.executable ?? process.execPath;
  const profile = repositoryProfileId(spec, repository);
  const library = appsDirectory(app.getPath("appData"));
  const directory = join(library, "desktop", profile);
  const mac = process.platform === "darwin";
  const fromHost = app.isPackaged && !mac;
  const bundle = mac ? macApplication(spec.name) : undefined;
  if (bundle && (runtime || await usesSharedMacRuntime())) {
    const saved = await launchConfig(join(bundle, macResources));
    if (saved?.profile !== profile || saved.repository !== repository ||
        (runtime && saved.activeRuntime !== activeRuntimeFile(library)) ||
        !(await info(join(bundle, macLauncherBinary)))?.isFile()) return false;
    await launchMacApp(bundle);
    return true;
  }
  if (!fromHost) {
    const bootstrapDirectory = bundle ? join(bundle, macAppResources) : directory;
    const saved = await launchConfig(bootstrapDirectory);
    const engine = join(repository, "node_modules", "@morkaai", "runtime", "dist", "electron", "main.js");
    if (saved?.profile !== profile || saved.repository !== repository ||
        !(await info(join(bootstrapDirectory, "main.cjs")))?.isFile() || !(await info(engine))?.isFile()) return false;
  }
  if (bundle) {
    await launchMacApp(bundle);
    return true;
  }
  const argument = fromHost ? desktopProjectArgument + repository : directory;
  if (process.platform === "win32") {
    const entry = windowsShortcutPath(spec.name);
    if (!(await info(entry))?.isFile()) return false;
    const shortcut = shell.readShortcutLink(entry);
    const expected = runtime ? windowsRuntimeShortcut(library, argument) : { target: executable, args: `"${argument}"` };
    if (shortcut.args !== expected.args || shortcut.target?.toLowerCase() !== expected.target.toLowerCase()) return false;
  } else if (process.platform === "linux") {
    const entry = await readFile(linuxShortcutPath(profile), "utf8").catch(() => undefined);
    if (entry !== desktopEntry(spec.name, executable, argument, join(directory, "icon.png"), runtime && activeRuntimeFile(library))) return false;
  } else return false;
  await launchDesktopApp([argument], fromHost ? runtime?.appDirectory ?? app.getAppPath() : repository, executable);
  return true;
}

export async function installRepository(repository: string, spec: AppRelease) {
  const runtime = await registerCurrentDesktopRuntime();
  if (process.platform === "darwin" && (runtime || await usesSharedMacRuntime())) {
    return installSharedMacProject(repository, spec, runtime);
  }
  if (process.platform === "linux" && app.isPackaged) return installPackagedLinuxProject(repository, spec, runtime);
  if (process.platform === "win32" && app.isPackaged) return installWindowsProject(repository, spec, runtime);
  const toolchain = await bundledToolchain(process.env.MORKA_DESKTOP_TOOLCHAIN);
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
  try {
    await promisify(execFile)(toolchain.node, [repositoryFile(repository, "npm", "install-app.cjs"), "--open"], {
      cwd: repository, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, npm_execpath: toolchain.npm,
        [pathKey]: [dirname(toolchain.node), process.env[pathKey]].filter(Boolean).join(delimiter),
        MORKA_INSTALLER_ENGINE: resolve(__dirname, "../.."),
        MORKA_INSTALL_TOOLCHAIN: toolchain.system ? "" : toolchain.root },
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

async function installPackagedLinuxProject(repository: string, spec: AppRelease, runtime?: DesktopRuntime) {
  const name = portableAppName(spec.name);
  const library = appsDirectory(app.getPath("appData"));
  const profile = repositoryProfileId(spec, repository);
  const directory = join(library, "desktop", profile);
  await mkdir(directory, { recursive: true });
  const icon = await writeProjectIcon(directory, spec);
  const argument = desktopProjectArgument + repository;
  await writeLinuxShortcut(name, profile, argument, icon, runtime && activeRuntimeFile(library));
  await launchDesktopApp([argument], runtime?.appDirectory ?? app.getAppPath(), runtime?.executable);
}

export async function installDesktopApp(repository: string, spec: AppRelease, open: boolean) {
  const name = portableAppName(spec.name);
  const library = appsDirectory(app.getPath("appData"));
  const toolchain = process.platform === "darwin" ? process.env.MORKA_INSTALL_TOOLCHAIN : undefined;
  const node = process.env.MORKA_LOCAL_NODE;
  const npm = process.env.MORKA_LOCAL_NPM;
  if (!node || !npm || !isAbsolute(node) || !isAbsolute(npm)) throw new Error("Node.js and npm are required to install this app.");
  const config: LaunchConfig = { repository, profile: repositoryProfileId(spec, repository), node, npm,
    electron: process.versions.electron ?? "", bundledNode: Boolean(toolchain),
    toolchainRevision: toolchain ? await readFile(join(toolchain, "toolchain.json"), "utf8") : undefined };
  let entry: string;
  let args: string[] = [];
  if (process.platform === "darwin") {
    entry = await installMacApp(name, config, library, toolchain);
  } else if (process.platform === "win32" || process.platform === "linux") {
    const directory = join(library, "desktop", config.profile);
    await writeBootstrap(directory, name, config);
    const icon = await writeProjectIcon(directory, spec);
    args = [directory];
    if (process.platform === "win32") {
      entry = await writeWindowsShortcut(directory, name, `"${directory}"`, repository, icon);
    } else {
      entry = await writeLinuxShortcut(name, config.profile, directory, icon);
    }
  } else {
    throw new Error("App installation is available on macOS, Windows, and Linux.");
  }
  console.log(`Installed app at ${entry}`);
  if (!open) return;
  if (process.platform === "darwin") return launchMacApp(entry);
  await launchDesktopApp(args, repository);
}
