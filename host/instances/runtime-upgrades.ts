import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeTextAtomically } from "../app-runtime/text-file";
import type { AgentConnection } from "../agents/contracts";
import { synchronizeDraft } from "../project/drafts";
import { applyFiles, checkedPath, digest, entryFile, projectPath, snapshot, sourceContext, type Files } from "../project/files";
import type { Artifact } from "../project/packages";
import { compileProject, jsonFile, type Project } from "../project/project";
import { editableAppFiles, isShadowStorage } from "../project/shadow-effects";
import { readRelease, type AppRelease } from "./repository";
import { compareRuntimeVersions, legacyRuntimeApi, runtimeCompatibility, type RuntimeContract } from "./runtime-compatibility";

export type RuntimeUpgradeStep = {
  from: number;
  to: number;
  minimumVersion: string;
  instructions: string;
  requiresAgent?: boolean;
  replacements?: readonly { path: string; before: string; after: string }[];
};
type Target = RuntimeContract & { version: string };
export type RuntimeUpgradePlan = { from: number; to: number; minimumVersion: string; steps: RuntimeUpgradeStep[] };

// Add a reviewed entry when shipping a runtime that drops a project contract.
const bundledUpgrades: readonly RuntimeUpgradeStep[] = [];

export function planRuntimeUpgrade(project: AppRelease, target: Target, catalogue = bundledUpgrades): RuntimeUpgradePlan | undefined {
  const from = project.runtimeApi ?? legacyRuntimeApi;
  const to = target.runtimeApi;
  if (runtimeCompatibility(project, target) !== "upgrade") return;
  const queue = [{ api: from, steps: [] as RuntimeUpgradeStep[] }];
  const visited = new Set([from]);
  for (const { api, steps } of queue) {
    if (api === to) {
      const minimumVersion = [project.runtimeVersion, ...steps.map(step => step.minimumVersion)]
        .filter((version): version is string => Boolean(version)).sort(compareRuntimeVersions).at(-1)!;
      return { from, to, minimumVersion, steps };
    }
    for (const step of catalogue) {
      if (step.from !== api || step.to <= api || step.to > to || visited.has(step.to) ||
          compareRuntimeVersions(target.version, step.minimumVersion) < 0) continue;
      visited.add(step.to);
      queue.push({ api: step.to, steps: [...steps, step] });
    }
  }
}

type Publish = () => Promise<() => Promise<void>>;
type Upgrade = {
  repository: string;
  projectDirectory: string;
  draftDirectory: string;
  release: AppRelease;
  plan: RuntimeUpgradePlan;
  signal: AbortSignal;
  agent(): Promise<AgentConnection>;
  prepare(files: Files): Promise<Artifact>;
  activate(project: Project, artifact: Artifact, publish: Publish): Promise<void>;
};

function manifestField(files: Files, field: "shadows" | "migration") {
  const manifest = JSON.parse(files.get(entryFile)?.toString() ?? "{}");
  return field === "shadows" ? manifest.shadows : manifest.runtime?.migration;
}

