import { BrowserWindow, session, type Session } from "electron";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkedPath } from "../project/files";
import type { PreviewScenario, PreviewStep } from "../project/preview-scenario";
import type { AgentAttachment } from "../agents/attachments";

// Reuse empty in-memory partitions; Electron owns each Session until process exit.
const idleProfiles: Session[] = [];
const origin = "https://morka-preview.invalid";
const types: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json" };

// Serve only prepared frontend assets and declared synthetic responses in an ephemeral browser session.
async function serve(directory: string, scenario: PreviewScenario, request: Request) {
  const url = new URL(request.url);
  if (url.origin !== origin) return new Response(null, { status: 403 });
  const fixture = request.method + " " + url.pathname + url.search;
  if (Object.hasOwn(scenario.responses ?? {}, fixture)) return Response.json(scenario.responses![fixture]);
  if (request.method !== "GET") return new Response(null, { status: 404 });
  if (url.pathname === "/__morka/bridge.js") {
    const fixtures = JSON.stringify(scenario.actions ?? {});
    const code = 'const fixtures=JSON.parse(' + JSON.stringify(fixtures) + ');window.morka={async runAgentAction(id){if(!Object.hasOwn(fixtures,id))throw Error("Missing preview fixture for "+id);return structuredClone(fixtures[id]);}};';
    return new Response('{' + code + '}', { headers: { "Content-Type": "text/javascript" } });
  }
  try {
    const route = new URL(scenario.route ?? "/", origin);
    const name = url.pathname === route.pathname ? scenario.entry ?? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const mime = types[extname(name)];
    if (!mime) return new Response(null, { status: 404 });
    const path = await checkedPath(directory, [scenario.publicRoot, name].filter(Boolean).join("/"));
    return new Response(new Uint8Array(await readFile(path)), { headers: { "Content-Type": mime,
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'self'; base-uri 'self'" } });
  } catch { return new Response(null, { status: 404 }); }
}

function interact(step: PreviewStep) {
  const el = document.querySelector<HTMLElement>(step.selector);
  if (!el || !el.checkVisibility({checkOpacity:true, checkVisibilityCSS:true}) || !el.getClientRects().length) return false;
  if (step.kind === "expect") return !step.text || (el.innerText ?? "").includes(step.text);
  if (el.matches(":disabled")) return false;
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const box = el.getBoundingClientRect();
  const point = { x: Math.floor(box.left + box.width / 2), y: Math.floor(box.top + box.height / 2) };
  if (!el.contains(document.elementFromPoint(point.x, point.y))) return false;
  if (step.kind === "click") return point;
  el.focus();
  if (step.kind === "fill") {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw Error("Expected a text input");
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, step.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
}

export async function reviewScenario(directory: string, scenario: PreviewScenario, signal: AbortSignal,
  inspect?: (images: AgentAttachment[], signal: AbortSignal) => Promise<void>) {
  const screenshots = await mkdtemp(join(tmpdir(), "morka-review-"));
  const images: AgentAttachment[] = [];
  try {
    for (const width of [1280, 640]) {
      signal.throwIfAborted();
      const profile = idleProfiles.pop() ?? session.fromPartition("review-" + randomUUID(), { cache: false });
      profile.protocol.handle("https", request => serve(directory, scenario, request));
      profile.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
      profile.setPermissionCheckHandler(() => false);
      profile.webRequest.onBeforeRequest((request, respond) => respond({ cancel: new URL(request.url).origin !== origin }));
      const window = new BrowserWindow({ width, height: 800, useContentSize: true, show: false, webPreferences: {
        session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true, backgroundThrottling: false,
      } });
      const contents = window.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
      const denyDownload = (event: Electron.Event) => event.preventDefault();
      profile.on("will-download", denyDownload);
      const stop = () => { if (!window.isDestroyed()) window.destroy(); };
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
      deadline.addEventListener("abort", stop, { once: true });
      async function capture(state: string) {
        if (!inspect) return;
        const name = width + "-" + state + ".png";
        const path = join(screenshots, name);
        const bytes = (await contents.capturePage()).toPNG();
        if (!bytes.length) throw Error("Could not capture the preview.");
        await writeFile(path, bytes);
        images.push({ id: randomUUID(), kind: "file", name, path, size: bytes.length, fileCount: 1,
          files: [{ name, path, size: bytes.length, mimeType: "image/png" }] });
      }
      try {
        await window.loadURL(new URL(scenario.route ?? "/", origin).href);
        await contents.executeJavaScript("Promise.resolve(window.morkaLifecycle?.ready).then(()=>document.fonts.ready).then(()=>true)");
        await capture("initial");
        for (const [i, step] of scenario.steps.entries()) {
          const until = Date.now() + 3000;
          const script = "(" + interact.toString() + ")(" + JSON.stringify(step) + ")";
          let target = await contents.executeJavaScript(script);
          while (!target) {
            if (Date.now() >= until) throw Error(width + "px, step " + (i+1) + ": " + step.kind + " " + step.selector);
            await delay(40, undefined, {signal: deadline});
            target = await contents.executeJavaScript(script);
          }
          if (step.kind === "click") {
            contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...target });
            contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...target });
          }
          if (step.kind === "key") {
            const keyCode = step.key.replace(/^Arrow/, "");
            contents.sendInputEvent({ type: "keyDown", keyCode });
            contents.sendInputEvent({ type: "keyUp", keyCode });
          }
        }
        if (await contents.executeJavaScript("document.documentElement.scrollWidth > innerWidth + 1")) throw Error("Horizontal overflow at " + width + "px.");
        await capture("result");
      } finally {
        deadline.removeEventListener("abort", stop);
        stop();
        profile.protocol.unhandle("https");
        profile.off("will-download", denyDownload);
        profile.webRequest.onBeforeRequest(null);
        await profile.clearStorageData();
        idleProfiles.push(profile);
      }
    }
    signal.throwIfAborted();
    await inspect?.(images, signal);
  } finally { await rm(screenshots, { recursive: true, force: true }); }
}
