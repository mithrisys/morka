import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const entryFile = "morka.project.json";
export type Files = Map<string, Buffer>;
export const agentConfigNames = [".codex", ".agents", ".claude", ".hermes", ".pi", ".mcp.json"];
const ignored = new Set([".git", ...agentConfigNames, ".DS_Store", "node_modules"]);

function protectedName(name: string) {
  return ignored.has(name) || name === ".env" || (name.startsWith(".env.") && name !== ".env.example") ||
    name === ".morka-data" || /\.(sqlite3?|db)(-(wal|shm|journal))?$/i.test(name);
}

export function projectPath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\\") || /[\x00-\x1f]/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === ".." || protectedName(part))) {
    throw new Error(`Invalid project path: ${String(value)}`);
  }
  return value;
}

export function info(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

export async function checkedPath(root: string, relativePath: string) {
  if ((await info(root))?.isSymbolicLink()) throw new Error("The root must be a regular directory.");
  let path = root;
  for (const part of projectPath(relativePath).split("/")) {
    path = join(path, part);
    if ((await info(path))?.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${relativePath}`);
  }
  return path;
}

export async function snapshot(root: string): Promise<Files> {
  const files: Files = new Map();
  let bytes = 0;
  async function walk(path: string, prefix: string) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (protectedName(entry.name) || entry.isSymbolicLink()) continue;
      const name = projectPath(prefix + entry.name);
      const full = join(path, entry.name);
      if (entry.isDirectory()) await walk(full, name + "/");
      if (entry.isFile()) {
        const size = (await lstat(full)).size;
        bytes += size;
        if (files.size >= 4000 || bytes > 96 * 1024 * 1024) {
          throw new Error("This project exceeds the supported draft size or file count.");
        }
        files.set(name, await readFile(full));
      }
    }
  }
  if ((await info(root))?.isDirectory()) await walk(root, "");
  return files;
}

export function digest(files: Files) {
  const hash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1)) {
    hash.update(JSON.stringify([name, bytes.length])).update(bytes);
  }
  return hash.digest("hex");
}

export function changes(before: Files, after: Files) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(name => {
      const old = before.get(name);
      const next = after.get(name);
      return !old || !next || !old.equals(next);
    })
    .sort((left, right) => Number(after.has(left)) - Number(after.has(right)));
}

export function describeChanges(before: Files, after: Files) {
  return changes(before, after).slice(0, 30).map(name => {
    const old = before.get(name);
    const next = after.get(name);
    if (!old) return `+ ${name}`;
    if (!next) return `− ${name}`;
    if (old.includes(0) || next.includes(0)) return `~ ${name}`;
    const previous = old.toString().split("\n");
    const current = next.toString().split("\n");
    let begin = 0;
    while (begin < previous.length && begin < current.length && previous[begin] === current[begin]) begin++;
    let oldEnd = previous.length;
    let nextEnd = current.length;
    while (oldEnd > begin && nextEnd > begin && previous[oldEnd - 1] === current[nextEnd - 1]) {
      oldEnd--;
      nextEnd--;
    }
    const removed = previous.slice(begin, Math.min(oldEnd, begin + 4)).map(line => "− " + line.slice(0, 180));
    const added = current.slice(begin, Math.min(nextEnd, begin + 4)).map(line => "+ " + line.slice(0, 180));
    return [`~ ${name} · ${begin + 1}`, ...removed, ...added].join("\n");
  }).join("\n\n").slice(0, 5000);
}

async function write(root: string, name: string, data: Buffer | undefined) {
  const path = await checkedPath(root, name);
  if (data === undefined) {
    await rm(path, { force: true });
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  const previous = await info(path);
  try {
    await writeFile(temporary, data, { flag: "wx", mode: previous?.mode ?? 0o600, flush: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function applyFiles(root: string, before: Files, after: Files, signal?: AbortSignal) {
  const paths = changes(before, after);
  for (const name of paths) {
    const path = await checkedPath(root, name);
    const live = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    const expected = before.get(name);
    if (live ? !expected?.equals(live) : expected !== undefined) {
      throw new Error(`Project file changed during the turn: ${name}`);
    }
  }
  signal?.throwIfAborted();
  const written: string[] = [];
  try {
    for (const name of paths) {
      await write(root, name, after.get(name));
      written.push(name);
    }
  } catch (error) {
    for (const name of written.reverse()) await write(root, name, before.get(name)).catch(console.error);
    throw error;
  }
  return paths;
}

export function sourceContext(files: Files, preferred: string[]) {
  const output: Record<string, string> = Object.create(null);
  let left = 150_000;
  for (const name of new Set([entryFile, ...preferred, ...files.keys()])) {
    const bytes = files.get(name);
    if (!bytes || bytes.includes(0) || bytes.length > left) continue;
    const text = bytes.toString("utf8");
    if (text.includes("\ufffd")) continue;
    output[name] = text;
    left -= bytes.length;
  }
  return output;
}
