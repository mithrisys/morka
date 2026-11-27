import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { applyFiles, info, snapshot } from "../project/files";
import { bundleToolchain } from "../project/bundle-toolchain";
import { compileProject, jsonFile } from "../project/project";
import { AppPackages, sealArtifactDirectory, writableTree } from "../project/packages";
import { appIcon, appsDirectory, bundledKit, preparedRelease, readRelease, releaseFile, releaseProject, repositoryFile, repositoryProject, type AppRelease } from "./repository";
import { desktopRuntimeFile, requireCompatibleDesktopRuntime, writeDesktopRuntime, type DesktopRuntime } from "./desktop-runtimes";
import { checkStarterRuntime } from "./runtime-compatibility";

const run = promisify(execFile);

async function copyDependencies(source: string, target: string, dependencies: string[], parents = new Set<string>()) {
  const resolve = createRequire(join(source, "package.json")).resolve;
  for (const dependency of dependencies) {
    // Some npm dependencies share a name with a Node built-in, such as string_decoder.
    const locations = resolve.paths(`${dependency}/package.json`) ?? [];
    let directory: string | undefined;
    for (const location of locations) {
      const candidate = join(location, dependency);
      if ((await info(join(candidate, "package.json")))?.isFile()) {
        directory = candidate;
        break;
      }
    }
    if (!directory) throw new Error(`Install the dependencies first. Missing ${dependency}.`);
    if (parents.has(directory)) continue;
    const destination = join(target, "node_modules", dependency);
    const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    await cp(directory, destination, {
      recursive: true, dereference: true,
      filter: path => path !== join(directory!, "node_modules"),
    });
    await copyDependencies(directory, destination, Object.keys(metadata.dependencies ?? {}), new Set([...parents, directory]));
  }
}

export async function setBundleIdentity(plist: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    await run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
  }
}

export async function signBundle(bundle: string, deep = false) {
  await run("/usr/bin/codesign", [
    "--force", ...(deep ? ["--deep"] : []), "--sign", "-", "--preserve-metadata=entitlements,flags", bundle,
  ]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
}

export async function prepareMacProjectExecutable(
  executable: string, appData: string, repository: string, spec: AppRelease,
) {
  const source = resolve(executable, "../../..");
  const contents = join(source, "Contents");
  const [infoPlist, resources] = await Promise.all([
    readFile(join(contents, "Info.plist")),
    readFile(join(contents, "_CodeSignature", "CodeResources")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    }),
  ]);
  const project = createHash("sha256").update(spec.id + "\0" + repository).digest("hex").slice(0, 32);
  const revision = createHash("sha256").update(spec.name + "\0").update(infoPlist).update(resources ?? await readFile(executable))
    .digest("hex").slice(0, 24);
  const directory = join(appsDirectory(appData), "macOS", project, revision);
  const bundleName = `${spec.name}.app`;
  const destination = join(directory, bundleName);
  const binary = join("Contents", "MacOS", basename(executable));
  const result = join(destination, binary);
  if ((await info(result))?.isFile()) return result;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(directory, ".build-"));
  const bundle = join(stage, bundleName);
  try {
    await cp(source, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await setBundleIdentity(join(bundle, "Contents", "Info.plist"), {
      CFBundleName: spec.name,
      CFBundleDisplayName: spec.name,
      CFBundleIdentifier: `local.morka.project.${project}`,
    });
    await signBundle(bundle, !resources);
    try {
      await rename(bundle, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "") ||
          !(await info(result))?.isFile()) throw error;
    }
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function signNativeFiles(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await signNativeFiles(path);
    else if (entry.isFile() && (entry.name.endsWith(".node") || entry.name.endsWith(".dylib") || ((await stat(path)).mode & 0o111))) {
      const file = await open(path, "r");
      const header = Buffer.alloc(4);
      try { await file.read(header, 0, 4, 0); } finally { await file.close(); }
      if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(header.readUInt32BE())) {
        await run("/usr/bin/codesign", ["--force", "--sign", "-", "--preserve-metadata=entitlements,flags", path]);
      }
    }
  }
}

