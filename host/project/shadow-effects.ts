import { basename } from "node:path";
import { entryFile, projectPath, type Files } from "./files";
import { instructionPaths, jsonFile, object, readManifest } from "./project";
import type { Shadow } from "./shadows";

export const shadowStorage = ".morka-shadows/";
export function isShadowStorage(path: string) { return path.startsWith(shadowStorage); }
type Effect = { path: string; before: string | null; after: string | null };
type Receipt = { effects: Effect[]; uncertain: string[] };

export function editableAppFiles(files: Files) {
  return new Map([...files].filter(([path]) => !isShadowStorage(path)));
}

function receipt(files: Files, id: string): Receipt | undefined {
  const bytes = files.get(`${shadowStorage}${id}/effects.json`);
  if (!bytes || bytes.length > 1_500_000) return;
  try {
    const value = object(JSON.parse(bytes.toString()));
    if (!Array.isArray(value.effects) || !Array.isArray(value.uncertain)) return;
    const effects = value.effects.map(item => {
      const { path, before, after } = object(item);
      const name = projectPath(path);
      if (name === entryFile || isShadowStorage(name) ||
          [before, after].some(text => text !== null && typeof text !== "string")) throw new Error("Invalid effect.");
      return { path: name, before, after } as Effect;
    });
    return { effects, uncertain: value.uncertain.map(projectPath) };
  } catch {
    return undefined;
  }
}

function text(bytes?: Buffer) {
  if (!bytes) return null;
  if (bytes.length > 80_000 || bytes.includes(0)) return;
  const value = bytes.toString();
  return Buffer.from(value).equals(bytes) ? value : undefined;
}

export function saveShadowInstallation(current: Files, updated: Files, shadow: Shadow, previous: Files) {
  const prefix = `${shadowStorage}${shadow.id}/`;
  const old = receipt(previous, shadow.id);
  const effects = new Map(old?.effects.map(effect => [effect.path, effect]));
  const uncertain = new Set(old?.uncertain);
  let size = old ? JSON.stringify(old).length : 0;
  for (const path of new Set([...current.keys(), ...updated.keys()])) {
    if (isShadowStorage(path)) continue;
    const before = current.get(path);
    const after = updated.get(path);
    if (before && after && before.equals(after)) continue;
    if (path === entryFile) {
      const withoutShadows = (value?: Buffer) => {
        const manifest = object(JSON.parse(value!.toString()));
        delete manifest.shadows;
        return JSON.stringify(manifest);
      };
      if (withoutShadows(before) !== withoutShadows(after)) uncertain.add(path);
      continue;
    }
    const from = text(before);
    const to = text(after);
    const previousEffect = effects.get(path);
    if (from === undefined || to === undefined || (previousEffect && previousEffect.after !== from)) {
      uncertain.add(path);
      effects.delete(path);
      continue;
    }
    const effect = { path, before: previousEffect ? previousEffect.before : from, after: to };
    size += JSON.stringify(effect).length;
    if (size > 1_000_000 || uncertain.has(path)) {
      uncertain.add(path);
      effects.delete(path);
    } else if (effect.before === effect.after) effects.delete(path);
    else effects.set(path, effect);
  }
  for (const name of updated.keys()) if (name.startsWith(prefix)) updated.delete(name);
  for (const [name, bytes] of shadow.files) updated.set(prefix + "package/" + name, bytes);
  updated.set(prefix + "effects.json", jsonFile({ effects: [...effects.values()], uncertain: [...uncertain] }));
}

export function installedShadowDescription(files: Files, id: string) {
  const bytes = files.get(`${shadowStorage}${id}/package/manifest.json`);
  if (!bytes) return;
  try {
    const description = object(JSON.parse(bytes.toString())).description;
    return typeof description === "string" ? description : undefined;
  } catch {
    return undefined;
  }
}

export function planShadowRemoval(current: Files, id: string) {
  const manifest = readManifest(current);
  const ref = manifest.shadows?.find(shadow => shadow.id === id);
  if (!ref) throw new Error("This Shadow is no longer installed.");
  const only = new Map(current);
  const raw = object(JSON.parse(current.get(entryFile)!.toString()));
  raw.shadows = manifest.shadows!.filter(shadow => shadow.id !== id);
  only.set(entryFile, jsonFile(raw));
  const prefix = `${shadowStorage}${id}/`;
  for (const name of only.keys()) if (name.startsWith(prefix)) only.delete(name);

  const clean = new Map(only);
  const stored = receipt(current, id);
  const skipped = new Set(stored?.uncertain);
  const changes = new Map<string, string>();
  const ownedInstructions = new Set(instructionPaths(readManifest(only)));
  const deletions: string[] = [];
  for (const effect of stored?.effects ?? []) {
    if (text(current.get(effect.path)) !== effect.after || ownedInstructions.has(effect.path) ||
        (effect.path.startsWith("assets/") && effect.before === null)) {
      skipped.add(effect.path);
      continue;
    }
    if (effect.before === null) deletions.push(effect.path);
    else {
      clean.set(effect.path, Buffer.from(effect.before));
      changes.set(effect.path, "Restore its pre-install contents");
    }
  }
  for (const path of deletions) {
    const name = basename(path);
    const used = [...clean].some(([other, bytes]) => other !== path && !isShadowStorage(other) &&
      (bytes.includes(path) || (name !== "SKILL.md" && bytes.includes(name))));
    if (used) skipped.add(path);
    else {
      clean.delete(path);
      changes.set(path, "Remove an installed file");
    }
  }
  return {
    only, clean,
    summary: { id: ref.id, version: ref.version,
      changes: [...changes].map(([path, reason]) => ({ path, reason })), skipped: [...skipped] },
  };
}
