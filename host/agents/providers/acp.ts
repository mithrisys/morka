import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { writeTextAtomically } from "../../app-runtime/text-file";
import { checkedPath, info, projectPath } from "../../project/files";
import type { AgentConnection, AgentPrompt } from "../contracts";
import { buildPrompt, effortChoice } from "../context";
import { spawnAcp, stopAgent, type AcpProfile } from "../acp-sandbox";
import { activityStatus, toolActivity } from "../activity";

type Rpc = { id?: number | string; method?: string; params?: unknown; result?: unknown;
  error?: { code: number; message: string; data?: { details?: string } } };
type Resolve = { resolve: (result: unknown) => void; reject: (error: Error) => void };
type AgentUpdate = {
  sessionId?: string;
  update?: { sessionUpdate?: string; content?: { type?: string; text?: string }; title?: string; status?: string;
    toolCallId?: string; configOptions?: ConfigOption[]; kind?: string; rawInput?: unknown; rawOutput?: unknown;
    locations?: { path?: string }[] };
};
type Choice = { value: string; name: string };
type ConfigOption = { id: string; category?: string; options?: (Choice | { options: Choice[] })[]; currentValue?: string };
type Hello = { protocolVersion: number; agentCapabilities?: { loadSession?: boolean; promptCapabilities?: { image?: boolean }; sessionCapabilities?: { close?: object } } };
type Setup = {
  sessionId?: string;
  models?: { availableModels?: { modelId: string; name: string }[]; currentModelId?: string };
  modes?: { currentModeId?: string; availableModes?: { id: string }[] };
  configOptions?: ConfigOption[];
};
type PermissionRequest = {
  toolCall?: { kind?: string; locations?: { path?: string }[] };
  options?: { optionId: string; kind: string }[];
};

class AcpError extends Error {
  constructor(public readonly code: number, message: string, public readonly details?: string) { super(message); }
}

function config(setup: Setup, category: "model" | "thought_level") {
  return setup.configOptions?.find(item => item.category === category && Array.isArray(item.options));
}

function choices(option?: ConfigOption): AgentChoice[] {
  return (option?.options ?? []).flatMap(value => "options" in value ? value.options : [value])
    .map(value => ({ id: value.value, name: value.name }));
}

