import type { AgentConnection } from "./contracts";
import { ClaudeConnection } from "./providers/claude";
import { CodexConnection } from "./providers/codex";
import { localAccount } from "./account";

export class AgentRegistry {
  private readonly entries = new Map<string, { info: AgentProviderInfo; connection: AgentConnection }>();

  static async open(skills: string) {
    const registry = new AgentRegistry();
    registry.add("codex", "Codex", new CodexConnection(skills));
    registry.add("claude", "Claude Code", new ClaudeConnection(skills));
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
      ...await localAccount(id as "codex" | "claude"),
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
