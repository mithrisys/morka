import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/main.js", ["main.js", "text/javascript"]],
]);
createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/health") { response.writeHead(200); response.end("ready"); return; }
  const asset = assets.get(path);
  if (!asset || !["GET", "HEAD"].includes(request.method)) { response.writeHead(404); response.end(); return; }
  try {
    const bytes = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch { response.writeHead(404); response.end(); }
}).listen(Number(process.env.PORT), process.env.HOST || "127.0.0.1");
