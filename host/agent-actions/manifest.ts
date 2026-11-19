import Ajv, { type ValidateFunction } from "ajv";

export const actionName = /^[a-z0-9][a-z0-9-]{0,62}$/;
export type AgentDefinition = {
  id: string;
  provider: string;
  chooseProvider: boolean;
  skill: string;
  instructions: string;
  outputSchema: object;
  validateInput: ValidateFunction;
  validateOutput: ValidateFunction;
};

function schema(value: unknown): value is object {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function compileActions(files: Record<string, string>): Map<string, AgentDefinition> {
  const actions = new Map<string, AgentDefinition>();
  if (files["agents.json"] === undefined) return actions;
  try {
    const definitions: unknown = JSON.parse(files["agents.json"]);
    if (!Array.isArray(definitions) || definitions.length > 16) throw new Error("agents.json must be an array of up to 16 actions.");
    const ajv = new Ajv();
    for (const value of definitions) {
      const { id, provider = "codex", skill, session, instructions, inputSchema, outputSchema } = value ?? {};
      if (typeof id !== "string" || !actionName.test(id) || actions.has(id)) {
        throw new Error("Each action needs a unique lowercase id containing only letters, numbers or hyphens.");
      }
      const invalid = (reason: string): never => { throw new Error(`Action "${id}": ${reason}`); };
      if (typeof skill !== "string" || !actionName.test(skill)) invalid('Set "skill" to the execution skill directory name.');
      if (!files[`skills/${skill}/SKILL.md`]) invalid(`Missing ${skill}/SKILL.md in the registered skills directory.`);
      if (session !== "ephemeral") invalid('Set "session" to "ephemeral".');
      if (typeof instructions !== "string" || !instructions.trim() || instructions.length > 4000) {
        invalid('Provide non-empty "instructions" of at most 4000 characters.');
      }
      if (typeof provider !== "string" || !actionName.test(provider) || !schema(inputSchema) || !schema(outputSchema)) {
        invalid("Check provider, inputSchema and outputSchema.");
      }
      const unexpected = Object.keys(value).find(key =>
        !["id", "provider", "skill", "session", "instructions", "inputSchema", "outputSchema"].includes(key));
      if (unexpected) invalid(`Unknown field "${unexpected}".`);
      actions.set(id, { id, provider, chooseProvider: value.provider === undefined,
        skill, instructions, outputSchema,
        validateInput: ajv.compile(inputSchema), validateOutput: ajv.compile(outputSchema) });
    }
    return actions;
  } catch (error) {
    throw new Error(`The agent definition in agents.json is invalid. ${error instanceof Error ? error.message : String(error)}`);
  }
}
