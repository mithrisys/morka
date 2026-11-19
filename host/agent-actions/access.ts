import { readFile } from "node:fs/promises";
import { writeTextAtomically } from "../app-runtime/text-file";
import type { AgentDefinition } from "./manifest";

export class ActionAccess {
  constructor(private readonly file: string) {}

  private async read(): Promise<Record<string, unknown>> {
    const value: unknown = JSON.parse(await readFile(this.file, "utf8").catch(error => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    }));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  async current(): Promise<string[]> {
    const { fixed, preferred } = await this.read();
    return [...new Set([...(Array.isArray(fixed) ? fixed : []), preferred]
      .filter((id): id is string => id === "codex" || id === "claude"))];
  }

  async choose(action: AgentDefinition, prompt: (choices: string[]) => Promise<string | undefined>) {
    const choices = action.chooseProvider ? ["codex", "claude"] : [action.provider];
    if (!choices.every(id => id === "codex" || id === "claude")) {
      throw new Error("This action needs a supported local provider.");
    }
    const { fixed, preferred } = await this.read();
    const allowed = Array.isArray(fixed) ? fixed.filter(id => id === "codex" || id === "claude") : [];
    if (action.chooseProvider && typeof preferred === "string" && choices.some(id => id === preferred)) return preferred;
    if (!action.chooseProvider && allowed.some(id => id === action.provider)) return action.provider;
    const chosen = await prompt(choices);
    if (!chosen || !choices.some(id => id === chosen)) throw new Error("AI access was declined. Open AI setup to check your connection.");
    await writeTextAtomically(this.file, JSON.stringify(action.chooseProvider
      ? { fixed: allowed, preferred: chosen } : { fixed: [...allowed, chosen], preferred }));
    return chosen;
  }

  clear() { return writeTextAtomically(this.file, "{}"); }
}
