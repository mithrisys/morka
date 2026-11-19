import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { applyFiles, info, snapshot } from "../project/files";
import { bundleToolchain } from "../project/bundle-toolchain";
import { compileProject, jsonFile } from "../project/project";
import { AppPackages, sealArtifactDirectory, writableTree } from "../project/packages";
import { appIcon, appsDirectory, bundledKit, preparedRelease, readRelease, releaseFile, releaseProject, repositoryFile, repositoryProject, type AppRelease } from "./repository";

const run = promisify(execFile);

async function copyDependencies(source: string, target: string, dependencies: string[], parents = new Set<string>()) {
  const resolve = createRequire(join(source, "package.json")).resolve;
  for (const dependency of dependencies) {
    const locations = resolve.paths(dependency) ?? [];
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

export async function buildMacBundle(
  engine: string, bundle: string, kit: string,
  release?: { spec: AppRelease; repository: string; packagesHome: string },
  releaseVersion?: string,
  toolchain = join(engine, "dist", "toolchain"),
) {
  if (process.platform !== "darwin") throw new Error("This release currently supports building on macOS.");
  const spec = release?.spec;
  const project = release && await snapshot(await repositoryProject(release.repository));
  if (project) await compileProject(project);
  const metadata = JSON.parse(await readFile(join(engine, "package.json"), "utf8"));
  const local = createRequire(join(engine, "package.json"));
  const electron = join(local("electron"), "../../..");
  const contents = join(bundle, "Contents");
  const resources = join(contents, "Resources");
  const app = join(resources, "app");
  const name = spec?.name ?? "Morka";

  await run("/usr/bin/ditto", [electron, bundle]);
  await Promise.all([
    keepEnglishLocalizations(resources),
    keepEnglishLocalizations(join(contents, "Frameworks", "Electron Framework.framework", "Resources")),
  ]);
  await mkdir(app);
  await writeFile(join(app, "package.json"), jsonFile({
    name: "morka",
    productName: name,
    version: metadata.version,
    main: "dist/electron/main.js",
  }));
  const dist = join(engine, "dist");
  await cp(dist, join(app, "dist"), { recursive: true, filter: path => ![join(dist, "npm"), join(dist, "archives"), join(dist, "toolchain")].includes(path) });
  await cp(toolchain, join(app, "dist", "toolchain"), { recursive: true });
  await copyDependencies(engine, app, Object.keys(metadata.dependencies ?? {}).filter(name => name !== "electron"));
  await cp(kit, join(resources, bundledKit), { recursive: true });
  await rm(join(resources, "default_app.asar"), { force: true });
  await rename(join(contents, "MacOS", "Electron"), join(contents, "MacOS", "Morka"));
  await copyFile(join(dist, "branding", "Morka.icns"), join(resources, appIcon));
  if (release && project) {
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
  await signNativeFiles(join(app, "dist", "toolchain"));
  await setBundleIdentity(join(contents, "Info.plist"), {
    CFBundleExecutable: "Morka",
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleDevelopmentRegion: "en",
    CFBundleIdentifier: spec ? `local.morka.app.${spec.id}` : "local.morka",
    CFBundleShortVersionString: releaseVersion ?? metadata.version,
    CFBundleVersion: (releaseVersion ?? metadata.version).split("-")[0],
    CFBundleIconFile: appIcon,
  });
  await signBundle(bundle, true);
}

export async function buildMacRelease(engine: string, repository: string) {
  if (process.platform !== "darwin") throw new Error("Build the macOS package on a Mac.");
  const spec = readRelease(repositoryFile(repository, "release.json"));
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
    const toolchain = join(stage, "toolchain");
    await bundleToolchain(toolchain);
    await buildMacBundle(engine, bundle, repositoryFile(repository, "npm"),
      { spec, repository, packagesHome: join(stage, "packages") }, metadata.version, toolchain);
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
