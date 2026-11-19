import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { writeTextAtomically } from "../app-runtime/text-file";

export class AppProxy {
  private target?: string;
  private held = false;
  private checkingPreview = false;
  private waiting: (() => void)[] = [];
  private readonly requests = new Map<string, { all: number; writes: number }>();
  private assets = new Map<string, Buffer>();
  private styleRules = new Map<string, Buffer>();
  private stylesheetSources = new Map<string, Set<string>>();
  private styleHits = 0;
  private readonly sockets = new Set<Socket>();
  private origin = "";
  private readonly server = createServer((req, res) => this.receive(req, res));

  constructor(private readonly originFile: string, private readonly originsDirectory?: string, private readonly bridge?: string) {
    this.server.on("connection", socket => { this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); });
    this.server.on("upgrade", (req, client, head) => {
      if (!this.target || this.held || this.checkingPreview || (req.headers.origin && req.headers.origin !== this.origin)) { client.destroy(); return; }
      const target = new URL(this.target);
      const upstream = connect(Number(target.port), target.hostname, () => {
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` + req.rawHeaders.reduce((text, value, i) => text + value + (i % 2 ? "\r\n" : ": "), "") + "\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
      client.once("close", () => upstream.destroy()); upstream.once("close", () => client.destroy());
    });
  }

  get url() { return this.origin + "/"; }
  get stylesheetHits() { return this.styleHits; }

  async start(requestedPort = 0) {
    if (this.origin) return this.url;
    const previous = await readFile(this.originFile, "utf8").catch(() => undefined);
    const port = previous ? JSON.parse(previous).port : requestedPort;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid saved app origin port.");
    const bind = async (selected: number) => {
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(selected, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
      }).catch(error => { throw new Error(`The app's stable local address is unavailable; it was not changed to avoid losing browser storage. ${error}`); });
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("The app proxy did not open a local port.");
      return address.port;
    };
    try {
      const selected = this.originsDirectory ? await this.reserve(port, bind) : await bind(port);
      this.origin = `http://127.0.0.1:${selected}`;
      await writeTextAtomically(this.originFile, JSON.stringify({ version: 1, port: selected }) + "\n");
    } catch (error) { await this.close(); throw error; }
    return this.url;
  }

  private async reserve(port: number, bind: (port: number) => Promise<number>) {
    const directory = this.originsDirectory!;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = join(directory, "ports.lock"), file = join(directory, "ports.json");
    const deadline = Date.now() + 30_000;
    let acquired = false;
    while (!acquired) {
      try { const handle = await open(lock, "wx", 0o600); await handle.writeFile(String(process.pid)); await handle.close(); acquired = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = Number(await readFile(lock, "utf8").catch(() => "0"));
        let alive = true;
        if (owner > 0) { try { process.kill(owner, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
        const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
        if ((!alive && owner > 0) || (!owner && age > 30_000)) { await rm(lock, { force: true }); continue; }
        if (Date.now() > deadline) throw new Error("Another app is allocating its stable origin. Retry shortly.");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      const ports = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, number>;
      const key = createHash("sha256").update(this.originFile).digest("hex");
      const remembered = port || ports[key] || 0;
      const occupied = new Set(Object.entries(ports).filter(([id]) => id !== key).map(([, value]) => value));
      if (remembered && occupied.has(remembered)) throw new Error("This stable origin belongs to another app; browser storage was not reassigned.");
      for (let attempt = 0; attempt < 100; attempt++) {
        const selected = await bind(remembered);
        if (occupied.has(selected)) { await new Promise<void>(resolve => this.server.close(() => resolve())); continue; }
        ports[key] = selected;
        await writeTextAtomically(file, JSON.stringify(ports) + "\n");
        return selected;
      }
      throw new Error("No unused stable local origin could be allocated.");
    } finally { await rm(lock, { force: true }); }
  }

  private receive(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.origin && req.headers.origin !== this.origin) { res.writeHead(403); res.end("This app accepts requests from its own origin."); return; }
    if (this.held) {
      if (this.waiting.length >= 512) { res.writeHead(503); res.end("The app is updating. Retry shortly."); return; }
      this.waiting.push(() => { if (!req.destroyed && !res.destroyed) this.receive(req, res); });
      return;
    }
    const target = this.target;
    if (!target) { res.writeHead(503); res.end("The app is preparing its first release."); return; }
    const write = !["GET", "HEAD", "OPTIONS"].includes(req.method || "GET");
    if (write && this.checkingPreview) { res.writeHead(503); res.end("The updated preview is still being checked. Retry shortly."); return; }
    const path = new URL(req.url || "/", this.origin);
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(path.pathname); } catch { res.writeHead(400); res.end("Invalid app URL."); return; }
    if (path.pathname === "/__morka/bridge.js" && this.bridge && ["GET", "HEAD"].includes(req.method || "GET")) {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(req.method === "HEAD" ? undefined : this.bridge); return;
    }
    const asset = (req.method === "GET" || req.method === "HEAD") && this.assets.get(decodedPath);
    if (asset) { this.styleHits++; res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" }); res.end(req.method === "HEAD" ? undefined : asset); return; }
    const counts = this.requests.get(target) || { all: 0, writes: 0 };
    counts.all++; if (write) counts.writes++; this.requests.set(target, counts);
    let finished = false;
    const done = () => { if (finished) return; finished = true; counts.all--; if (write) counts.writes--; };
    const upstream = request(new URL(path.pathname + path.search, target), {
      method: req.method, headers: { ...req.headers, ...(this.styleRules.size ? { "accept-encoding": "identity" } : {}),
        "x-forwarded-host": new URL(this.origin).host, "x-forwarded-proto": "http" },
    }, response => {
      const headers = { ...response.headers };
      const internalOrigin = new URL(target).origin;
      if (headers.location === internalOrigin || headers.location?.startsWith(internalOrigin + "/")) headers.location = this.origin + headers.location.slice(internalOrigin.length);
      if (this.styleRules.size && response.statusCode === 200 && String(headers["content-type"]).includes("text/css")) {
        const chunks: Buffer[] = []; let length = 0, streaming = false;
        response.on("data", (chunk: Buffer) => {
          if (streaming) { res.write(chunk); return; }
          chunks.push(chunk); length += chunk.length;
          if (length > 8 * 1024 * 1024) { streaming = true; res.writeHead(200, headers); res.write(Buffer.concat(chunks)); chunks.length = 0; }
        });
        response.once("end", () => {
          if (streaming) { res.end(); return; }
          let body: Buffer = Buffer.concat(chunks);
          const hash = createHash("sha256").update(body).digest("hex");
          const matchingPaths = [...this.stylesheetSources.get(hash) ?? []].filter(source => basename(source) === basename(path.pathname));
          const rule = matchingPaths.length === 1 ? this.styleRules.get(matchingPaths[0]) : undefined;
          if (rule) {
            body = rule; this.styleHits++;
            delete headers["content-encoding"]; delete headers["content-length"]; delete headers.etag; delete headers["last-modified"];
            headers["cache-control"] = "no-store";
          }
          res.writeHead(200, headers); res.end(body);
        });
      } else { res.writeHead(response.statusCode || 502, headers); response.pipe(res); }
      response.once("end", done); response.once("error", () => { done(); res.destroy(); }); response.once("close", done);
    });
    upstream.once("error", () => { done(); if (!res.headersSent) res.writeHead(502); res.end("The app service is unavailable."); });
    req.once("aborted", () => upstream.destroy());
    req.pipe(upstream);
  }

  hold() { this.held = true; }
  private restoreStyles() {
    const { assets, styleRules, stylesheetSources } = this;
    return () => {
      this.assets = assets;
      this.styleRules = styleRules;
      this.stylesheetSources = stylesheetSources;
    };
  }

  route(target?: string, checkingPreview = false) {
    const previous = this.target;
    const restore = this.restoreStyles();
    this.target = target;
    this.checkingPreview = checkingPreview;
    this.assets = new Map(); this.styleRules = new Map(); this.stylesheetSources = new Map();
    this.release();
    return () => {
      this.target = previous;
      this.checkingPreview = false;
      restore();
      this.release();
    };
  }
  activate(target: string) { this.route(target); }
  confirmPreview() { this.checkingPreview = false; }
  styles(files: Map<string, Buffer>, previous: Map<string, Buffer>) {
    const restore = this.restoreStyles();
    this.assets = new Map(this.assets);
    this.styleRules = new Map(this.styleRules);
    this.stylesheetSources = new Map(this.stylesheetSources);
    for (const [path, bytes] of previous) if (path.endsWith(".css")) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const paths = new Set(this.stylesheetSources.get(hash));
      paths.add(path);
      this.stylesheetSources.set(hash, paths);
    }
    for (const [path, bytes] of files) {
      this.assets.set("/" + path, bytes);
      this.styleRules.set(path, bytes);
    }
    return restore;
  }
  release() { this.held = false; const waiting = this.waiting; this.waiting = []; for (const resume of waiting) resume(); }

  async drained(target?: string, writesOnly = false, signal?: AbortSignal) {
    if (!target) return;
    const deadline = Date.now() + 30_000;
    while (this.requests.get(target)?.[writesOnly ? "writes" : "all"]) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error("The app still has requests in progress. Its current release was kept running.");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async close() {
    this.target = undefined;
    this.release();
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    this.origin = "";
  }
}
