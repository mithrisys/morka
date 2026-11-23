import { readPreview, type PreviewScenario } from "./preview-scenario";
import { actionName, compileActions, type AgentDefinition } from "../agent-actions/manifest";
import { entryFile, projectPath, type Files } from "./files";

export type Runtime = {
  type: "node"; script: string; url: string; ready: string;
  migration?: { id: string; script: string; compatibility: "backward-compatible" };
};
export type ShadowRef = { id: string; version: string; digest: string; skill: string; rule: string };
export type Manifest = { version: 1; runtime: Runtime; agentActions?: { definitions: string; skills?: string }; instructions?: string[]; shadows?: ShadowRef[] };
export type Project = {
  manifest: Manifest; files: Files; actions: Map<string, AgentDefinition>;
  preview?: PreviewScenario;
  agentFiles: Record<string, string>;
};

export const starterManifest: Manifest = {
  version: 1,
  runtime: { type: "node", script: "start", url: "http://127.0.0.1:0/", ready: "http://127.0.0.1:0/health" },
  agentActions: { definitions: "agents.json", skills: "skills" },
};

export function jsonFile(value: unknown) {
  return Buffer.from(JSON.stringify(value, null, 2) + "\n");
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

export function pathList(value: unknown) {
  if (!Array.isArray(value) || value.length > 64) throw new Error("Invalid project path list.");
  return [...new Set(value.map(projectPath))];
}

export function loopback(value: unknown): URL {
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username || url.password) throw new Error("The service preview must use a local HTTP URL.");
  return url;
}

export function readManifest(files: Files): Manifest {
  const raw = files.get(entryFile)?.toString();
  if (!raw) throw new Error(`The project root must contain ${entryFile}.`);
  const config = object(JSON.parse(raw));
  if (config.version !== 1) throw new Error("Unsupported project manifest version.");
  const rawRuntime = object(config.runtime);
  if (rawRuntime.type !== "node") throw new Error('Set runtime.type to "node".');
  const url = loopback(rawRuntime.url ?? "http://127.0.0.1:0/");
  const ready = rawRuntime.ready === undefined ? new URL("/health", url) : loopback(rawRuntime.ready);
  if (ready.origin !== url.origin) throw new Error("The readiness URL must use the preview origin.");
  const script = rawRuntime.script ?? "start";
  if (typeof script !== "string" || !/^[a-zA-Z0-9:_-]+$/.test(script)) throw new Error("Invalid app startup script.");
  const runtime: Runtime = { type: "node", script, url: url.href, ready: ready.href };
  if (rawRuntime.migration !== undefined) {
    const { id, script, compatibility } = object(rawRuntime.migration);
    if (typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(id) ||
        typeof script !== "string" || !/^[a-zA-Z0-9:_-]+$/.test(script) || compatibility !== "backward-compatible") {
      throw new Error("A live database migration must name an npm script and declare backward-compatible schema changes.");
    }
    runtime.migration = { id, script, compatibility };
  }
  const manifest: Manifest = { version: 1, runtime };
  if (config.agentActions !== undefined) {
    const actions = object(config.agentActions);
    manifest.agentActions = { definitions: projectPath(actions.definitions),
      ...(actions.skills === undefined ? {} : { skills: projectPath(actions.skills) }) };
  }
  if (config.instructions !== undefined) manifest.instructions = pathList(config.instructions);
  if (config.shadows !== undefined) {
    if (!Array.isArray(config.shadows) || config.shadows.length > 32) throw new Error("Invalid Shadow list.");
    const ids = new Set<string>();
    manifest.shadows = config.shadows.map(value => {
      const { id, version, digest, skill, rule } = object(value);
      if (typeof id !== "string" || !actionName.test(id) || ids.has(id) ||
          typeof version !== "string" || !version || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error("Invalid Shadow ID or version.");
      }
      ids.add(id);
      return { id, version, digest, skill: projectPath(skill), rule: projectPath(rule) };
    });
  }
  return manifest;
}

export function instructionPaths(manifest: Manifest) {
  return [...new Set([...(manifest.instructions ?? []), ...manifest.shadows?.flatMap(({ skill, rule }) => [skill, rule]) ?? []])];
}

export async function compileProject(files: Files): Promise<Project> {
  const manifest = readManifest(files);
  const text = (name?: string) => (name && files.get(name)?.toString()) || "";
  for (const name of instructionPaths(manifest)) {
    if (!text(name).trim() || files.get(name)!.length > 32 * 1024) throw new Error(`Invalid rule or skill: ${name}`);
  }
  const agentFiles: Record<string, string> = Object.create(null);
  const definitions = manifest.agentActions?.definitions;
  if (definitions && files.has(definitions)) {
    agentFiles["agents.json"] = text(definitions);
    const root = manifest.agentActions?.skills;
    if (root) {
      for (const [name, bytes] of files) {
        if (name.startsWith(root + "/") && name.endsWith("/SKILL.md")) {
          agentFiles["skills/" + name.slice(root.length + 1)] = bytes.toString();
        }
      }
    }
  }
  const actions = compileActions(agentFiles);
  const preview = readPreview(files);
  for (const [id, output] of Object.entries(preview?.actions ?? {})) {
    if (!actions.get(id)?.validateOutput(output)) throw Error("morka.preview.json: Invalid synthetic output for action " + id);
  }
  return { manifest, files, agentFiles, actions, preview };
}