async function keepEnglishLocalizations(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter(entry => entry.isDirectory() && entry.name.endsWith(".lproj") && !/^en(?:_|\.lproj$)/.test(entry.name))
    .map(entry => rm(join(directory, entry.name), { recursive: true })));
}

export async function writeDesktopResources(engine: string, resources: string, name: string, kit: string,
  toolchain?: string, desktopName?: string) {
  const metadata = JSON.parse(await readFile(join(engine, "package.json"), "utf8"));
  const app = join(resources, "app");
  await mkdir(app);
  await writeFile(join(app, "package.json"), jsonFile({
    name: "morka",
    productName: name,
    version: metadata.version,
    main: "dist/electron/main.js",
    ...(process.platform === "linux" ? { desktopName: desktopName ?? metadata.desktopName } : {}),
  }));
  const dist = join(engine, "dist");
  await cp(dist, join(app, "dist"), { recursive: true, filter: path => ![join(dist, "npm"), join(dist, "archives"), join(dist, "toolchain")].includes(path) });
  const destination = join(app, "dist", "toolchain");
  if (toolchain) await cp(toolchain, destination, { recursive: true });
  else await bundleToolchain(destination);
  await copyDependencies(engine, app, Object.keys(metadata.dependencies ?? {}).filter(name => name !== "electron"));
  await cp(kit, join(resources, bundledKit), { recursive: true });
  await copyFile(join(engine, "LICENSE"), join(app, "LICENSE"));
}

type MacRelease = { spec: AppRelease; repository: string; packagesHome: string };

