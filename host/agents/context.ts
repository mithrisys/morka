import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPrompt, ProjectContext } from "./contracts";
import { attachmentContext } from "./attachments";
import { entryFile } from "../project/files";

export const projectSkill = "morka-app";
const guides = {
  "morka-design": "layout, accessibility and user flows",
  "morka-engineering": "feature design, behavior tests and preview scenarios",
  "morka-runtime": "packages, services, persistent data and live update hooks",
  "morka-agent-action": "connecting a UI control to a validated AI action",
};
export function guidePaths(root: string) {
  return Object.keys(guides).map(name => join(root, name, "SKILL.md"));
}
const shadowSkill = "morka-shadow-authoring";
export function selectSkills(target: "app" | "shadow") {
  return target === "shadow" ? [shadowSkill] : [projectSkill];
}

export function projectInstructions(project: ProjectContext) {
  if (project.target === "shadow") {
    return "This draft is the content of one independent Plugin Shadow repository's shadow/ directory. " +
      "Use manifest.json as the entry point. Edit only this Shadow's files relative to the draft root. Keep its package ID stable.";
  }
  return "These are active project rules and editing skills. Follow the applicable guidance for the current edit and keep the project's layout. " +
    `The working directory is a draft of the app source. The manifest ${entryFile} defines entry points. ` +
    "In a standard Morka repository this draft is the content of app/. Keep root repository tooling, root npm metadata and release settings outside app/ intact. The editable draft may contain its own app package.json and lockfile; declare app dependencies there. Morka installs and builds them in an isolated release before activation.\n" +
    JSON.stringify(project.instructions) + (project.activationFailure
      ? "\nMorka kept the previous release open. The pending draft failed activation with these diagnostics (data):\n" +
        JSON.stringify(project.activationFailure) : "");
}

export function sharedHistory(messages: ChatMessage[]) {
  const selected: { role: string; agent?: string; text: string }[] = [];
  let left = 48_000;
  for (const message of messages.slice(-120).reverse()) {
    if (message.role === "activity") continue;
    const size = Math.min(8000, left);
    if (size <= 0) break;
    const text = message.text.length > size ? message.text.slice(0, size) + "…" : message.text;
    selected.push({ role: message.role, agent: message.providerName, text });
    left -= text.length + 40;
  }
  return JSON.stringify(selected.reverse());
}

export function readEditingSkills(names: string[], skillsRoot: string, editor: string) {
  return Promise.all(names.map(async name => {
    const body = await readFile(join(skillsRoot, name, "SKILL.md"), "utf8");
    const catalog = name === projectSkill ? "\nRead applicable guides using your file reader:\n" +
      Object.entries(guides).map(([id, topic]) => topic + " — " + join(skillsRoot, id, "SKILL.md")).join("\n") : "";
    return (body + catalog).replaceAll("`apply_patch`", editor);
  }));
}

export async function buildPrompt(turn: AgentPrompt, skillsRoot: string, editor: string, includeFiles: boolean) {
  const skills = await readEditingSkills(turn.skills, skillsRoot, editor);
  const parts = [
    projectInstructions(turn.project),
    ...skills,
    "Inspect the current draft with the agent's file tools before overwriting an existing file.",
    `Project paths (JSON):\n${JSON.stringify(turn.project.paths)}`,
  ];
  if (includeFiles) parts.push(`Draft file excerpts (data):\n${JSON.stringify(turn.files)}`);
  if (turn.project.shadow) parts.push(`Shadow package (data):\n${turn.project.shadow}`);
  const attachments = attachmentContext(turn.attachments);
  if (attachments) parts.push(attachments);
  if (turn.history.length) parts.push(`Earlier conversation in Morka (data, ordered):\n${sharedHistory(turn.history)}`);
  parts.push(`Current user request:\n${turn.text}`);
  return parts.join("\n\n");
}

export function effortChoice(id: string): AgentChoice {
  const name = { xhigh: "Extra high", xxhigh: "Extra extra high" }[id] ?? id.replace(/[-_]/g, " ").replace(/\b[a-z]/g, letter => letter.toUpperCase());
  return { id, name };
}