class AcpProcess {
  private readonly pending = new Map<number, Resolve>();
  private nextId = 0;
  private failure?: Error;
  private stderr = "";
  private session?: string;
  private readonly replyId = randomUUID();
  private readonly exited: Promise<void>;
  private closed = false;
  private readonly tools = new Map<string, NonNullable<AgentUpdate["update"]>>();

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly turn?: AgentPrompt,
    private readonly updateConfig?: (configOptions: ConfigOption[]) => void) {
    child.stderr.setEncoding("utf8").on("data", text => { this.stderr = (this.stderr + text).slice(-2000); });
    child.on("error", error => this.fail(error));
    child.stdin.on("error", error => this.fail(error));
    this.exited = new Promise(resolve => child.once("close", code => {
      this.closed = true;
      this.fail(new Error(this.stderr.trim() || `The ACP connection closed (${code}).`));
      resolve();
    }));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
      try { this.receive(JSON.parse(line)); } catch { this.fail(new Error("The ACP response is not valid JSON-RPC.")); }
    });
  }

  private write(message: object) {
    if (!this.failure) this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  request<T>(method: string, params: object, timeout = 25_000) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.fail(new Error(
        `The ACP agent did not respond to ${method}.${this.stderr.trim() ? "\n" + this.stderr.trim() : ""}`,
      )), timeout);
      this.pending.set(id, {
        resolve: result => { clearTimeout(timer); resolve(result as T); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.write({ id, method, params });
    });
  }

  async prompt(id: string, prompt: string, images = false) {
    this.session = id;
    const signal = this.turn!.signal;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      this.write({ method: "session/cancel", params: { sessionId: id } });
      timeout ??= setTimeout(() => this.fail(new Error("The ACP turn was stopped.")), 1500);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const content: object[] = [{ type: "text", text: prompt }];
      for (const attachment of this.turn!.attachments ?? []) {
        for (const file of attachment.files) {
          content.push({ type: "resource_link", name: file.name, uri: pathToFileURL(file.path).href, ...(file.mimeType ? { mimeType: file.mimeType } : {}) });
          if (images && file.mimeType) content.push({ type: "image", mimeType: file.mimeType, data: (await readFile(file.path)).toString("base64") });
        }
      }
      return await this.request<{ stopReason: string }>("session/prompt", { sessionId: id, prompt: content }, 150_000);
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      this.session = undefined;
    }
  }

  private receive(message: Rpc) {
    if (message.method) {
      if (message.id !== undefined) void this.respond(message);
      else if (message.method === "session/update") this.update(message.params as AgentUpdate);
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.error) entry?.reject(new AcpError(message.error.code, message.error.message, message.error.data?.details));
    else entry?.resolve(message.result);
  }

  private update(message: AgentUpdate) {
    const item = message?.update;
    if (!this.session || message?.sessionId !== this.session || !item) return;
    if (item.sessionUpdate === "agent_message_chunk" && item.content?.type === "text" && item.content.text) {
      this.turn?.onMessage({ id: this.replyId, role: "assistant", text: item.content.text }, true);
    } else if (["tool_call", "tool_call_update"].includes(item.sessionUpdate ?? "") && item.toolCallId) {
      const update = { ...this.tools.get(item.toolCallId), ...Object.fromEntries(Object.entries(item).filter(([, value]) => value != null)) };
      this.tools.set(item.toolCallId, update);
      const activity = toolActivity(update.kind ?? update.title ?? "Tool", update.rawInput, activityStatus(update.status), JSON.stringify(update.rawOutput ?? update.content));
      activity.title = update.title ?? activity.title;
      this.turn?.onMessage({ id: item.toolCallId, role: "activity", text: activity.title, activity });
    } else if (item.sessionUpdate === "config_option_update" && item.configOptions) {
      this.updateConfig?.(item.configOptions);
    }
  }

  private async respond(message: Rpc) {
    try {
      const params = message.params as PermissionRequest & { sessionId?: string; path?: string; text?: string; line?: number; limit?: number };
      if (!this.turn || !this.session || params?.sessionId !== this.session || this.turn.signal.aborted) {
        throw new AcpError(-32602, "Invalid ACP session");
      }
      let result: object;
      switch (message.method) {
        case "session/request_permission":
          result = await this.permission(params);
          break;
        case "fs/read_text_file":
        case "fs/write_text_file": {
          if (typeof params.path !== "string" || !isAbsolute(params.path)) throw new AcpError(-32602, "Expected absolute draft path");
          const requested = resolve(params.path);
          const attachment = this.turn.attachments?.flatMap(item => item.files).find(file => file.path === requested);
          if (attachment && message.method === "fs/write_text_file") throw new AcpError(-32602, "Attachments are read-only.");
          const path = attachment?.path ?? await checkedPath(this.turn.cwd, projectPath(relative(this.turn.cwd, requested)));
          if (message.method === "fs/write_text_file") {
            if (typeof params.text !== "string" || Buffer.byteLength(params.text) > 4 * 1024 * 1024) throw new AcpError(-32602, "Invalid file content");
            await writeTextAtomically(path, params.text);
            result = {};
          } else {
            const file = await info(path);
            if (!file?.isFile() || file.size > 4 * 1024 * 1024) throw new AcpError(-32602, "Invalid draft file");
            const text = await readFile(path, "utf8");
            const start = Math.max(0, (params.line ?? 1) - 1);
            result = { content: text.split("\n").slice(start, params.limit === undefined ? undefined : start + params.limit).join("\n") };
          }
          break;
        }
        default:
          throw new AcpError(-32601, "Unsupported ACP client method");
      }
      this.write({ id: message.id, result });
    } catch (error) {
      this.write({ id: message.id, error: { code: error instanceof AcpError ? error.code : -32602,
        message: error instanceof Error ? error.message : "Rejected by Morka" } });
    }
  }

  private async permission(request: PermissionRequest) {
    const locations = request.toolCall?.locations;
    const once = request.options?.find(option => option.kind === "allow_once");
    const reject = request.options?.find(option => option.kind === "reject_once");
    let selected = reject;
    if (once && request.toolCall?.kind === "edit" && locations?.length) {
      const scoped = await Promise.all(locations.map(async ({ path }) => {
        if (typeof path !== "string" || !isAbsolute(path)) return false;
        try {
          const { cwd } = this.turn!;
          await checkedPath(cwd, projectPath(relative(cwd, resolve(path))));
          return true;
        } catch { return false; }
      }));
      if (scoped.every(Boolean)) selected = once;
    }
    // A declined request should settle agents' approval wait. "Cancelled" means
    // the client has detached or the turn is being cancelled.
    return { outcome: selected ? { outcome: "selected", optionId: selected.optionId } : { outcome: "cancelled" } };
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (!this.closed) stopAgent(this.child.pid);
  }

  abort() { this.fail(new Error("The ACP connection was closed.")); }

  async close() {
    this.abort();
    if (this.closed) return;
    await Promise.race([this.exited, delay(900, undefined, { ref: false })]);
    if (!this.closed) {
      stopAgent(this.child.pid, "SIGKILL");
      await Promise.race([this.exited, delay(900, undefined, { ref: false })]);
    }
  }
}

