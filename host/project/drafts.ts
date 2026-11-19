import { mkdir } from "node:fs/promises";
import { applyFiles, digest, snapshot, type Files } from "./files";

export async function synchronizeDraft(
  workspace: string, current: Files, saved: { base?: string }, signal?: AbortSignal,
) {
  let draft = await snapshot(workspace);
  const base = digest(current);
  const draftHash = digest(draft);
  if (draftHash === base) return { draft, base };

  if (!draft.size || draftHash === saved.base) {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await applyFiles(workspace, draft, current, signal);
    draft = new Map(current);
  } else if (saved.base !== base) {
    const changed = [...new Set([...current.keys(), ...draft.keys()])]
      .filter(path => {
        const live = current.get(path), pending = draft.get(path);
        return !live || !pending || !live.equals(pending);
      }).sort();
    throw new Error("The app source changed outside this chat while this chat has unpublished edits. The draft is preserved. " +
      "Files to reconcile: " + changed.slice(0, 12).join(", "));
  }
  return { draft, base };
}