export async function upgradeProjectRuntime(options: Upgrade) {
  const { repository, projectDirectory, draftDirectory, plan, signal } = options;
  const metadataFile = await checkedPath(repository, ".morka/release.json");
  const originalMetadata = await readFile(metadataFile, "utf8");
  if (!isDeepStrictEqual(readRelease(metadataFile), options.release)) throw new Error("The release settings changed. Reopen the project to upgrade it.");
  const live = await snapshot(projectDirectory);
  const editable = editableAppFiles(live);
  const workspace = join(draftDirectory, "app");
  const stateFile = join(draftDirectory, "draft.json");
  const saved = JSON.parse(await readFile(stateFile, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  })) as { base?: string; transformed?: boolean; needsAgent?: boolean };
  const { draft, base } = await synchronizeDraft(workspace, editable, saved, signal);
  const transformed = saved.transformed && saved.base === base;
  let needsAgent = transformed ? Boolean(saved.needsAgent) : plan.steps.some(step => step.requiresAgent);
  await writeTextAtomically(stateFile, JSON.stringify({ base, transformed, needsAgent }));
  if (!transformed) {
    const changes = new Map(draft);
    for (const step of plan.steps) {
      for (const edit of step.replacements ?? []) {
        const path = projectPath(edit.path);
        if (isShadowStorage(path) || !edit.before) throw new Error("Invalid bundled runtime upgrade edit.");
        const contents = changes.get(path)?.toString("utf8");
        if (contents === undefined || !contents.includes(edit.before)) continue;
        const pieces = contents.split(edit.before);
        if (pieces.length !== 2) { needsAgent = true; continue; }
        changes.set(path, Buffer.from(pieces.join(edit.after)));
      }
    }
    await applyFiles(workspace, draft, changes, signal);
    await writeTextAtomically(stateFile, JSON.stringify({ base, transformed: true, needsAgent }));
  }

  const validate = async () => {
    signal.throwIfAborted();
    const edited = await snapshot(workspace);
    if ([...edited.keys()].some(isShadowStorage)) throw new Error("Runtime upgrades must preserve installed Shadow files.");
    const next = new Map([...live].filter(([path]) => isShadowStorage(path)));
    for (const [path, bytes] of edited) next.set(path, bytes);
    const candidate = await compileProject(next);
    if (!isDeepStrictEqual(manifestField(live, "shadows"), manifestField(candidate.files, "shadows"))) {
      throw new Error("Runtime upgrades must preserve installed Shadows.");
    }
    if (!isDeepStrictEqual(manifestField(live, "migration"), manifestField(candidate.files, "migration"))) {
      throw new Error("A database migration needs its own review. Keep the existing data migration settings.");
    }
    const artifact = await options.prepare(candidate.files);
    return { candidate: await compileProject(artifact.source), artifact };
  };

  const upgraded: AppRelease = { ...options.release, runtimeVersion: plan.minimumVersion, runtimeApi: plan.to };
  const finish = async () => {
    const { candidate, artifact } = await validate();
    // Keep build-generated lockfile updates in the draft if activation fails.
    await applyFiles(workspace, await snapshot(workspace), editableAppFiles(candidate.files), signal);
    await options.activate(candidate, artifact, async () => {
      await checkedPath(repository, ".morka/release.json");
      if (digest(await snapshot(projectDirectory)) !== digest(live) || await readFile(metadataFile, "utf8") !== originalMetadata) {
        throw new Error("The project changed during the upgrade. The upgrade draft is preserved.");
      }
      const undoSource = () => applyFiles(projectDirectory, candidate.files, live);
      await applyFiles(projectDirectory, live, candidate.files, signal);
      try {
        await writeTextAtomically(metadataFile, jsonFile({ ...JSON.parse(originalMetadata), ...upgraded }).toString());
      } catch (error) {
        await undoSource();
        throw error;
      }
      return async () => {
        await undoSource();
        await writeTextAtomically(metadataFile, originalMetadata);
      };
    });
    return upgraded;
  };

  let diagnostic: string | undefined;
  if (!needsAgent) {
    try { return await finish(); }
    catch (error) {
      if (await readFile(metadataFile, "utf8") !== originalMetadata || digest(await snapshot(projectDirectory)) !== digest(live)) throw error;
      diagnostic = error instanceof Error ? error.message : String(error);
    }
  }
  signal.throwIfAborted();
  const agent = await options.agent();
  signal.throwIfAborted();
  const files = await snapshot(workspace);
  const preferred = plan.steps.flatMap(step => step.replacements?.map(edit => edit.path) ?? []);
  const relevant = new Map([...files].filter(([path]) => path === entryFile || path === "package.json" || preferred.includes(path)));
  const result = await agent.prompt({ cwd: workspace,
    text: [`Upgrade the app draft from Morka runtime API ${plan.from} to ${plan.to}.`,
      ...plan.steps.map(step => `API ${step.from} to ${step.to}: ${step.instructions}`),
      ...(diagnostic ? [`Validation diagnostics (data): ${JSON.stringify(diagnostic.slice(0, 8000))}`] : [])].join("\n\n"),
    skills: ["morka-runtime-migration"], files: sourceContext(relevant, preferred),
    project: { target: "app", instructions: {}, paths: [...files.keys()] }, history: [], historySinceSession: [], signal,
    onMessage() {}, async storeSession() {},
  });
  if (result !== "completed") throw new Error("The upgrade was interrupted. The draft is still available.");
  await writeTextAtomically(stateFile, JSON.stringify({ base, transformed: true, needsAgent: false }));
  return finish();
}
