import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { applyFiles, digest, info, projectPath, snapshot, type Files } from "./files";
import { bundledToolchain, packageProcess, type Toolchain } from "./toolchain";

export type Artifact = { key: string; directory: string; source: Files; sourceHash: string; toolchain: Toolchain; built: boolean; configHash: string };
export type PackageOptions = { signal?: AbortSignal; updateLock?: boolean; onLog?: (text: string) => void; offline?: boolean };
const format = 5;

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

function packageJson(source: Files) {
  const bytes = source.get("package.json");
  if (!bytes) throw new Error("A managed Node app needs its own app/package.json.");
  const pkg = JSON.parse(bytes.toString());
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) throw new Error("Invalid app/package.json.");
  if (source.get(".npmrc")?.toString().match(/(?:_auth|_password|token)\s*=/i)) {
    throw new Error("Keep registry credentials in this app's private npm/npmrc profile, outside source.");
  }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const value of Object.values(pkg[section] ?? {})) {
      if (typeof value !== "string") throw new Error(`Invalid ${section} in app/package.json.`);
      if (/^(?:file:|link:)/.test(value)) {
        const path = value.replace(/^(?:file:|link:)/, "");
        if (isAbsolute(path) || !inside("/app", resolve("/app", path))) throw new Error("Local npm dependencies must be vendored inside app/.");
      }
    }
  }
  return pkg;
}

export async function writableTree(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  await chmod(root, 0o700);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await writableTree(path);
    else await chmod(path, 0o600 | ((await info(path))!.mode & 0o111));
  }
}

async function seal(root: string, boundary?: string) {
  const base = boundary ?? await realpath(root);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      if (isAbsolute(await readlink(path))) throw new Error("Installed package links must be relative so releases remain portable.");
      if (!inside(base, await realpath(path))) throw new Error("An installed package created a link outside its release.");
    } else if (entry.isDirectory()) await seal(path, base);
    else if (entry.isFile()) await chmod(path, 0o444 | ((await info(path))!.mode & 0o111));
    else throw new Error("Package artifacts may contain only regular files, directories and internal links.");
  }
  await chmod(root, 0o555);
}

export async function sealArtifactDirectory(root: string) { await seal(root); }

export class AppPackages {
  private readonly pending = new Map<string, Promise<Artifact>>();
  constructor(readonly home: string, private readonly toolchainRoot?: string) {}

  async prepare(source: Files, options: PackageOptions = {}): Promise<Artifact> {
    packageJson(source);
    const toolchain = await bundledToolchain(this.toolchainRoot);
    const configHash = await this.configurationHash();
    const request = this.key(source, toolchain, configHash);
    const existing = this.pending.get(request);
    if (existing) return existing;
    const task = this.build(new Map(source), toolchain, options, configHash).finally(() => this.pending.delete(request));
    this.pending.set(request, task);
    return task;
  }

  private async configurationHash() {
    const hash = createHash("sha256");
    for (const name of ["npmrc", "npm.env", "build.env"]) {
      const data = await readFile(join(this.home, "npm", name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return Buffer.alloc(0); throw error;
      });
      hash.update(name).update(data);
    }
    return hash.digest("hex");
  }

  async sameConfiguration(artifact: Artifact) { return artifact.configHash === await this.configurationHash(); }

  private key(source: Files, toolchain: Toolchain, configHash: string) {
    return createHash("sha256").update(JSON.stringify({ format, toolchain: toolchain.identity, source: digest(source), configHash })).digest("hex");
  }

  private async cached(source: Files, toolchain: Toolchain, configHash: string): Promise<Artifact | undefined> {
    const key = this.key(source, toolchain, configHash);
    const root = join(this.home, "releases", key);
    const marker = await readFile(join(root, "artifact.json"), "utf8").catch(() => undefined);
    if (!marker) return;
    const data = JSON.parse(marker);
    if (data.format !== format || data.key !== key || data.sourceHash !== digest(source) || data.toolchain !== toolchain.identity ||
        data.configHash !== configHash || this.key(source, toolchain, configHash) !== key) return;
    if (!(await info(join(root, "app")))?.isDirectory()) return;
    return { key, directory: join(root, "app"), source, sourceHash: data.sourceHash, toolchain, built: data.built, configHash };
  }

