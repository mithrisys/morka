import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AppUpdater, UpdateInfo } from "electron-updater";
import type { DownloadUpdateOptions } from "electron-updater/out/AppUpdater";
import { desktopUpdateConfigFile, isProjectRunning, type DesktopRuntime } from "../instances/desktop-runtimes";
import { compareRuntimeVersions, isRuntimeApi, isRuntimeVersion } from "../instances/runtime-compatibility";

type UpdateClient = Pick<AppUpdater, "autoDownload" | "autoInstallOnAppQuit" | "allowPrerelease" | "allowDowngrade" |
  "checkForUpdates" | "downloadUpdate" | "quitAndInstall" | "on" | "disableDifferentialDownload" | "disableWebInstaller">;
type UpdateFormat = "zip" | "nsis" | "deb" | "rpm" | "tar";
type UpdateTarget = { arch: string; format: UpdateFormat; open?: (file: string) => Promise<void>;
  verify?: (file: string) => Promise<void> };

export async function verifyWindowsUpdate(file: string, publisher: string) {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = "$signature = Get-AuthenticodeSignature -LiteralPath $env:MORKA_UPDATE_FILE -ErrorAction Stop\n" +
    "if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -cne $env:MORKA_UPDATE_PUBLISHER) { exit 1 }";
  try {
    await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, MORKA_UPDATE_FILE: file, MORKA_UPDATE_PUBLISHER: publisher }, timeout: 20_000, windowsHide: true,
    });
  } catch { throw new Error("The Windows installer signature could not be verified for the configured publisher."); }
}

function updateAsset(version: string, { arch, format }: UpdateTarget) {
  if (format === "zip") return `morka-${version}-macOS-${arch}.zip`;
  if (format === "nsis") return `morka-${version}-Windows-${arch}-Setup.exe`;
  return `morka-${version}-Linux-${arch}.${format === "tar" ? "tar.gz" : format}`;
}

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

export class DesktopUpdates {
  state: DesktopUpdateState = { status: "idle" };
  private archive?: string;

  constructor(private readonly client: UpdateClient, private readonly version: string,
    private readonly supported: number[], private readonly notify: (state: DesktopUpdateState) => void,
    private readonly target: UpdateTarget) {
    client.autoDownload = false;
    client.autoInstallOnAppQuit = false;
    client.allowPrerelease = Boolean(channel(version));
    client.allowDowngrade = false;
    client.disableDifferentialDownload = true;
    client.disableWebInstaller = true;
    client.on("error", error => { if (this.state.status === "installing") this.failed(error); });
    client.on("download-progress", progress => {
      if (this.state.status === "downloading") this.set({ ...this.state, percent: Math.round(progress.percent) });
    });
  }

  private set(state: DesktopUpdateState) {
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
      const update: UpdateInfo & { supportedRuntimeApis?: unknown; packages?: unknown } = result.updateInfo;
      const error = updateError(this.version, this.supported, update);
      if (error) throw new Error(error);
      const expected = updateAsset(update.version, this.target);
      const files = Array.isArray(update.files) ? update.files.filter(file => file?.url === expected) : [];
      const file = files[0];
      if (files.length !== 1 || update.packages || typeof file.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512) ||
        typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size <= 0) {
        throw new Error(`The release does not contain a valid update package for this installation (${expected}).`);
      }
      // The updater reuses this result when downloading. Keep only the validated asset.
      update.files.splice(0, update.files.length, file);
      this.set({ status: "available", version: update.version });
    } catch (error) { this.failed(error); }
  }

  async download() {
    if (this.state.status !== "available") return;
    const { version } = this.state;
    this.set({ status: "downloading", version });
    try {
      const files = await this.client.downloadUpdate();
      this.archive = files?.[0];
      if (this.target.open || this.target.verify) {
        if (!this.archive) throw new Error("The update download could not be located.");
        await this.target.verify?.(this.archive);
      }
      this.set({ status: "ready", version, ...this.fileAction() });
    } catch (error) {
      this.set({ status: "available", version, detail: updateFailure(error) });
    }
  }

  async install(beforeInstall: () => Promise<void>) {
    if (this.state.status !== "ready") return;
    const version = this.state.version;
    const ready = { status: "ready", version, ...this.fileAction() } as const;
    this.set({ status: "installing", version, ...this.fileAction() });
    try {
      if (this.archive) await this.target.verify?.(this.archive);
      await beforeInstall();
    }
    catch (error) {
      this.set({ ...ready, detail: error instanceof Error ? error.message : "The update could not start." });
      return;
    }
    if (this.target.open && this.archive) {
      try {
        await this.target.open(this.archive);
        this.set(ready);
      } catch (error) { this.set({ ...ready, detail: updateFailure(error) }); }
      return;
    }
    try {
      if (this.target.format === "nsis") this.client.quitAndInstall(true, true);
      else this.client.quitAndInstall();
    }
    catch (error) { this.failed(error); }
  }

  private fileAction() {
    if (!this.target.open) return {};
    return { action: this.target.format === "tar" ? "show" : "open" } as const;
  }
}

