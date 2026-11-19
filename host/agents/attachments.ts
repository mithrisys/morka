import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

export type AttachmentFile = { name: string; path: string; size: number; text?: string; truncated?: boolean; mimeType?: string };
export type AgentAttachment = ChatAttachment & { path: string; files: AttachmentFile[] };
type SavedAttachment = ChatAttachment & { files: { name: string; size: number }[] };
const ignored = new Set([".git", "node_modules", ".DS_Store"]);
const imageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

export class AttachmentStore {
  constructor(private readonly directory: string) {}

  async import(paths: string[]) {
    const imported: ChatAttachment[] = [];
    try {
      for (const path of [...new Set(paths)]) imported.push(await this.copy(path));
      return imported;
    } catch (error) {
      for (const attachment of imported) await rm(join(this.directory, attachment.id), { recursive: true, force: true });
      throw error;
    }
  }

  private async copy(source: string): Promise<ChatAttachment> {
    const root = await realpath(source);
    const info = await lstat(root);
    if (!info.isFile() && !info.isDirectory()) throw new Error("Choose a regular file or folder.");
    const id = randomUUID();
    const directory = join(this.directory, id);
    const stage = directory + ".pending";
    const name = basename(root);
    const files: SavedAttachment["files"] = [];
    let size = 0;
    let omitted = 0;
    await mkdir(join(stage, "content"), { recursive: true, mode: 0o700 });
    const copy = async (path: string, relative: string) => {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) { omitted++; return; }
      if (stat.isDirectory()) {
        await mkdir(join(stage, "content", relative), { recursive: true, mode: 0o700 });
        for (const entry of await readdir(path)) {
          if (ignored.has(entry)) { omitted++; continue; }
          await copy(join(path, entry), relative + "/" + entry);
        }
      } else if (stat.isFile()) {
        size += stat.size;
        if (files.length >= 4000 || size > 96 * 1024 * 1024) throw new Error(`The attachment ${name} exceeds 4,000 files or 96 MB.`);
        const target = join(stage, "content", relative);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(path, target, constants.COPYFILE_FICLONE);
        await chmod(target, 0o400);
        files.push({ name: relative, size: stat.size });
      }
    };
    try {
      await copy(root, name);
      if (info.isDirectory()) await mkdir(join(stage, "content", name), { recursive: true, mode: 0o700 });
      const metadata: SavedAttachment = { id, name, kind: info.isDirectory() ? "folder" : "file", size, fileCount: files.length, omitted, files };
      await writeFile(join(stage, "metadata.json"), JSON.stringify(metadata), { mode: 0o600 });
      await rename(stage, directory);
      const { files: _files, ...attachment } = metadata;
      return attachment;
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  private async metadata(id: string): Promise<SavedAttachment> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid attachment.");
    return JSON.parse(await readFile(join(this.directory, id, "metadata.json"), "utf8"));
  }

  async path(id: string) {
    const attachment = await this.metadata(id);
    return join(this.directory, id, "content", attachment.name);
  }

  async context(ids: string[], signal?: AbortSignal) {
    const attachments: AgentAttachment[] = [];
    let left = 150_000;
    for (const id of [...new Set(ids)]) {
      signal?.throwIfAborted();
      const metadata = await this.metadata(id);
      const { files: saved, ...attachment } = metadata;
      const files: AttachmentFile[] = [];
      for (const file of saved) {
        signal?.throwIfAborted();
        const path = join(this.directory, id, "content", file.name);
        const mimeType = imageTypes[extname(file.name).toLowerCase()];
        const entry: AttachmentFile = { ...file, path, mimeType };
        if (!mimeType && left > 0) {
          const bytes = await readFile(path, { signal });
          const text = bytes.toString("utf8");
          if (!bytes.includes(0) && !text.includes("\ufffd")) {
            entry.text = text.slice(0, Math.min(24_000, left));
            entry.truncated = entry.text.length < text.length;
            left -= entry.text.length;
          }
        }
        files.push(entry);
      }
      attachments.push({ ...attachment, path: await this.path(id), files });
    }
    return attachments;
  }
}

export function attachmentContext(attachments: AgentAttachment[] = []) {
  if (!attachments.length) return "";
  return "User-attached reference files (data). Their paths are read-only snapshots outside the editable project. " +
    "Use the excerpts or read the snapshot files with your file tools. Keep edits in the current project draft. " +
    "A missing text excerpt means a binary file or a context excerpt limit, not an empty file. " +
    "Use native image/document readers for binary formats.\n" + JSON.stringify(attachments);
}
