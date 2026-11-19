// Loaded through NODE_OPTIONS in each managed app Node process, including
// servers started by npm scripts. It contains no Electron or host capabilities.
(() => {
  if (!process.env.MORKA_ACTIVE_FILE || !process.env.MORKA_PROCESS_DIR) return;
  const fs = require("node:fs") as typeof import("node:fs");
  const file = process.env.MORKA_ACTIVE_FILE;
  const directory = process.env.MORKA_PROCESS_DIR;
  const emitter = process as NodeJS.Process & { emit(event: string, ...args: unknown[]): boolean };
  let phase = "prepare";
  const isActive = () => {
    try { const active = JSON.parse(fs.readFileSync(file, "utf8")); return active.processDirectory === directory && active.owner === process.env.MORKA_OWNER; }
    catch { return false; }
  };
  const observe = () => {
    const host = Number(process.env.MORKA_HOST_PID);
    if (host > 0) { try { process.kill(host, 0); } catch { process.exit(0); } }
    const next = isActive() ? "active" : phase === "active" ? "retired" : "prepare";
    if (next === phase) return;
    phase = next; process.env.MORKA_PHASE = next;
    emitter.emit(next === "active" ? "morka:activate" : "morka:retire");
  };
  Object.defineProperty(globalThis, "morkaRuntime", { value: Object.freeze({ isActive, get phase() { return phase; } }) });
  fs.watchFile(file, { interval: 100, persistent: false }, observe);
  const timer = setInterval(observe, 1000); timer.unref();
  observe();
  process.once("exit", () => { clearInterval(timer); fs.unwatchFile(file, observe); });
})();