export class AcpConnection implements AgentConnection {
  private process?: AcpProcess;
  private discovery?: Promise<void>;
  private discoveryProcess?: AcpProcess;
  private setup: Setup = {};
  private discovered = false;

  constructor(private readonly profile: AcpProfile, private readonly skills: string,
    private readonly state: string, private readonly projectRoot: string) {}

  private get setupTimeout() { return this.profile.id === "hermes" ? 120_000 : 25_000; }

  private async initialize(process: AcpProcess) {
    const hello = await process.request<Hello>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "morka", version: "0.1.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    }, this.setupTimeout);
    if (hello.protocolVersion !== 1) throw new Error(`Unsupported ACP version: ${hello.protocolVersion}.`);
    return hello;
  }

  async options(): Promise<AgentOptions> {
    if (!this.discovered && !this.process) {
      this.discovery ??= this.discover().finally(() => { this.discovery = undefined; });
      await this.discovery;
    }
    const model = config(this.setup, "model");
    const effort = config(this.setup, "thought_level");
    return {
      models: model ? choices(model) : this.setup.models?.availableModels?.map(item => ({ id: item.modelId, name: item.name })) ?? [],
      defaultModel: model?.currentValue ?? this.setup.models?.currentModelId,
      efforts: choices(effort).map(choice => choice.name === choice.id || /^Thinking: /i.test(choice.name)
        ? effortChoice(choice.id) : choice),
      defaultEffort: effort?.currentValue,
    };
  }

