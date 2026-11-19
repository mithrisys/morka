import { spawn, type ChildProcess } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, readdir, readlink, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { writeTextAtomically } from "../app-runtime/text-file";
import { AppPackages, type Artifact, type PackageOptions } from "./packages";
import { AppProxy } from "./app-proxy";
import { killProcess, runtimeEnvironment, waitForProcess } from "./toolchain";
import { info, type Files } from "./files";
import type { Runtime } from "./project";

type Generation = { artifact: Artifact; processDirectory: string; spec: Runtime; child: ChildProcess;
  target: string; alive: boolean; complete: Promise<void>; logs: string };
type Activation = {
  beforeActivate: () => Promise<void>;
  activate: (url: string, styles?: string[]) => Promise<void>;
  rollback?: () => Promise<void>;
  publish?: () => Promise<() => Promise<void>>;
};
type UpdateOptions = { signal?: AbortSignal; onLog?: (text: string) => void; prepared?: Artifact };

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate an app service port.");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function seedHome(source: string, destination: string) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "tmp") continue;
    const from = join(source, entry.name), to = join(destination, entry.name);
    const exists = await info(to);
    if (entry.isDirectory()) {
      if (!exists) await mkdir(to, { mode: 0o700 });
      if (!exists || exists.isDirectory()) await seedHome(from, to);
    } else if (!exists && entry.isFile()) {
      await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(to, 0o600 | ((await info(from))!.mode & 0o111));
    } else if (!exists && entry.isSymbolicLink()) await symlink(await readlink(from), to);
  }
}

export class ManagedRuntime {
  private active?: Generation;
  private readonly shutdown = new AbortController();
  private readonly proxy: AppProxy;
  private job?: Promise<void>;
  private currentSource?: Files;
  private readonly owner = randomUUID();
  readonly packages: AppPackages;

  constructor(private readonly root: string, readonly home: string, private readonly dataDirectory: string,
    private readonly onExit: (detail: string) => void, toolchainRoot?: string, originsDirectory?: string, bridge?: string) {
    this.packages = new AppPackages(home, toolchainRoot);
    this.proxy = new AppProxy(join(home, "origin.json"), originsDirectory, bridge);
  }

  get spec() { return this.active?.spec; }
  get url() { return this.active?.alive ? this.proxy.url : undefined; }
  get sourceFiles() { return this.currentSource ? new Map(this.currentSource) : undefined; }

