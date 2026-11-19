import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../project/project";
import { AgentRegistry } from "../agents/registry";
import type { AgentDefinition } from "./manifest";

export class AgentRunner {
  private active?: AbortController;

  constructor(private readonly directory: string, private readonly registry: AgentRegistry,
    private readonly authorize?: (action: AgentDefinition) => Promise<string>) {}

  async run(addon: Project, id: unknown, input: unknown): Promise<unknown> {
    const action = typeof id === "string" ? addon.actions.get(id) : undefined;
    if (!action) throw new Error("The agent action was not found in the active project.");
    if (!action.validateInput(input)) throw new Error("The agent action input does not match its schema.");
    if (this.active) throw new Error("An agent action is already running.");

    const controller = new AbortController();
    this.active = controller;
    let timer: AbortSignal | undefined;
    let work: string | undefined;
    try {
      const provider = this.authorize ? await this.authorize(action) : action.provider;
      const agent = this.registry.get(provider);
      if (!agent.connection.runAction) throw new Error(`${agent.info.name} does not support in-app AI actions.`);
      timer = AbortSignal.timeout(90_000);
      const signal = AbortSignal.any([controller.signal, timer]);
      signal.throwIfAborted();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      work = await mkdtemp(join(this.directory, "run-"));
      // Codex reports canonical skill paths, including for macOS temporary directories.
      work = await realpath(work);
      const cwd = join(work, "workspace");
      const skills = join(work, "skills");
      const skill = join(skills, action.skill);
      await mkdir(cwd);
      await mkdir(skill, { recursive: true });
      await writeFile(join(skill, "SKILL.md"), addon.agentFiles[`skills/${action.skill}/SKILL.md`], "utf8");
      signal.throwIfAborted();

      const reply = await agent.connection.runAction({ cwd, skillRoot: skills, skill: action.skill,
        text: `${action.instructions}\n\nInputs (JSON):\n${JSON.stringify(input)}`, schema: action.outputSchema, signal });
      const result: unknown = JSON.parse(reply);
      if (!action.validateOutput(result)) throw new Error("The agent action output does not match its schema.");
      return result;
    } catch (error) {
      if (timer?.aborted) throw new Error("The agent action timed out. Try again.");
      throw error;
    } finally {
      if (work) await rm(work, { recursive: true, force: true }).catch(console.error);
      this.active = undefined;
    }
  }

  close() {
    this.active?.abort();
  }
}