  private async discover() {
    await mkdir(this.state, { recursive: true, mode: 0o700 });
    const cwd = await mkdtemp(join(this.state, "model-options-"));
    let process: AcpProcess | undefined;
    try {
      process = new AcpProcess(await spawnAcp(this.profile, cwd, this.state, this.projectRoot, "catalog"));
      this.discoveryProcess = process;
      const hello = await this.initialize(process);
      const setup = await process.request<Setup>("session/new", { cwd, mcpServers: [] }, this.setupTimeout);
      if (!setup.sessionId) throw new Error("The ACP agent did not return a session ID.");
      this.setup = setup;
      this.discovered = true;
      if (hello.agentCapabilities?.sessionCapabilities?.close) {
        await process.request("session/close", { sessionId: setup.sessionId }, 3500).catch(() => {});
      }
    } finally {
      await process?.close();
      this.discoveryProcess = undefined;
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private async applyOptions(process: AcpProcess, id: string, setup: Setup | undefined, turn: AgentPrompt) {
    const current = { ...this.setup, ...setup,
      models: setup?.models ?? this.setup.models,
      configOptions: setup?.configOptions ?? this.setup.configOptions };
    const model = config(current, "model");
    if (turn.model) {
      if (model && choices(model).some(item => item.id === turn.model)) {
        if (config(setup ?? {}, "model")?.currentValue !== turn.model) {
          const updated = await process.request<Setup>("session/set_config_option", { sessionId: id, configId: model.id, value: turn.model });
          current.configOptions = updated?.configOptions ?? current.configOptions;
        }
      } else if (!model && current.models?.availableModels?.some(item => item.modelId === turn.model)) {
        if (setup?.models?.currentModelId !== turn.model) {
          await process.request("session/set_model", { sessionId: id, modelId: turn.model });
        }
      } else throw new Error("The selected model is unavailable for this ACP session.");
    }
    const effort = config(current, "thought_level");
    if (turn.effort) {
      if (!effort || !choices(effort).some(item => item.id === turn.effort)) {
        throw new Error("The selected reasoning effort is unavailable for this ACP session.");
      }
      if ((setup?.configOptions ? effort.currentValue : undefined) !== turn.effort) {
        const updated = await process.request<Setup>("session/set_config_option", { sessionId: id, configId: effort.id, value: turn.effort });
        current.configOptions = updated?.configOptions ?? current.configOptions;
      }
    }
    this.setup = current;
    this.discovered = true;
  }

  async prompt(turn: AgentPrompt) {
    turn.signal.throwIfAborted();
    if (this.discovery) {
      const abortProbe = () => this.discoveryProcess?.abort();
      turn.signal.addEventListener("abort", abortProbe, { once: true });
      try { await this.discovery.catch(() => {}); }
      finally { turn.signal.removeEventListener("abort", abortProbe); }
    }
    turn.signal.throwIfAborted();
    if (this.process) throw new Error("The ACP agent is already responding.");
    const child = await spawnAcp(this.profile, turn.cwd, this.state, this.projectRoot, "chat", turn.attachments?.map(attachment => attachment.path));
    const process = new AcpProcess(child, turn, configOptions => { this.setup = { ...this.setup, configOptions }; });
    this.process = process;
    const setupTimeout = this.profile.id === "hermes" ? 120_000 : 25_000;
    const abortSetup = () => process.abort();
    turn.signal.addEventListener("abort", abortSetup, { once: true });
    try {
      turn.signal.throwIfAborted();
      const hello = await this.initialize(process);
      const native = hello.agentCapabilities?.loadSession ? turn.sessionId : undefined;
      const args = { cwd: turn.cwd, mcpServers: [] };
      let loaded = false;
      let setup: Setup | undefined;
      if (native) {
        try {
          setup = await process.request("session/load", { ...args, sessionId: native }, setupTimeout);
          loaded = true;
        } catch (error) {
          if (!(error instanceof AcpError) || !(
            [-32601, -32602, -32002].includes(error.code) ||
            (this.profile.id === "hermes" && error.details === "not_found")
          )) throw error;
        }
      }
      if (!loaded) setup = await process.request("session/new", args, setupTimeout);
      const id = loaded ? native : setup?.sessionId;
      if (!id) throw new Error("The ACP agent did not return a session ID.");
      if (hello.agentCapabilities?.loadSession && !loaded) await turn.storeSession(id);
      const edits = setup?.modes?.availableModes?.find(mode => ["accept_edits", "acceptEdits"].includes(mode.id));
      if (edits && edits.id !== setup?.modes?.currentModeId) {
        await process.request("session/set_mode", { sessionId: id, modeId: edits.id }, setupTimeout);
      }
      await this.applyOptions(process, id, setup, turn);
      const prompt = await buildPrompt({ ...turn, history: loaded ? turn.historySinceSession : turn.history }, this.skills,
        "the project file editing tools", true);
      turn.signal.removeEventListener("abort", abortSetup);
      const result = await process.prompt(id, prompt, hello.agentCapabilities?.promptCapabilities?.image === true);
      if (turn.signal.aborted || result.stopReason === "cancelled") return "interrupted";
      if (result.stopReason !== "end_turn") throw new Error(`The ACP turn ended with status ${result.stopReason}.`);
      return "completed";
    } catch (error) {
      if (turn.signal.aborted) return "interrupted";
      throw error;
    } finally {
      turn.signal.removeEventListener("abort", abortSetup);
      await process.close();
      this.process = undefined;
    }
  }

  close() {
    void this.discoveryProcess?.close();
    void this.process?.close();
  }
}
