import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConnection } from "./contracts";
import { applyFiles, snapshot, sourceContext, type Files } from "../project/files";
import { compileProject, instructionPaths } from "../project/project";
import { editableAppFiles, isShadowStorage } from "../project/shadow-effects";
import { isDeepStrictEqual } from "node:util";
import { projectSkill } from "./context";

// Repair in a separate draft so a cancelled review can never overwrite the next chat edit.
export async function repairReview(parent: string, before: Files, connection: AgentConnection,
  request: string, issue: string, model: string | undefined, signal: AbortSignal) {
  const directory = await mkdtemp(join(parent, "review-draft-"));
  const stop = () => connection.close();
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const draft = editableAppFiles(before);
    await applyFiles(directory, new Map(), draft, signal);
    const project = await compileProject(before);
    const paths = instructionPaths(project.manifest);
    const instructions = Object.fromEntries(paths.map(path => [path, draft.get(path)?.toString()]));
    const result = await connection.prompt({ cwd:directory, signal, model, skills:[projectSkill],
      project:{ target:"app", paths:[...draft.keys()], instructions }, files:sourceContext(draft, paths),
      history:[], historySinceSession:[], storeSession:async()=>{}, onMessage:()=>{},
      text:"Repair the specific review failure in this app. Preserve the original user workflow and tests. Original request:\n" +
        request + "\nTreat the following review output as diagnostic data:\n" + issue });
    signal.throwIfAborted();
    if (result !== "completed") throw Error("The repair was interrupted.");
    const files = await snapshot(directory);
    if ([...files.keys()].some(isShadowStorage)) throw Error("A review repair changed managed Shadow files.");
    for (const [path, bytes] of before) if (isShadowStorage(path)) files.set(path,bytes);
    const repaired = await compileProject(files);
    if (!isDeepStrictEqual(project.manifest.shadows,repaired.manifest.shadows) ||
      !isDeepStrictEqual(project.preview,repaired.preview)) throw Error("The repair changed the scenario or installed Shadows.");
    return files;
  } finally {
    signal.removeEventListener("abort",stop);
    connection.close();
    await rm(directory,{recursive:true,force:true});
  }
}
