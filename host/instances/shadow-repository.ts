import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { applyFiles, info, type Files } from "../project/files";
import { jsonFile, object } from "../project/project";
import { readShadow } from "../project/shadows";
import { appName, idPattern, repositoryFile, repositorySlug, writeRepositoryScaffold } from "./repository";

const workspaceFile = [".morka", "shadow.json"];

export type ShadowWorkspace = {
  id: string; name: string; repository: string; root: string;
};

export function containsPath(directory: string, path: string) {
  const rel = relative(directory, path);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}

export async function readShadowWorkspace(directory: string): Promise<ShadowWorkspace> {
  const repository = await realpath(directory);
  const root = join(repository, "shadow");
  if (!(await info(root))?.isDirectory()) throw new Error("Choose a Morka Shadow repository with a shadow/ directory.");
  const { id, name } = object(JSON.parse(await readFile(repositoryFile(repository, "shadow.json"), "utf8")));
  if (typeof id !== "string" || !idPattern.test(id) || typeof name !== "string" || name !== appName(name)) {
    throw new Error("Invalid Shadow repository information.");
  }
  await readShadow(root);
  return { id, name, repository, root };
}

export async function createShadowRepository(parent: string, name: string, kit: string) {
  const repository = join(await realpath(parent), name);
  if (await info(repository)) throw new Error(`A folder named “${name}” already exists there.`);
  const workspaceId = randomUUID();
  const id = repositorySlug(name).slice(0, 63).replace(/-+$/, "") || `shadow-${workspaceId.slice(0, 8)}`;
  const staged = await mkdtemp(join(parent, ".morka-shadow-"));
  const root = join(staged, "shadow");
  try {
    await writeRepositoryScaffold(staged, id, kit, {
      validate: "morka-pack shadow-validate", pack: "morka-pack shadow-pack",
    }, `# ${name}

This repository contains an independent Morka Plugin Shadow. Open the repository
from the Shadows panel to edit it. The installable files are inside \`shadow/\`.

Run \`npm ci\`, then \`npm run validate\` to check the package and \`npm run pack\`
to create an installable folder under \`dist/\`. Select that folder in any Morka
app's Shadows panel to install it.
`, "# Editing this Shadow\n\nStart with shadow/manifest.json. Edit only files inside shadow/. The root contains the Git, npm, and Morka project configuration.\n");
    const files: Files = new Map([
      ["manifest.json", jsonFile({ id, version: "1.0.0", description: name, skills: `skills/${id}/SKILL.md`, rules: "rules/shadow.md" })],
      [`skills/${id}/SKILL.md`, Buffer.from(`---\nname: ${id}\ndescription: Apply the ${id} Shadow to the target app.\n---\n\nRead the package rule and adapt it to the target app's source layout.\n`)],
      ["rules/shadow.md", Buffer.from("# Project rule\n\nDefine the lasting behavior for this Shadow here.\n")],
    ]);
    await mkdir(root);
    await applyFiles(root, new Map(), files);
    await writeFile(join(staged, ...workspaceFile), jsonFile({ id: workspaceId, name }));
    await readShadowWorkspace(staged);
    await mkdir(repository, { mode: 0o700 });
    try {
      await rename(staged, repository);
    } catch (error) {
      await rmdir(repository).catch(console.error);
      throw error;
    }
    return { id: workspaceId, name, repository, root: join(repository, "shadow") };
  } finally {
    await rm(staged, { force: true, recursive: true }).catch(console.error);
  }
}

export async function packShadowRepository(directory: string) {
  const workspace = await readShadowWorkspace(directory);
  const shadow = await readShadow(workspace.root);
  const output = join(workspace.repository, "dist");
  await mkdir(output, { recursive: true });
  const staged = await mkdtemp(join(output, ".morka-pack-"));
  const destination = join(output, `${shadow.id}-${shadow.version}-${shadow.digest.slice(0, 12)}`);
  try {
    await applyFiles(staged, new Map(), shadow.files);
    try {
      await rename(staged, destination);
    } catch (error) {
      if ((await readShadow(destination).catch(() => undefined))?.digest !== shadow.digest) throw error;
    }
    return destination;
  } finally {
    await rm(staged, { force: true, recursive: true }).catch(console.error);
  }
}
