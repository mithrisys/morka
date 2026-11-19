import type { WebContents, WebFrameMain } from "electron";
import { pageState } from "./page-state";

export function preservedUrl(next: string, current: string, previous: string) {
  const target = new URL(next);
  const location = new URL(current);
  const before = new URL(previous);
  if (location.origin === before.origin) {
    return new URL(location.pathname + location.search + location.hash, target.origin).href;
  }
  target.search = location.search;
  target.hash = location.hash;
  return target.href;
}

export class LivePreview {
  private root?: string;
  private saved?: any;
  private prepared = false;
  private confirming = false;
  private readonly restoring = new Set<WebFrameMain>();
  private queue: Promise<void> = Promise.resolve();
  private navigation?: { confirm: boolean; frame?: WebFrameMain; finish: (error?: Error) => void };

  constructor(private readonly contents: WebContents, private readonly onError: (detail: string) => void, initial?: string) {
    this.root = initial;
    contents.on("did-frame-finish-load", (_event, isMainFrame, processId, routingId) => {
      const frame = this.frame();
      if (isMainFrame || !frame || frame.processId !== processId || frame.routingId !== routingId) return;
      const navigation = this.navigation;
      // An HTTP error can finish loading while the rollback navigation is
      // already queued. Only the rollback's committed document can confirm it.
      if (this.confirming && navigation?.frame !== frame) return;
      void this.loaded(frame);
    });
    contents.on("did-fail-load", (_event, code, detail, _url, isMainFrame, processId, routingId) => {
      if (code !== -3 && this.isPreviewFrame(isMainFrame, processId, routingId)) this.navigation?.finish(Error(detail));
    });
    contents.on("did-frame-navigate", (_event, _url, code, detail, isMainFrame, processId, routingId) => {
      if (!this.navigation || !this.isPreviewFrame(isMainFrame, processId, routingId)) return;
      if (code >= 400) this.navigation.finish(Error(`The app page returned HTTP ${code} ${detail}.`));
      else this.navigation.frame = this.frame(true);
    });
  }

  private frame(includeBlank = false): WebFrameMain | undefined {
    if (this.contents.isDestroyed()) return;
    const frames = this.contents.mainFrame.frames ?? [];
    const available = frames.filter(frame => includeBlank || frame.url !== "about:blank");
    return available.find(frame => frame.name === "morka-preview") ?? available[0];
  }

  private isPreviewFrame(isMainFrame: boolean, processId: number, routingId: number) {
    const frame = this.frame(true);
    return !isMainFrame && frame?.processId === processId && frame?.routingId === routingId;
  }

  isCurrentRuntime(url: unknown, runtimeUrl?: string) {
    if (typeof url !== "string" || !runtimeUrl) return false;
    try { const origin = new URL(runtimeUrl).origin; return new URL(url).origin === origin && new URL(this.frame()?.url ?? "about:blank").origin === origin; }
    catch { return false; }
  }

  private call(frame: WebFrameMain, command: Parameters<typeof pageState>[0], value?: any) {
    return frame.executeJavaScript(`(${pageState.toString()})(${JSON.stringify(command)},${JSON.stringify(value) ?? "undefined"})`);
  }

  async prepare() {
    if (this.prepared) return;
    const frame = this.frame();
    if (!frame) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("The preview did not finish saving its state.")), 35_000);
    });
    try { this.saved = await Promise.race([this.call(frame, "capture"), timeout]); }
    finally { clearTimeout(timer); }
    this.prepared = true;
    this.contents.send("canvas:updating", true);
  }

  async resume() {
    const frame = this.frame();
    if (frame) await this.call(frame, "resume").catch(() => {});
    this.prepared = false;
    this.confirming = false;
    if (!this.contents.isDestroyed()) this.contents.send("canvas:updating", false);
  }

  async completeUpdate() {
    this.saved = undefined;
    await this.resume();
  }

  cancelUpdate() { this.navigation?.finish(Error("The app is closing.")); }

  show(url?: string, styles?: string[], options: { confirm?: boolean; recover?: boolean; clear?: boolean } = {}) {
    const update = this.queue.then(async () => {
      if (this.contents.isDestroyed()) return;
      this.confirming = Boolean(options.confirm);
      const frame = this.frame();
      if (!url) {
        // Keep the current page and its state visible while its service restarts.
        if (!frame || options.clear) {
          this.root = undefined;
          this.contents.send("canvas:update", undefined);
        }
        return;
      }
      if (frame && this.root && styles?.length) {
        const files = styles.map(path => {
          const asset = new URL(path, url);
          asset.searchParams.set("morka-update", String(Date.now()));
          return { path, url: asset.href };
        });
        await this.contents.session.clearCache();
        if (await this.call(frame, "styles", files)) {
          this.root = url;
          if (!options.confirm) await this.completeUpdate();
          return;
        }
      }
      if (frame && this.root && !options.recover) await this.prepare();
      const destination = this.saved?.url && this.root ? preservedUrl(url, this.saved.url, this.root) : url;
      this.root = url;
      const navigation = (frame || options.confirm && this.frame(true)) ? new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.navigation = undefined; reject(Error("The updated page did not finish loading; its saved state is retained.")); }, 30_000);
        this.navigation = { confirm: Boolean(options.confirm),
          finish: error => { clearTimeout(timer); this.navigation = undefined; error ? reject(error) : resolve(); } };
      }) : undefined;
      // Assigning the same URL with a hash can be a same-document navigation.
      // Force a real reload when code changed, retaining the full current route.
      if (frame && destination === frame.url) void frame.executeJavaScript("location.reload()").catch(error => this.navigation?.finish(error));
      else this.contents.send("canvas:update", destination);
      await navigation;
    }).catch(async error => {
      if (options.confirm) throw error;
      await this.resume();
      this.onError(error instanceof Error ? error.message : String(error));
    });
    this.queue = update.catch(() => {});
    return update;
  }

  private async loaded(frame: WebFrameMain) {
    if (this.restoring.has(frame)) return;
    this.restoring.add(frame);
    const navigation = this.navigation;
    try {
      await this.call(frame, "install");
      if (navigation !== this.navigation || frame !== this.frame()) return;
      if (this.saved) await this.call(frame, "restore", this.saved);
      else if (navigation?.confirm) await this.call(frame, "ready");
      if (navigation !== this.navigation || frame !== this.frame()) return;
      if (!navigation?.confirm) await this.completeUpdate();
      navigation?.finish();
    } catch (error) {
      if (navigation !== this.navigation) return;
      if (navigation) navigation.finish(error instanceof Error ? error : new Error(String(error)));
      else this.onError(error instanceof Error ? error.message : String(error));
    } finally { this.restoring.delete(frame); }
  }
}