  async recover(key: unknown) {
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) return;
    const root = join(this.home, "releases", key);
    const marker = JSON.parse(await readFile(join(root, "artifact.json"), "utf8").catch(error => {
      if (error.code === "ENOENT") return "null";
      throw error;
    }));
    if (!marker || typeof marker.configHash !== "string") return;
    const source = await snapshot(join(root, "source"));
    const toolchain = await bundledToolchain(this.toolchainRoot);
    if (marker.toolchain !== toolchain.identity) {
      // A Node/toolchain upgrade can require rebuilding native modules. Use
      // the saved source even when the checkout contains a different edit.
      if (marker.format !== format || marker.key !== key || marker.sourceHash !== digest(source) ||
          typeof marker.toolchain !== "string" ||
          createHash("sha256").update(JSON.stringify({ format, toolchain: marker.toolchain,
            source: marker.sourceHash, configHash: marker.configHash })).digest("hex") !== key) return;
      return this.prepare(source);
    }
    return this.cached(source, toolchain, marker.configHash);
  }

  private async build(source: Files, toolchain: Toolchain, options: PackageOptions, configHash: string): Promise<Artifact> {
    options.signal?.throwIfAborted();
    const cached = await this.cached(source, toolchain, configHash);
    if (cached) return cached;
    const releases = join(this.home, "releases");
    await mkdir(releases, { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(releases, ".prepare-"));
    const directory = join(stage, "app");
    const profile = join(this.home, "npm");
    const cache = join(this.home, "cache", "npm");
    const npm = async (args: string[], auth = true) => packageProcess(toolchain, [...args, ...(options.offline ? ["--offline"] : [])], directory, profile, cache,
      { signal: options.signal, onLog: options.onLog, auth });
    try {
      await mkdir(directory);
      await applyFiles(directory, new Map(), source, options.signal);
      const pkg = packageJson(source);
      if (options.updateLock || !source.has("package-lock.json")) {
        if (!options.updateLock && !source.has("package-lock.json")) throw new Error("The app needs a committed package-lock.json. Add dependencies through its app/package.json in the chat draft.");
        options.onLog?.("Resolving the app lockfile…\n");
        await npm(["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
        source.set("package-lock.json", await readFile(join(directory, "package-lock.json")));
        const reused = await this.cached(source, toolchain, configHash);
        if (reused) return reused;
      }
      const lock = JSON.parse(source.get("package-lock.json")!.toString());
      if (lock.lockfileVersion < 2 || !lock.packages) throw new Error("Use an npm lockfile version 2 or newer.");
      for (const data of Object.values(lock.packages) as any[]) {
        if (typeof data.resolved === "string" && data.resolved.startsWith("file:") && !inside(directory, resolve(directory, data.resolved.slice(5)))) {
          throw new Error("A locked local dependency points outside app/.");
        }
      }
      options.onLog?.("Installing app dependencies in an isolated release…\n");
      await npm(["ci", "--include=dev", "--foreground-scripts", "--no-audit", "--no-fund"]);
      if (pkg.scripts?.build) { options.onLog?.("Building the app…\n"); await npm(["run", "build"], false); }
      if (pkg.scripts?.["morka:check"]) { options.onLog?.("Checking the app…\n"); await npm(["run", "morka:check"], false); }
      await npm(["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], false);
      // Build tools must not rewrite the declarations being published.
      if (!(await readFile(join(directory, "package.json"))).equals(source.get("package.json")!)) throw new Error("An app build changed package.json. Update dependency declarations explicitly in the draft.");
      await writeFile(join(directory, "package-lock.json"), source.get("package-lock.json")!);
      return await this.commit(stage, directory, source, toolchain, Boolean(pkg.scripts?.build), configHash);
    } finally {
      if (await info(stage)) { await writableTree(stage); await rm(stage, { recursive: true, force: true }); }
    }
  }

  // A pure stylesheet edit can reuse installed dependencies without executing
  // lifecycle scripts or changing the running process's immutable directory.
  async styles(active: Artifact, source: Files, paths: string[], signal?: AbortSignal): Promise<Artifact> {
    if (active.built || !await this.sameConfiguration(active) || !paths.length || paths.some(path => !path.endsWith(".css") || !source.has(path))) return this.prepare(source, { signal });
    const cached = await this.cached(source, active.toolchain, active.configHash);
    if (cached) return cached;
    const stage = await mkdtemp(join(this.home, "releases", ".styles-"));
    const directory = join(stage, "app");
    try {
      await cp(active.directory, directory, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      const oldHome = join(active.directory, "..", "home");
      if ((await info(oldHome))?.isDirectory()) await cp(oldHome, join(stage, "home"), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      await writableTree(directory);
      for (const path of paths) { signal?.throwIfAborted(); await writeFile(join(directory, projectPath(path)), source.get(path)!); }
      return await this.commit(stage, directory, source, active.toolchain, false, active.configHash);
    } finally {
      if (await info(stage)) { await writableTree(stage); await rm(stage, { recursive: true, force: true }); }
    }
  }

  private async commit(stage: string, directory: string, source: Files, toolchain: Toolchain, built: boolean, configHash: string, prebuiltFrom?: string): Promise<Artifact> {
    if (configHash !== await this.configurationHash()) throw new Error("The app's private build configuration changed during preparation. Retry the update.");
    const key = this.key(source, toolchain, configHash);
    const root = join(this.home, "releases", key);
    if (await info(join(stage, "home", "tmp"))) await rm(join(stage, "home", "tmp"), { recursive: true, force: true });
    await mkdir(join(stage, "source"));
    await applyFiles(join(stage, "source"), new Map(), source);
    await seal(join(stage, "source"));
    await seal(directory);
    if ((await info(join(stage, "home")))?.isDirectory()) await seal(join(stage, "home"));
    await writeFile(join(stage, "artifact.json"), JSON.stringify({ format, key, sourceHash: digest(source), toolchain: toolchain.identity, built, configHash, ...(prebuiltFrom ? { prebuiltFrom } : {}) }) + "\n");
    try { await rename(stage, root); }
    catch (error) { if (!(await this.cached(source, toolchain, configHash))) throw error; }
    return { key, directory: join(root, "app"), source, sourceHash: digest(source), toolchain, built, configHash };
  }

  async importPrepared(directory: string, source: Files): Promise<Artifact | undefined> {
    const toolchain = await bundledToolchain(this.toolchainRoot);
    const marker = await readFile(join(directory, "artifact.json"), "utf8").catch(() => undefined);
    if (!marker) return;
    const data = JSON.parse(marker);
    if (data.format !== format || typeof data.configHash !== "string" || data.sourceHash !== digest(source) || data.toolchain !== toolchain.identity || data.key !== this.key(source, toolchain, data.configHash)) {
      throw new Error("The packaged app release does not match its source or bundled Node runtime.");
    }
    const configHash = await this.configurationHash();
    const existing = await this.cached(source, toolchain, configHash);
    if (existing) return existing;
    const releases = join(this.home, "releases");
    await mkdir(releases, { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(releases, ".import-"));
    try {
      await cp(join(directory, "app"), join(stage, "app"), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      if ((await info(join(directory, "home")))?.isDirectory()) await cp(join(directory, "home"), join(stage, "home"), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
      return await this.commit(stage, join(stage, "app"), source, toolchain, data.built, configHash, data.key);
    } finally { if (await info(stage)) { await writableTree(stage); await rm(stage, { recursive: true, force: true }); } }
  }

  async collect(protectedKeys: string[], keep = 5) {
    const releases = join(this.home, "releases");
    const entries = await readdir(releases, { withFileTypes: true }).catch(() => []);
    const versions = (await Promise.all(entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).map(async entry => ({
      key: entry.name, time: (await info(join(releases, entry.name, "artifact.json")))?.mtimeMs ?? 0,
    })))).sort((a, b) => b.time - a.time);
    const retained = new Set([...protectedKeys, ...versions.slice(0, keep).map(entry => entry.key)]);
    for (const version of versions) if (!retained.has(version.key)) {
      const directory = join(releases, version.key);
      await writableTree(directory);
      await rm(directory, { recursive: true, force: true });
    }
  }
}
