import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { actionName } from "../agent-actions/manifest";
import { applyFiles, checkedPath, digest, entryFile, info, snapshot, type Files } from "./files";
import { jsonFile, object, pathList, readManifest, type ShadowRef } from "./project";

export type Shadow = {
  id: string; version: string; description: string; digest: string; skills: string; rules: string;
  assets: string[]; examples: string[]; files: Files;
};

function parseShadow(manifest: Buffer | undefined) {
  if (!manifest?.length || manifest.length > 32 * 1024) throw new Error("The Shadow package manifest.json is invalid.");
  const { id, version, description, skills, rules, assets = [], examples = [] } = object(JSON.parse(manifest.toString()));
  if (typeof id !== "string" || !actionName.test(id) || typeof version !== "string" ||
      !/^[0-9][a-zA-Z0-9.-]{0,47}$/.test(version) || typeof description !== "string" ||
      !description.trim() || description.length > 1000) throw new Error("The Shadow package ID, version, or description is invalid.");
  const [skillPath, rulePath] = pathList([skills, rules]);
  if (!rulePath || [skillPath, rulePath].includes("manifest.json")) throw new Error("The Shadow skill and rule must use separate files.");
  const assetPaths = pathList(assets);
  const examplePaths = pathList(examples);
  return { id, version, description, skills: skillPath, rules: rulePath, assets: assetPaths, examples: examplePaths };
}

function shadowPaths(spec: ReturnType<typeof parseShadow>) {
  return new Set([spec.skills, spec.rules, ...spec.assets, ...spec.examples]);
}

export function validateShadow(files: Files): Shadow {
  const manifest = files.get("manifest.json");
  const spec = parseShadow(manifest);
  const selected: Files = new Map([["manifest.json", manifest!]]);
  let total = manifest!.length;
  for (const name of shadowPaths(spec)) {
    const bytes = files.get(name);
    if (!bytes?.length) throw new Error(`Package file not found: ${name}`);
    total += bytes.length;
    const textual = [spec.skills, spec.rules, ...spec.examples].includes(name);
    if (total > 32 * 1024 * 1024 || (textual && bytes.length > 32 * 1024)) throw new Error(`Package size limit exceeded: ${name}`);
    if (textual && (bytes.includes(0) || !bytes.toString().trim())) {
      throw new Error(`Invalid Shadow text file: ${name}`);
    }
    selected.set(name, bytes);
  }
  return { ...spec, digest: digest(selected), files: selected };
}

export async function readShadow(directory: string): Promise<Shadow> {
  if (!(await info(directory))?.isDirectory()) throw new Error("Invalid Shadow package folder.");
  const manifest = await checkedPath(directory, "manifest.json");
  const file = await info(manifest);
  if (!file?.isFile() || file.size > 32 * 1024) throw new Error("The Shadow package manifest.json is invalid.");
  const bytes = await readFile(manifest);
  const files: Files = new Map([["manifest.json", bytes]]);
  let total = bytes.length;
  for (const name of shadowPaths(parseShadow(bytes))) {
    const path = await checkedPath(directory, name);
    const entry = await info(path);
    if (!entry?.isFile() || !entry.size) throw new Error(`Package file not found: ${name}`);
    total += entry.size;
    if (total > 32 * 1024 * 1024) throw new Error(`Package size limit exceeded: ${name}`);
    files.set(name, await readFile(path));
  }
  return validateShadow(files);
}

export async function importShadow(directory: string, library: string) {
  const content = join(directory, "shadow");
  const shadow = await readShadow(await info(join(content, "manifest.json")) ? content : directory);
  const location = join(library, shadow.id, shadow.version, shadow.digest);
  const existing = await snapshot(location);
  if (existing.size && digest(existing) !== shadow.digest) throw new Error("The installed Shadow package data is invalid.");
  if (!existing.size) await applyFiles(location, existing, shadow.files);
  return shadow;
}

export function stageShadow(shadow: Shadow, draft: Files) {
  const manifest = readManifest(draft);
  const previous = manifest.shadows?.find(item => item.id === shadow.id);
  const fingerprint = shadow.digest.slice(0, 12);
  const availablePath = (name: string, alternate: string, source: string) => {
    const contents = draft.get(name);
    return contents && !contents.equals(shadow.files.get(source)!) ? alternate : name;
  };
  const ref: ShadowRef = {
    id: shadow.id, version: shadow.version, digest: shadow.digest,
    skill: previous?.skill ?? availablePath(`skills/shadows/${shadow.id}/SKILL.md`,
      `skills/shadows/${shadow.id}/${fingerprint}/SKILL.md`, shadow.skills),
    rule: previous?.rule ?? availablePath(`rules/shadows/${shadow.id}.md`,
      `rules/shadows/${shadow.id}-${fingerprint}.md`, shadow.rules),
  };
  function install(name: string, bytes: Buffer) {
    if (draft.has(name) && !draft.get(name)?.equals(bytes)) {
      throw new Error(`Resolve this file conflict before installing Shadow: ${name}`);
    }
    draft.set(name, bytes);
  }
  // Preserve the installed project version of a rule or skill during an update.
  if (!previous) {
    install(ref.skill, shadow.files.get(shadow.skills)!);
    install(ref.rule, shadow.files.get(shadow.rules)!);
  }
  for (const name of shadow.assets) install(`assets/shadows/${shadow.id}/${shadow.version}/${name}`, shadow.files.get(name)!);
  const raw = object(JSON.parse(draft.get(entryFile)!.toString()));
  raw.shadows = [...manifest.shadows?.filter(item => item.id !== shadow.id) ?? [], ref];
  draft.set(entryFile, jsonFile(raw));
  return ref;
}

export function shadowContext(shadow: Shadow) {
  return JSON.stringify({
    id: shadow.id, version: shadow.version, description: shadow.description,
    skill: shadow.files.get(shadow.skills)!.toString(), rule: shadow.files.get(shadow.rules)!.toString(),
    assets: shadow.assets.map(name => `assets/shadows/${shadow.id}/${shadow.version}/${name}`),
    examples: Object.fromEntries(shadow.examples.map(name => [name, shadow.files.get(name)!.toString()])),
  });
}
