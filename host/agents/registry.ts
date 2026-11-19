import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentConnection } from "./contracts";
import type { AcpProfile } from "./acp-sandbox";
import { AcpConnection } from "./providers/acp";
import { ClaudeConnection } from "./providers/claude";
import { CodexConnection } from "./providers/codex";
import { localAccount } from "./account";

function profile(value: unknown): AcpProfile {
  const entry = value as Partial<AcpProfile>;
  if (!entry || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(entry.id) ||
      ["codex", "claude"].includes(entry.id) || typeof entry.name !== "string" || !entry.name.trim() ||
      typeof entry.command !== "string" || !entry.command.trim() || (!isAbsolute(entry.command) && entry.command.includes("/")) ||
      !Array.isArray(entry.args) || !entry.args.every(arg => typeof arg === "string") ||
      (entry.readPaths !== undefined && (!Array.isArray(entry.readPaths) || !entry.readPaths.every(path => typeof path === "string" && isAbsolute(path)))) ||
      (entry.env !== undefined && (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env) ||
        !Object.entries(entry.env).every(([name, text]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && typeof text === "string")))) {
    throw new Error("Invalid ACP agent profile.");
  }
  return entry as AcpProfile;
}

export class AgentRegistry {
  private readonly entries = new Map<string, { info: AgentProviderInfo; connection: AgentConnection }>();

  static async open(directory: string, project: string, skills: string) {
    const registry = new AgentRegistry();
    registry.add("codex", "Codex", new CodexConnection(skills));
    registry.add("claude", "Claude Code", new ClaudeConnection(skills));
    const home = homedir();
    const installations = [join(home, ".local/lib"), join(home, ".local/bin")];
    const builtins: AcpProfile[] = [
      { id: "hermes", name: "Hermes", command: process.env.HERMES_BIN || "hermes", args: ["acp"],
        readPaths: [...installations, ...["hermes-agent", "node", "tools", "installs"].map(path => join(home, ".hermes", path))] },
      { id: "pi", name: "Pi", command: process.env.PI_ACP_BIN || "pi-acp", args: [], readPaths: installations },
    ];
    const override = process.env.MORKA_ACP_PROFILES;
    const configured = override || join(directory, "acp-profiles.json");
    const raw = await readFile(configured, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !override) return "[]";
      throw error;
    });
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error("The ACP profiles file must contain an array.");
    for (const entry of [...builtins, ...data.map(profile)]) {
      if (process.platform === "darwin") {
        registry.add(entry.id, entry.name, new AcpConnection(entry, skills, join(directory, "agents", entry.id), project));
      }
    }
    return registry;
  }

  private add(id: string, name: string, connection: AgentConnection) {
    this.entries.set(id, { info: { id, name }, connection });
  }

  providers() { return [...this.entries.values()].map(({ info }) => info); }

  async setup() {
    return Promise.all([...this.entries.entries()].map(async ([id, { info, connection }]): Promise<AgentSetupInfo> => ({
      ...info,
      supportsActions: Boolean(connection.runAction),
      ...(id === "codex" || id === "claude" ? await localAccount(id) : { state: "managed" }),
    })));
  }

  get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("This agent is not registered in Morka.");
    return entry;
  }

  close() {
    for (const { connection } of this.entries.values()) connection.close();
  }
}
