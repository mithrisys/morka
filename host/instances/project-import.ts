import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { extract } from "tar";
import { entryFile, info } from "../project/files";
import { readRelease, repositoryFile, repositoryProject } from "./repository";

type ZipEntry = { path: string; type: "Directory" | "File"; externalFileAttributes: number; stream(): Readable };
const { Open } = require("unzipper") as { Open: { file(path: string): Promise<{ files: ZipEntry[] }> } };
const run = promisify(execFile);

export const projectArchiveExtensions = ["zip", "gz", "tgz"];

async function hasProjectSource(directory: string) {
  return (await info(join(directory, "app")))?.isDirectory() &&
    (await info(repositoryFile(directory)))?.isDirectory() &&
    (await info(repositoryFile(directory, "release.json")))?.isFile();
}

export async function readProjectCheckout(directory: string) {
  const project = await repositoryProject(directory);
  const repository = dirname(project);
  if (!await hasProjectSource(repository)) throw new Error("Choose a Morka project with a .morka/release.json file.");
  return { repository, spec: readRelease(repositoryFile(repository, "release.json")) };
}

function archiveParts(path: string) {
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts[0] === "" || parts.some(part => part === ".." || /[:\p{Cc}]/u.test(part))) return;
  if (process.platform === "win32" && parts.some(part => part && part !== "." &&
      (/[<>"|?*]|[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)))) return;
  return parts.filter(part => part && part !== ".");
}

async function unpackArchive(archive: string, directory: string) {
  const invalid = "The project archive has an unsafe path or contains a special file.";
  if (/\.zip$/i.test(archive)) {
    const { files } = await Open.file(archive);
    for (const entry of files) {
      const parts = archiveParts(entry.path);
      const mode = entry.externalFileAttributes >>> 28;
      if (!parts || (mode && mode !== (entry.type === "Directory" ? 4 : 8))) throw new Error(invalid);
      const target = join(directory, ...parts);
      if (entry.type === "Directory") await mkdir(target, { recursive: true });
      else {
        if (!parts.length) throw new Error(invalid);
        await mkdir(dirname(target), { recursive: true });
        const ownerExecute = (entry.externalFileAttributes >>> 16) & 0o100;
        await pipeline(entry.stream(), createWriteStream(target, { flags: "wx", mode: 0o600 | ownerExecute }));
      }
    }
    return;
  }
  let rejected = false;
  await extract({ file: archive, cwd: directory, strict: true, preserveOwner: false, filter: (path, entry) => {
    if (archiveParts(path) && "type" in entry && ["File", "OldFile", "Directory"].includes(entry.type)) return true;
    rejected = true;
    return false;
  } });
  if (rejected) throw new Error(invalid);
}

async function archivedCheckout(directory: string) {
  if (await hasProjectSource(directory)) return directory;
  const checkouts: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "__MACOSX" || !entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    if (await hasProjectSource(child)) checkouts.push(child);
  }
  if (checkouts.length !== 1) throw new Error("The archive must contain one Morka project.");
  return checkouts[0];
}

async function importCheckout(library: string, key: string, materialize: (directory: string) => Promise<string>) {
  const projects = join(library, "projects");
  const destination = join(projects, key);
  await mkdir(projects, { recursive: true, mode: 0o700 });
  if (await info(destination)) return readProjectCheckout(destination);
  const staged = await mkdtemp(join(projects, ".import-"));
  try {
    const checkout = await materialize(staged);
    await readProjectCheckout(checkout);
    if (!(await info(join(checkout, "app", entryFile)))?.isFile()) {
      throw new Error(`The imported project needs an app/${entryFile} file.`);
    }
    try {
      await rename(checkout, destination);
    } catch (error) {
      if (!(await info(destination))?.isDirectory()) throw error;
    }
    return await readProjectCheckout(destination);
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

export async function importProjectArchive(library: string, archive: string) {
  if (!/\.(?:zip|tar\.gz|tgz)$/i.test(archive)) {
    throw new Error("Choose a ZIP, .tar.gz, or .tgz project archive.");
  }
  const hash = createHash("sha256").update("archive\0");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  return importCheckout(library, hash.digest("hex"), async directory => {
    await unpackArchive(archive, directory);
    return archivedCheckout(directory);
  });
}

function gitAddress(value: unknown) {
  const address = typeof value === "string" ? value.trim() : "";
  if (address.length <= 2048 && !/[\s\p{Cc}]/u.test(address)) {
    const url = address.includes("://") ? URL.parse(address) : null;
    if (url && ["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol) &&
        (url.hostname || url.protocol === "file:") && !url.password &&
        (!url.username || url.protocol === "ssh:")) return address;
    if (/^(?:\w[\w.-]*@)?\w[\w.-]*:(?!\/\/).+$/u.test(address)) return address;
  }
  throw new Error("Enter a Git repository URL without embedded credentials.");
}

export async function importGitProject(library: string, value: unknown) {
  const address = gitAddress(value);
  const key = createHash("sha256").update("git\0" + address).digest("hex");
  return importCheckout(library, key, async directory => {
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
    const windowsGit = process.env.ProgramFiles && join(process.env.ProgramFiles, "Git", "cmd");
    const extraPaths = process.platform === "win32" ? [windowsGit] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
    try {
      await run("git", ["clone", "--no-local", "--", address, directory], {
        cwd: directory, windowsHide: true, env: { ...process.env,
          [pathKey]: [process.env[pathKey], ...extraPaths].filter(Boolean).join(delimiter),
          GIT_ALLOW_PROTOCOL: "https:http:ssh:git:file", GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string };
      if (failure.code === "ENOENT") throw new Error("Install Git to open projects from a Git URL.");
      throw new Error(failure.stderr?.trim().split(/\r?\n/).find(line => line.startsWith("fatal:")) || "Could not clone the Git repository.");
    }
    return directory;
  });
}