  private async saved() {
    const text = await readFile(join(this.home, "active.json"), "utf8").catch(error => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
    return JSON.parse(text) as { artifact?: string; previous?: string; owner?: string };
  }

  async recover(previous = false) {
    const state = await this.saved();
    return this.packages.recover(previous ? state.previous : state.artifact);
  }

  async prepare(source: Files, options: PackageOptions = {}) {
    const active = this.active;
    if (active?.alive && this.currentSource && !active.artifact.built && await this.packages.sameConfiguration(active.artifact)) {
      const changed = [...new Set([...source.keys(), ...this.currentSource.keys()])].filter(path => {
        const before = this.currentSource!.get(path), after = source.get(path);
        return !before || !after || !before.equals(after);
      });
      if (changed.length && changed.every(path => path.endsWith(".css") && source.has(path))) return this.packages.styles(active.artifact, source, changed, options.signal);
    }
    return this.packages.prepare(source, options);
  }

  async update(source: Files, spec: Runtime, callbacks: Activation, options: UpdateOptions = {}) {
    if (this.job) throw new Error("An app release is already being prepared.");
    const signal = AbortSignal.any([this.shutdown.signal, ...(options.signal ? [options.signal] : [])]);
    this.job = this.deploy(source, spec, callbacks, { ...options, signal });
    try { await this.job; } finally { this.job = undefined; }
    return this.proxy.url;
  }

  private async deploy(source: Files, spec: Runtime, callbacks: Activation, options: UpdateOptions & { signal: AbortSignal }) {
    const previous = this.active;
    const changed = this.currentSource ? [...new Set([...source.keys(), ...this.currentSource.keys()])].filter(path => {
      const before = this.currentSource!.get(path), after = source.get(path);
      return !before || !after || !before.equals(after);
    }) : [];
    const sameConfig = previous ? await this.packages.sameConfiguration(previous.artifact) : false;
    if (previous?.alive && !changed.length && sameConfig && JSON.stringify(previous.spec) === JSON.stringify(spec)) {
      await callbacks.publish?.();
      return;
    }
    const stylesheetOnly = previous?.alive && sameConfig && JSON.stringify(previous.spec) === JSON.stringify(spec) && !previous.artifact.built &&
      changed.length > 0 && changed.every(path => path.endsWith(".css") && source.has(path));
    if (stylesheetOnly) {
      const artifact = await this.packages.styles(previous.artifact, source, changed, options.signal);
      options.signal.throwIfAborted();
      const hits = this.proxy.stylesheetHits;
      const restoreStyles = this.proxy.styles(new Map(changed.map(path => [path, source.get(path)!])), this.currentSource!);
      let undo: (() => Promise<void>) | undefined;
      try {
        await callbacks.activate(this.proxy.url, changed);
        if (this.proxy.stylesheetHits > hits) {
          options.signal.throwIfAborted();
          undo = await callbacks.publish?.();
          await this.record(artifact, previous.processDirectory);
          const previousKey = previous.artifact.key;
          previous.artifact = artifact; this.currentSource = new Map(source);
          await this.packages.collect([artifact.key, previousKey, basename(dirname(previous.processDirectory))]).catch(() => {});
          return;
        }
      } catch (error) {
        restoreStyles();
        await this.restoreFailedActivation(error, callbacks, undo);
      }
      restoreStyles();
    }
    const artifact = options.prepared ?? await this.packages.prepare(source, { signal: options.signal, onLog: options.onLog });
    await this.proxy.start(Number(new URL(spec.url).port) || 0);
    const candidate = await this.launch(artifact, spec, options.signal);
    let committed = false;
    let restoreRoute: (() => void) | undefined;
    let undo: (() => Promise<void>) | undefined;
    try {
      await this.ready(candidate, options.signal);
      options.signal.throwIfAborted();
      await callbacks.beforeActivate();
      this.proxy.hold();
      await this.proxy.drained(previous?.target, true, options.signal);
      restoreRoute = this.proxy.route(candidate.target, true);
      await callbacks.activate(this.proxy.url);
      this.proxy.hold();
      if (!options.prepared) await this.migrate(candidate, options.signal);
      await this.ready(candidate, options.signal);
      options.signal.throwIfAborted();
      undo = await callbacks.publish?.();
      await this.record(artifact, artifact.directory);
      this.active = candidate; this.currentSource = new Map(source);
      this.proxy.confirmPreview();
      committed = true;
    } catch (error) {
      if (restoreRoute) {
        restoreRoute();
        await this.restoreFailedActivation(error, callbacks, undo);
      }
      throw error;
    } finally {
      this.proxy.release();
      if (!committed) await this.stopGeneration(candidate);
      else if (previous) {
        // Mutating requests drained before the switch. Finish old read streams
        // after the replacement page is restored, then retire only old code.
        await this.proxy.drained(previous.target).catch(() => {});
        await this.stopGeneration(previous);
      }
      if (committed && this.active) {
        const state = await this.saved().catch(() => ({ previous: undefined }));
        await this.packages.collect([this.active.artifact.key, basename(dirname(this.active.processDirectory)),
          ...(state.previous ? [state.previous] : [])]).catch(() => {});
      }
    }
  }

  private async restoreFailedActivation(error: unknown, callbacks: Activation, undo?: () => Promise<void>): Promise<never> {
    const repairs = await Promise.allSettled([undo?.(), callbacks.rollback?.()]);
    const failed = repairs.find(result => result.status === "rejected");
    if (failed) throw new Error(`${error instanceof Error ? error.message : error}\nRecovery also reported: ${failed.reason}`, { cause: error });
    throw error;
  }

  private async environment(artifact: Artifact, extra: NodeJS.ProcessEnv = {}) {
    const profile = join(this.home, "process-home");
    await mkdir(join(profile, "tmp"), { recursive: true, mode: 0o700 });
    const preparedHome = join(artifact.directory, "..", "home");
    if ((await info(preparedHome))?.isDirectory()) {
      // Installation-created caches/assets travel with the release. Hydrate
      // missing files only; never replace existing app settings or user files.
      await seedHome(preparedHome, profile);
    }
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const envFile = join(this.root, ".env");
    const appEnv = (await info(envFile))?.isFile() ? parseEnv(await readFile(envFile, "utf8")) : {};
    return runtimeEnvironment(artifact.toolchain, profile, { ...appEnv, NODE_ENV: "production",
      npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false",
      MORKA_DATA_DIR: this.dataDirectory, MORKA_APP_ORIGIN: this.proxy.url, ...extra });
  }

  private async launch(artifact: Artifact, spec: Runtime, signal: AbortSignal): Promise<Generation> {
    signal.throwIfAborted();
    const pkg = JSON.parse(await readFile(join(artifact.directory, "package.json"), "utf8"));
    if (typeof pkg.scripts?.[spec.script] !== "string") throw new Error(`The app needs an npm script named “${spec.script}”.`);
    const port = await freePort();
    const child = spawn(artifact.toolchain.node, [artifact.toolchain.npm, "run", spec.script], {
      cwd: artifact.directory, env: await this.environment(artifact, { HOST: "127.0.0.1", PORT: String(port), MORKA_PHASE: "prepare",
        MORKA_ACTIVE_FILE: join(this.home, "active.json"), MORKA_PROCESS_DIR: artifact.directory,
        MORKA_HOST_PID: String(process.pid), MORKA_OWNER: this.owner,
        NODE_OPTIONS: `--require ${JSON.stringify(join(__dirname, "node-lifecycle.js"))}` }),
      detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const generation: Generation = { artifact, processDirectory: artifact.directory, spec, child,
      target: `http://127.0.0.1:${port}/`, alive: true, complete: Promise.resolve(), logs: "" };
    const log = (chunk: Buffer) => { generation.logs = (generation.logs + chunk.toString()).slice(-8000); };
    child.stdout?.on("data", log); child.stderr?.on("data", log);
    generation.complete = new Promise<void>(resolve => {
      const exited = () => {
        generation.alive = false;
        if (this.active === generation && !this.shutdown.signal.aborted) this.onExit(generation.logs || "The app service exited.");
        resolve();
      };
      child.once("error", error => { generation.logs += error.message; exited(); }); child.once("close", exited);
    });
    return generation;
  }

  private async ready(generation: Generation, signal: AbortSignal) {
    const health = new URL(generation.spec.ready);
    const url = new URL(health.pathname + health.search, generation.target);
    const deadline = Date.now() + 60_000;
    while (true) {
      signal.throwIfAborted();
      if (!generation.alive) throw new Error("The candidate app exited before it was ready.\n" + generation.logs);
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) }).catch(() => undefined);
      await response?.body?.cancel().catch(() => {});
      if (response?.ok && generation.alive) return;
      if (Date.now() > deadline) throw new Error("The candidate app did not become healthy; the current app was kept running.\n" + generation.logs);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async migrate(candidate: Generation, signal: AbortSignal) {
    const migration = candidate.spec.migration;
    if (!migration) return;
    const file = join(this.home, "migrations.json");
    const completed = JSON.parse(await readFile(file, "utf8").catch(() => "{}"));
    const key = migration.id;
    if (completed[key]) return;
    const child = spawn(candidate.artifact.toolchain.node, [candidate.artifact.toolchain.npm, "run", migration.script], {
      cwd: candidate.artifact.directory, env: await this.environment(candidate.artifact, { MORKA_PHASE: "migration" }),
      detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout?.on("data", chunk => { logs = (logs + chunk).slice(-8000); }); child.stderr?.on("data", chunk => { logs = (logs + chunk).slice(-8000); });
    await waitForProcess(child, signal, 5 * 60_000).catch(error => { throw new Error(`The compatible migration failed. The existing release remains active. ${error}\n${logs}`); });
    completed[key] = true;
    await writeTextAtomically(file, JSON.stringify(completed) + "\n");
  }

  private async record(artifact: Artifact, processDirectory: string) {
    const saved = await this.saved();
    const previous = saved.artifact && saved.artifact !== artifact.key ? saved.artifact : saved.previous;
    await writeTextAtomically(join(this.home, "active.json"), JSON.stringify({ version: 1,
      artifact: artifact.key, sourceHash: artifact.sourceHash, processDirectory, dataDirectory: this.dataDirectory,
      owner: this.owner, hostPid: process.pid, previous }) + "\n");
  }

  private async stopGeneration(generation: Generation) {
    if (this.active === generation) this.active = undefined;
    killProcess(generation.child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([generation.complete, new Promise<void>(resolve => { timer = setTimeout(resolve, 3000); })]);
    if (timer) clearTimeout(timer);
    killProcess(generation.child, "SIGKILL");
    await generation.complete;
  }

  async stop() {
    this.shutdown.abort(new Error("The app is closing."));
    await this.job?.catch(() => {});
    this.proxy.hold();
    if (this.active) {
      // Closing a window must not cut a write that the user already submitted.
      let drained = false;
      while (!drained) {
        try { await this.proxy.drained(this.active.target, true); drained = true; }
        catch { /* Keep waiting; the OS's explicit Force Quit remains available. */ }
      }
      const state = await this.saved().catch(() => undefined);
      if (state?.owner === this.owner) {
        await writeTextAtomically(join(this.home, "active.json"), JSON.stringify({ ...state, owner: "" }) + "\n").catch(console.error);
      }
      await this.stopGeneration(this.active);
    }
    await this.proxy.close();
  }
}
