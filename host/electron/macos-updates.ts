import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MacUpdater, UpdateInfo } from "electron-updater";
import { macUpdateConfigFile, isProjectRunning, type DesktopRuntime } from "../instances/desktop-runtimes";
import { compareRuntimeVersions, isRuntimeApi, isRuntimeVersion } from "../instances/runtime-compatibility";

type UpdateClient = Pick<MacUpdater, "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade" |
  "checkForUpdates" | "downloadUpdate" | "quitAndInstall" | "on" | "disableDifferentialDownload">;

function channel(version: string) { return version.match(/^[^-]+-([^.]+)/)?.[1]; }

function updateFailure(error: unknown) {
  return error instanceof Error ? error.message.split("\n")[0] : "The update failed.";
}

export function updateError(current: string, supported: number[], candidate: { version: string; supportedRuntimeApis?: unknown }) {
  if (!isRuntimeVersion(candidate.version) || compareRuntimeVersions(candidate.version, current) <= 0) {
    return "The update must be newer than this installation.";
  }
  const target = channel(candidate.version);
  if (target && target !== channel(current)) return "The update is on a different release channel.";
  const apis = candidate.supportedRuntimeApis;
  if (!Array.isArray(apis) || !apis.every(isRuntimeApi) || !supported.every(api => apis.includes(api))) {
    return "This release changes project runtime API support. Review its release notes before installing it manually.";
  }
}

export async function runningProject(library: string) {
  const profiles = await readdir(join(library, "instances"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const profile of profiles) {
    if (profile.isDirectory() && await isProjectRunning(library, profile.name)) return true;
  }
  return false;
}

export class MacUpdates {
  state: MacUpdateState = { status: "idle" };

  constructor(private readonly client: UpdateClient, private readonly version: string,
    private readonly supported: number[], private readonly notify: (state: MacUpdateState) => void) {
    client.autoDownload = false;
    client.autoInstallOnAppQuit = false;
    client.allowPrerelease = Boolean(channel(version));
    client.allowDowngrade = false;
    client.disableDifferentialDownload = true;
    client.on("error", error => { if (this.state.status === "installing") this.failed(error); });
    client.on("download-progress", progress => {
      if (this.state.status === "downloading") this.set({ ...this.state, percent: Math.round(progress.percent) });
    });
  }

  private set(state: MacUpdateState) {
    this.state = state;
    this.notify(state);
  }

  private failed(error: unknown) {
    this.set({ status: "error", detail: updateFailure(error) });
  }

  async check() {
    if (!["idle", "current", "error"].includes(this.state.status)) return;
    this.set({ status: "checking" });
    try {
      const result = await this.client.checkForUpdates();
      if (!result?.isUpdateAvailable) { this.set({ status: "current" }); return; }
      const update: UpdateInfo & { supportedRuntimeApis?: unknown } = result.updateInfo;
      const error = updateError(this.version, this.supported, update);
      if (error) throw new Error(error);
      if (update.files?.length !== 1 || update.files[0].url !== `morka-${update.version}-macOS-arm64.zip`) {
        throw new Error("The release does not contain the expected Apple Silicon update.");
      }
      this.set({ status: "available", version: update.version });
    } catch (error) { this.failed(error); }
  }

  async download() {
    if (this.state.status !== "available") return;
    const { version } = this.state;
    this.set({ status: "downloading", version });
    try {
      await this.client.downloadUpdate();
      this.set({ status: "ready", version });
    } catch (error) {
      this.set({ status: "available", version, detail: updateFailure(error) });
    }
  }

  async restart(beforeInstall: () => Promise<void>) {
    if (this.state.status !== "ready") return;
    const version = this.state.version;
    this.set({ status: "installing", version });
    try { await beforeInstall(); }
    catch (error) {
      this.set({ status: "ready", version, detail: error instanceof Error ? error.message : "The update could not start." });
      return;
    }
    try { this.client.quitAndInstall(); }
    catch (error) { this.failed(error); }
  }
}

export async function updatesForLauncher(runtime: DesktopRuntime | undefined, notify: (state: MacUpdateState) => void) {
  if (process.platform !== "darwin" || process.arch !== "arm64" || !runtime) return;
  const bundle = resolve(runtime.resources, "../..");
  try {
    await Promise.all([access(join(runtime.resources, macUpdateConfigFile)), access(bundle, constants.W_OK),
      access(dirname(bundle), constants.W_OK)]);
  } catch { return; }
  const { MacUpdater } = require("electron-updater") as typeof import("electron-updater");
  return new MacUpdates(new MacUpdater(), runtime.version, runtime.supportedRuntimeApis, notify);
}
