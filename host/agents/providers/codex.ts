import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ActionPrompt, AgentConnection, AgentPrompt } from "../contracts";
import { effortChoice, projectInstructions, readEditingSkills, sharedHistory } from "../context";
import { attachmentContext } from "../attachments";
import { activityStatus, toolActivity } from "../activity";
import { agentLaunch } from "../process";

// Command rules can authorize shell execution outside the write sandbox. Keep
// native apply_patch available, which checks file permissions independently.
const disabledFeatures = [
  "hooks", "plugins", "apps", "computer_use", "browser_use", "request_permissions_tool", "skill_mcp_dependency_install",
  "shell_tool", "shell_snapshot", "code_mode", "code_mode_only", "multi_agent", "multi_agent_v2", "runtime_agent_instances",
] as const;

type ThreadItem =
  | { type: "userMessage"; id: string; content: { type: string; text?: string }[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; status: string; aggregatedOutput?: string; exitCode?: number }
  | { type: "fileChange"; id: string; changes: { path: string; diff?: string }[]; status: string }
  | { type: "mcpToolCall" | "dynamicToolCall"; id: string; tool: string; status: string; arguments?: unknown; result?: unknown; error?: unknown }
  | { type: "webSearch"; id: string; query: string; status?: string }
  | { type: "imageView"; id: string; path: string };
type Turn = { id: string; status: string; items: ThreadItem[]; error?: { message: string } };
type Envelope = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
type TurnNotification = { threadId: string; turnId?: string; itemId?: string; delta?: string; item?: ThreadItem; turn?: Turn;
  explanation?: string; plan?: { step: string; status: string }[] };
type ActiveTurn = {
  threadId: string;
  id?: string;
  onMessage: (message: ChatMessage, append?: boolean) => void;
  finish: (result: Turn | Error) => void;
  stopRequested?: boolean;
  items: Map<string, ThreadItem>;
};
type EffectiveConfig = {
  features?: Partial<Record<typeof disabledFeatures[number], boolean>>;
  mcp_servers?: Record<string, { enabled?: boolean }>;
  approval_policy?: string;
  sandbox_mode?: string;
  web_search?: string;
};

function toMessage(item: ThreadItem): ChatMessage | undefined {
  switch (item.type) {
    case "agentMessage":
      return { id: item.id, role: "assistant", text: item.text };
    case "commandExecution":
      return { id: item.id, role: "activity", text: item.command,
        activity: toolActivity("command", { command: item.command }, item.exitCode ? "failed" : activityStatus(item.status), item.aggregatedOutput) };
    case "fileChange":
      return { id: item.id, role: "activity", text: item.changes.map(change => change.path).join(", "),
        activity: { kind: "edit", status: activityStatus(item.status), title: `Edit · ${item.changes.map(change => change.path.split("/").at(-1)).join(", ")}`,
          detail: item.changes.map(change => change.path + (change.diff ? "\n" + change.diff : "")).join("\n\n").slice(-32_000) } };
    case "mcpToolCall":
    case "dynamicToolCall":
      return { id: item.id, role: "activity", text: item.tool,
        activity: toolActivity(item.tool, item.arguments, activityStatus(item.status), JSON.stringify(item.error ?? item.result)) };
    case "webSearch":
      return { id: item.id, role: "activity", text: item.query, activity: toolActivity("search", { query: item.query }, activityStatus(item.status)) };
    case "imageView":
      return { id: item.id, role: "activity", text: item.path, activity: toolActivity("view", { path: item.path }, "completed") };
  }
}

export class CodexClient {
  private child!: ChildProcessWithoutNullStreams;
  private readonly ready: Promise<void>;
  private readonly loaded = new Set<string>();
  private readonly disabledServers = new Set<string>();
  private readonly pending = new Map<number, (result: unknown, error?: Error) => void>();
  private policyCheck: Promise<void> = Promise.resolve();
  private nextId = 0;
  private active?: ActiveTurn;
  private failure?: Error;

  constructor(private readonly skillsRoot: string, private readonly runtime = false) {
    this.ready = this.initialize().then(() => this.restrictServers()).catch(error => {
      this.close();
      throw error;
    });
  }

  get disconnected() { return Boolean(this.failure); }

  private async initialize() {
    if (this.failure) throw this.failure;
    const previous = this.child;
    const args = ["app-server", "-c", "mcp_servers={}", "-c", 'web_search="disabled"',
      "-c", 'approval_policy="never"', "-c", 'sandbox_mode="read-only"',
      ...disabledFeatures.flatMap(name => ["--disable", name]),
      ...[...this.disabledServers].flatMap(server => ["-c", `mcp_servers.${server}.enabled=false`])];
    const cli = await agentLaunch("codex", args);
    if (this.failure) throw this.failure;
    const child = spawn(cli.command, cli.args, {
      cwd: homedir(), env: cli.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.child = child;
    if (previous) {
      const replaced = new Error("The Codex connection was restarted to apply project restrictions.");
      for (const finish of this.pending.values()) finish(undefined, replaced);
      this.pending.clear();
      this.loaded.clear();
      previous.kill();
    }
    const onError = (error: Error) => { if (this.child === child) this.fail(error); };
    child.stderr.resume();
    child.on("error", (error: NodeJS.ErrnoException) => onError(error.code === "ENOENT"
      ? new Error("Codex was not found. Set CODEX_BIN to the CLI path.") : error));
    child.stdin.on("error", onError);
    child.on("close", () => onError(new Error("The Codex connection closed.")));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      if (this.child === child) this.receive(line);
    });
    await this.request("initialize", {
      clientInfo: { name: "morka", title: "Morka", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "initialized" });
    await this.request("skills/extraRoots/set", { extraRoots: [this.skillsRoot] });
  }

  private async enabledServers(cwd?: string) {
    const { config } = await this.request<{ config: EffectiveConfig }>("config/read", { cwd, includeLayers: false });
    const hooks = await this.request<{ data: { hooks: { enabled: boolean }[] }[] }>("hooks/list", { cwds: cwd ? [cwd] : [] });
    if (hooks.data.some(entry => entry.hooks.some(hook => hook.enabled)) ||
        disabledFeatures.some(name => config.features?.[name] !== false) ||
        config.approval_policy !== "never" || config.sandbox_mode !== "read-only" || config.web_search !== "disabled") {
      throw new Error("Codex could not verify the required sandbox and tool restrictions.");
    }
    return Object.entries(config.mcp_servers ?? {}).filter(([, server]) => server.enabled !== false).map(([name]) => name);
  }

  private async restrictServers(cwd?: string) {
    const enabled = await this.enabledServers(cwd);
    if (!enabled.length) return;
    if (enabled.some(name => !/^[\w-]+$/.test(name) || this.disabledServers.has(name))) {
      throw new Error("Codex could not verify that all MCP servers were disabled.");
    }
    for (const name of enabled) this.disabledServers.add(name);
    // Config layers merge MCP entries, so an empty table alone cannot disable inherited servers.
    await this.initialize();
    if ((await this.enabledServers(cwd)).length) {
      throw new Error("Codex could not verify that all MCP servers were disabled.");
    }
  }

  private async verifyPolicy(cwd: string) {
    await this.ready;
    const check = this.policyCheck.then(() => this.restrictServers(cwd));
    this.policyCheck = check.catch(() => {});
    await check;
  }

  private write(message: object) {
    if (!this.failure) this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private request<T>(method: string, params: object): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not respond to ${method}.`));
      }, 60_000);
      this.pending.set(id, (result, error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(result as T);
      });
      this.write({ id, method, params });
    });
  }

  private receive(line: string) {
    let message: Envelope;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined) {
      if (message.method) {
        this.write({ id: message.id, error: { code: -32601, message: "Unsupported client request." } });
      } else if (typeof message.id === "number") {
        const finish = this.pending.get(message.id);
        this.pending.delete(message.id);
        finish?.(message.result, message.error && new Error(message.error.message));
      }
      return;
    }

    const active = this.active;
    const event = message.params as TurnNotification | undefined;
    if (!active || !event || event.threadId !== active.threadId) return;
    const turnId = event.turnId ?? event.turn?.id;
    if (active.id && turnId !== active.id) return;
    switch (message.method) {
      case "turn/started":
        active.id = event.turn?.id;
        break;
      case "item/started":
      case "item/completed": {
        if (!event.item || event.item.type === "userMessage") break;
        active.items.set(event.item.id, event.item);
        const item = toMessage(event.item);
        if (item?.text) active.onMessage(item);
        break;
      }
      case "item/commandExecution/outputDelta": {
        const item = event.itemId && active.items.get(event.itemId);
        if (item && item.type === "commandExecution" && event.delta) {
          item.aggregatedOutput = ((item.aggregatedOutput ?? "") + event.delta).slice(-32_000);
          active.onMessage(toMessage(item)!);
        }
        break;
      }
      case "turn/plan/updated":
        if (event.plan) active.onMessage({ id: "plan", role: "activity", text: event.explanation ?? "Plan",
          activity: { kind: "plan", status: event.plan.every(step => step.status === "completed") ? "completed" : "running", title: "Plan",
            detail: [event.explanation, ...event.plan.map(step => `${step.status} · ${step.step}`)].filter(Boolean).join("\n") } });
        break;
      case "item/agentMessage/delta":
        if (event.itemId && event.delta) active.onMessage({ id: event.itemId, role: "assistant", text: event.delta }, true);
        break;
      case "turn/completed":
        if (event.turn) active.finish(event.turn);
        break;
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const finish of this.pending.values()) finish(undefined, error);
    this.pending.clear();
    this.active?.finish(error);
  }

  async start(cwd: string) {
    await this.verifyPolicy(cwd);
    return this.startThread(cwd, false);
  }

  private async startThread(cwd: string, ephemeral: boolean) {
    const { thread } = await this.request<{ thread: { id: string; ephemeral: boolean } }>("thread/start", {
      cwd, ephemeral, sandbox: "read-only", approvalPolicy: "never",
    });
    if (Boolean(thread.ephemeral) !== ephemeral) throw new Error("Codex returned an unexpected session type.");
    this.loaded.add(thread.id);
    return thread.id;
  }

  async options(): Promise<AgentOptions> {
    await this.ready;
    const models: ChatModel[] = [];
    let defaultModel: string | undefined;
    let cursor: string | null = null;
    do {
      const page: { data: { model: string; displayName: string; isDefault?: boolean; defaultReasoningEffort?: string;
        supportedReasoningEfforts?: { reasoningEffort: string }[] }[]; nextCursor: string | null } =
        await this.request("model/list", { cursor });
      defaultModel ??= page.data.find(item => item.isDefault)?.model;
      models.push(...page.data.map(({ model, displayName, supportedReasoningEfforts, defaultReasoningEffort }) => ({
        id: model, name: displayName, efforts: supportedReasoningEfforts?.map(option => effortChoice(option.reasoningEffort)),
        defaultEffort: defaultReasoningEffort,
      })));
      cursor = page.nextCursor;
    } while (cursor);
    return { models, defaultModel };
  }

  async send(threadId: string, turn: AgentPrompt, storeThread?: () => Promise<void>) {
    const { cwd, text, model, effort, files, project, historySinceSession, skills, onMessage, signal } = turn;
    await this.verifyPolicy(cwd);
    if (!this.loaded.has(threadId)) {
      await this.request("thread/resume", { threadId, cwd, excludeTurns: true, sandbox: "read-only", approvalPolicy: "never" });
      this.loaded.add(threadId);
    }
    const instructions = [
      projectInstructions(project),
      "Use apply_patch for changes.",
      ...await readEditingSkills(skills, this.skillsRoot, "`apply_patch`"),
    ].join("\n\n");
    return this.performTurn(threadId, {
      cwd, input: [{ type: "text", text, text_elements: [] },
        ...turn.attachments?.flatMap(attachment => attachment.files.filter(file => file.mimeType).map(file => ({ type: "localImage", path: file.path }))) ?? []], model, effort, approvalPolicy: "never",
      additionalContext: {
        project_files: { kind: "untrusted", name: "project_files", value: JSON.stringify(files) },
        project_paths: { kind: "untrusted", name: "project_paths", value: JSON.stringify(project.paths) },
        project_instructions: { kind: "application", value: instructions },
        ...(turn.attachments?.length ? { attachments: { kind: "untrusted", name: "attachments", value: attachmentContext(turn.attachments) } } : {}),
        ...(historySinceSession.length ? { shared_history: { kind: "untrusted", name: "shared_history", value:
          "Conversation in Morka since your last turn, or before this native session began (JSON): " + sharedHistory(historySinceSession) } } : {}),
        ...(project.shadow ? { shadow_package: { kind: "untrusted", name: "shadow_package", value: project.shadow } } : {}),
      },
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false,
        excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    }, onMessage, signal, storeThread);
  }

  private async skillInputs(cwd: string, root: string, names: string[]) {
    const response = await this.request<{ data: { skills: { name: string; path: string; enabled: boolean }[] }[] }>("skills/list", {
      cwds: [cwd], forceReload: this.runtime,
    });
    const available = response.data.flatMap(entry => entry.skills);
    return names.map(name => {
      const path = join(root, name, "SKILL.md");
      const skill = available.find(skill => skill.name === name && skill.path === path && skill.enabled);
      if (!skill) throw new Error(`Codex could not find the ${name} skill.`);
      return { type: "skill", name: skill.name, path: skill.path };
    });
  }

  async runAction(action: ActionPrompt) {
    const { cwd, skillRoot: root, skill, text, schema: outputSchema, signal } = action;
    await this.verifyPolicy(cwd);
    await this.request("skills/extraRoots/set", { extraRoots: [root] });
    const skills = await this.skillInputs(cwd, root, [skill]);
    signal.throwIfAborted();
    const threadId = await this.startThread(cwd, true);
    let reply = "";
    try {
      const turn = await this.performTurn(threadId, {
        cwd, input: [{ type: "text", text: `$${skill}\n${text}`, text_elements: [] }, ...skills],
        outputSchema, approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
      }, (message, append) => {
        if (message.role === "assistant" && !append) reply = message.text;
      }, signal);
      if (turn.status !== "completed") throw new Error(turn.error?.message ?? "The agent action did not complete.");
      if (!reply) throw new Error("The agent did not return a result.");
      return reply;
    } finally {
      this.loaded.delete(threadId);
      await this.request("thread/unsubscribe", { threadId }).catch(() => {});
    }
  }

  private async performTurn(threadId: string, params: object, onMessage: ActiveTurn["onMessage"],
    signal: AbortSignal, storeThread?: () => Promise<void>) {
    signal.throwIfAborted();
    let finish!: ActiveTurn["finish"];
    const completed = new Promise<Turn | Error>((resolve) => { finish = resolve; });
    const active: ActiveTurn = { threadId, onMessage, finish, items: new Map() };
    this.active = active;
    const stop = () => { void this.stop(threadId).catch(finish); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const { turn } = await this.request<{ turn: Turn }>("turn/start", {
        threadId, ...params,
      });
      active.id ??= turn.id;
      if (storeThread) {
        try {
          await storeThread();
        } catch (error) {
          await this.stop(threadId).catch(console.error);
          throw error;
        }
      }
      if (active.stopRequested) await this.stop(threadId);
      const result = await completed;
      if (result instanceof Error) throw result;
      return result;
    } finally {
      signal.removeEventListener("abort", stop);
      if (this.active === active) this.active = undefined;
    }
  }

  private async stop(threadId: string) {
    const active = this.active;
    if (active?.threadId !== threadId) return;
    if (!active.id) active.stopRequested = true;
    else await this.request("turn/interrupt", { threadId, turnId: active.id });
  }

  close() {
    this.fail(new Error("Morka is closing."));
    this.child?.kill();
  }
}


export class CodexConnection implements AgentConnection {
  private editing?: CodexClient;
  private runtime?: CodexClient;

  constructor(private readonly skills: string) {}

  private connect() {
    if (!this.editing || this.editing.disconnected) this.editing = new CodexClient(this.skills);
    return this.editing;
  }

  options() { return this.connect().options(); }

  async prompt(turn: AgentPrompt) {
    const client = this.connect();
    const id = turn.sessionId ?? await client.start(turn.cwd);
    const result = await client.send(id, turn, turn.sessionId ? undefined : () => turn.storeSession(id));
    if (result.status === "interrupted" || turn.signal.aborted) return "interrupted";
    if (result.status !== "completed") throw new Error(result.error?.message ?? "The Codex turn did not complete.");
    return "completed";
  }

  async runAction(turn: ActionPrompt) {
    if (!this.runtime || this.runtime.disconnected) this.runtime = new CodexClient(turn.skillRoot, true);
    const runtime = this.runtime;
    const stop = () => runtime.close();
    turn.signal.addEventListener("abort", stop, { once: true });
    try {
      turn.signal.throwIfAborted();
      return await runtime.runAction(turn);
    } finally {
      turn.signal.removeEventListener("abort", stop);
    }
  }

  close() {
    this.editing?.close();
    this.runtime?.close();
  }
}