async function prepareMacRelease(resources: string, release: MacRelease, toolchain: string) {
  const project = await snapshot(await repositoryProject(release.repository));
  await compileProject(project);
  const seed = join(resources, releaseProject);
  await mkdir(seed);
  await applyFiles(seed, new Map(), project);
  await writeFile(join(resources, releaseFile), jsonFile(release.spec));
  await copyFile(repositoryFile(release.repository, "icons", appIcon), join(resources, appIcon));
  const manager = new AppPackages(release.packagesHome, toolchain);
  const prepared = await manager.prepare(project);
  const destination = join(resources, preparedRelease);
  await cp(dirname(prepared.directory), destination, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  await writableTree(destination);
  await signNativeFiles(join(destination, "app"));
  if ((await info(join(destination, "home")))?.isDirectory()) await signNativeFiles(join(destination, "home"));
  await sealArtifactDirectory(join(destination, "app"));
}

async function identifyMacBundle(contents: string, version: string, spec?: AppRelease) {
  await setBundleIdentity(join(contents, "Info.plist"), {
    CFBundleExecutable: "Morka",
    CFBundleName: spec?.name ?? "Morka",
    CFBundleDisplayName: spec?.name ?? "Morka",
    CFBundleDevelopmentRegion: "en",
    CFBundleIdentifier: spec ? `local.morka.app.${spec.id}` : `local.morka.runtime.${version}`,
    CFBundleShortVersionString: version,
    CFBundleVersion: version.split("-")[0],
    CFBundleIconFile: appIcon,
  });
}

export async function buildMacBundle(
  engine: string, bundle: string, kit: string, release?: MacRelease,
  releaseVersion?: string,
  toolchain = join(engine, "dist", "toolchain"),
) {
  if (process.platform !== "darwin") throw new Error("This release currently supports building on macOS.");
  const spec = release?.spec;
  const metadata = JSON.parse(await readFile(join(engine, "package.json"), "utf8"));
  const local = createRequire(join(engine, "package.json"));
  const electron = join(local("electron"), "../../..");
  const contents = join(bundle, "Contents");
  const resources = join(contents, "Resources");
  const app = join(resources, "app");
  const dist = join(engine, "dist");
  const name = spec?.name ?? "Morka";
  if (!spec) checkStarterRuntime(metadata.version);

  await run("/usr/bin/ditto", [electron, bundle]);
  await Promise.all([
    keepEnglishLocalizations(resources),
    keepEnglishLocalizations(join(contents, "Frameworks", "Electron Framework.framework", "Resources")),
  ]);
  await writeDesktopResources(engine, resources, name, kit, toolchain);
  if (!spec) {
    await run("/usr/bin/clang", ["-fobjc-arc", "-framework", "AppKit", "-mmacosx-version-min=12.0",
      "-arch", process.arch === "arm64" ? "arm64" : "x86_64", join(engine, "host", "instances", "project-launcher.m"),
      "-o", join(app, "dist", "instances", "MorkaProject")]);
    await writeDesktopRuntime(resources, metadata.version, "Morka");
  }
  await copyFile(join(dirname(electron), "LICENSE"), join(resources, "LICENSE.electron.txt"));
  await copyFile(join(dirname(electron), "LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html"));
  await rm(join(resources, "default_app.asar"), { force: true });
  await rename(join(contents, "MacOS", "Electron"), join(contents, "MacOS", "Morka"));
  await copyFile(join(dist, "branding", "Morka.icns"), join(resources, appIcon));
  if (release) await prepareMacRelease(resources, release, toolchain);
  await signNativeFiles(join(app, "dist", "toolchain"));
  await identifyMacBundle(contents, releaseVersion ?? metadata.version, spec);
  await signBundle(bundle, true);
}

export async function buildMacRelease(engine: string, repository: string,
  library = appsDirectory(join(homedir(), "Library", "Application Support"))) {
  if (process.platform !== "darwin") throw new Error("Build the macOS package on a Mac.");
  const spec = readRelease(repositoryFile(repository, "release.json"));
  if (spec.runtimeVersion || spec.runtimeApi) {
    const runtime = await requireCompatibleDesktopRuntime(library, spec);
    const local = createRequire(join(runtime.appDirectory, "package.json"));
    // Prepare the release using the same Morka code that will open it.
    const { exportDesktopMacRelease } = local("./dist/instances/distribution.js") as typeof import("./distribution");
    return exportDesktopMacRelease(runtime, repository, spec);
  }
  return publishMacRelease(repository, spec, async (bundle, stage, version) => {
    const toolchain = join(stage, "toolchain");
    await bundleToolchain(toolchain);
    await buildMacBundle(engine, bundle, repositoryFile(repository, "npm"),
      { spec, repository, packagesHome: join(stage, "packages") }, version, toolchain);
  });
}

export async function exportDesktopMacRelease(runtime: DesktopRuntime, repository: string, spec: AppRelease) {
  return publishMacRelease(repository, spec, async (bundle, stage, version) => {
    await run("/usr/bin/ditto", [resolve(runtime.resources, "../.."), bundle]);
    const contents = join(bundle, "Contents");
    const resources = join(contents, "Resources");
    const app = join(resources, "app");
    const manifest = join(app, "package.json");
    const metadata = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(manifest, jsonFile({ ...metadata, productName: spec.name }));
    await rm(join(resources, desktopRuntimeFile));
    await rm(join(app, "dist", "instances", "MorkaProject"));
    await prepareMacRelease(resources, { spec, repository, packagesHome: join(stage, "packages") }, join(app, "dist", "toolchain"));
    await identifyMacBundle(contents, version, spec);
    await signBundle(bundle, true);
  });
}

async function publishMacRelease(repository: string, spec: AppRelease,
  build: (bundle: string, stage: string, version: string) => Promise<void>) {
  const metadata = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  const output = join(repository, "dist");
  const destination = join(output, `${spec.name}.app`);
  await mkdir(output, { recursive: true });
  const stage = await mkdtemp(join(output, ".morka-build-"));
  const bundle = join(stage, `${spec.name}.app`);
  const previous = join(stage, "previous.app");
  let savedPrevious = false;
  let keepStage = false;
  try {
    await build(bundle, stage, metadata.version);
    if (await info(destination)) {
      const existing = readRelease(join(destination, "Contents", "Resources", releaseFile));
      if (existing.id !== spec.id) throw new Error("The build destination belongs to another app.");
      await rename(destination, previous);
      savedPrevious = true;
    }
    try {
      await rename(bundle, destination);
    } catch (error) {
      if (savedPrevious) {
        try {
          await rename(previous, destination);
        } catch (restoreError) {
          keepStage = true;
          throw new AggregateError([error, restoreError], `The previous package is still at ${previous}.`);
        }
      }
      throw error;
    }
    return destination;
  } finally {
    if (!keepStage) {
      await writableTree(stage);
      await rm(stage, { recursive: true, force: true });
    }
  }
}