export function desktopUpdateClient(format: UpdateFormat): AppUpdater {
  const { AppUpdater, MacUpdater, NsisUpdater, DebUpdater, RpmUpdater } = require("electron-updater") as typeof import("electron-updater");
  if (format === "zip") return new MacUpdater();
  if (format === "nsis") return new NsisUpdater();
  if (format === "deb") return new DebUpdater();
  if (format === "rpm") return new RpmUpdater();
  const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor") as typeof import("electron-updater/out/electronHttpExecutor");
  return new class extends AppUpdater {
    constructor() { super(null); }
    protected doDownloadUpdate(options: DownloadUpdateOptions) {
      const { info, provider } = options.updateInfoAndProvider;
      const [fileInfo] = provider.resolveFiles(info);
      const executor = new ElectronHttpExecutor();
      return this.executeDownload({
        fileExtension: "tar.gz", fileInfo, downloadUpdateOptions: options,
        task: (file, request) => executor.download(fileInfo.url, file, request),
        done: async event => this.dispatchUpdateDownloaded(event),
      });
    }
    quitAndInstall() { throw new Error("Extract the downloaded archive to install the update."); }
  }();
}

async function openLinuxUpdate(format: UpdateFormat, file: string) {
  const { app, shell } = require("electron") as typeof import("electron");
  if (format === "tar") { shell.showItemInFolder(file); return; }
  const error = await shell.openPath(file);
  if (error) {
    shell.showItemInFolder(file);
    throw new Error("Open the downloaded package with your system package manager to install the update.");
  }
  app.quit();
}

export async function updatesForLauncher(runtime: DesktopRuntime | undefined, notify: (state: DesktopUpdateState) => void) {
  const { platform, arch } = process;
  if (!runtime || !["x64", "arm64"].includes(arch)) return;
  const config = await readFile(join(runtime.resources, desktopUpdateConfigFile), "utf8")
    .then(text => JSON.parse(text) as { format?: UpdateFormat; publisherName?: string }).catch(() => undefined);
  if (!config) return;
  const { format, publisherName } = config;
  const make = (target: UpdateTarget, client = desktopUpdateClient(target.format)) =>
    new DesktopUpdates(client, runtime.version, runtime.supportedRuntimeApis, notify, target);
  if (platform === "darwin" && arch === "arm64") {
    const bundle = resolve(runtime.resources, "../..");
    try { await Promise.all([access(bundle, constants.W_OK), access(dirname(bundle), constants.W_OK)]); }
    catch { return; }
    return make({ arch, format: "zip" });
  }
  if (platform === "win32" && format === "nsis" && typeof publisherName === "string" && publisherName.trim()) {
    const client = desktopUpdateClient(format) as import("electron-updater").NsisUpdater;
    const verify = (file: string) => verifyWindowsUpdate(file, publisherName);
    client.verifyUpdateCodeSignature = (_publishers, file) => verify(file).then(() => null);
    return make({ arch, format, verify }, client);
  }
  if (platform === "linux" && (format === "deb" || format === "rpm" || format === "tar")) {
    return make({ arch, format, open: file => openLinuxUpdate(format, file) });
  }
}
