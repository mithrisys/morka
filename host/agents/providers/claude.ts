import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { ActionPrompt, AgentConnection, AgentPrompt } from "../contracts";
import { buildPrompt, effortChoice } from "../context";
import { agentLaunch } from "../process";
import { toolActivity } from "../activity";

const efforts = ["low", "medium", "high", "xhigh", "max"];
const models = ["default", "sonnet", "opus", "haiku"].map(id => ({
  id, name: id === "default" ? "Claude default" : id[0].toUpperCase() + id.slice(1), efforts: efforts.map(effortChoice),
}));

type Output = {
  type: string; subtype?: string; is_error?: boolean; result?: string; errors?: string[]; structured_output?: unknown;
  message?: { content?: { type: string; text?: string; name?: string; id?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown }[] };
  event?: {
    type: string; index?: number; content_block?: { type: string; name?: string; id?: string; input?: unknown }; delta?: { type: string; text?: string; partial_json?: string };
  };
};

export class ClaudeConnection implements AgentConnection {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  constructor(private readonly skillsRoot: string) {}

  async options(): Promise<AgentOptions> { return { models, defaultModel: "default" }; }

  async prompt(turn: AgentPrompt) {
    if (turn.model && !models.some(model => model.id === turn.model)) throw new Error("The selected Claude Code model is unavailable.");
    if (turn.effort && !efforts.includes(turn.effort)) throw new Error("The selected reasoning effort is unavailable for Claude Code.");
    const prompt = await buildPrompt(turn, this.skillsRoot, "Claude Code’s Edit and Write tools", false);
    const result = await this.run(turn.cwd, prompt, turn.signal, turn);
    return result ? "completed" : "interrupted";
  }

  async runAction(turn: ActionPrompt) {
    const skill = await readFile(join(turn.skillRoot, turn.skill, "SKILL.md"), "utf8");
    const output = await this.run(turn.cwd, skill + "\n\n" + turn.text, turn.signal, undefined, turn.schema);
    if (!output || output.structured_output === undefined) throw new Error("Claude Code did not return structured output.");
    return JSON.stringify(output.structured_output);
  }

  private async run(cwd: string, prompt: string, signal: AbortSignal, turn?: AgentPrompt, schema?: object) {
    signal.throwIfAborted();
    const args = [
      "--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages",
      "--no-session-persistence", "--safe-mode", "--restricted", "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}', "--permission-prompts", "none",
      "--permission-mode", turn ? "acceptEdits" : "dontAsk",
      "--tools", turn ? "Read,Glob,Grep,Edit,Write" : "",
    ];
    if (turn?.model && turn.model !== "default") args.push("--model", turn.model);
    if (turn?.effort) args.push("--effort", turn.effort);
    if (schema) args.push("--json-schema", JSON.stringify(schema));
    const attachments = turn?.attachments?.map(attachment => attachment.kind === "folder" ? attachment.path : dirname(attachment.path)) ?? [];
    for (const path of attachments) args.push("--add-dir", path);
    const cli = await agentLaunch("claude", args);
    signal.throwIfAborted();
    return new Promise<Output | undefined>((resolve, reject) => {
      const repositories = process.platform === "darwin" ? [turn?.repository, turn?.otherRepository, ...attachments].filter(Boolean) : [];
      const denied = repositories.map(path => `(subpath ${JSON.stringify(path)})`).join(" ");
      const sandbox = denied && `(version 1) (allow default) (deny file-write* ${denied})`;
      const child = spawn(sandbox ? "/usr/bin/sandbox-exec" : cli.command,
        sandbox ? ["-p", sandbox, cli.command, ...cli.args] : cli.args, {
        cwd, env: cli.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
      this.children.add(child);
      let finalText = "";
      let stderr = "";
      let settled = false;
      const replyId = randomUUID();
      const tools = new Map<string, { name: string; input?: unknown; json: string }>();
      const blocks = new Map<number, string>();
      const reportTool = (id: string, status: ChatActivity["status"], output?: unknown) => {
        const tool = tools.get(id);
        if (tool) turn?.onMessage({ id, role: "activity", text: tool.name,
          activity: toolActivity(tool.name, tool.input, status, typeof output === "string" ? output : JSON.stringify(output, null, 2)) });
      };
      const stop = () => {
        child.kill("SIGTERM");
        finish();
      };
      const finish = (output?: Output, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        if (error) reject(error);
        else resolve(output);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(undefined, new Error("Claude Code did not respond."));
      }, 120_000);
      signal.addEventListener("abort", stop, { once: true });
      child.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-1500); });
      child.stdin.on("error", () => {});
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(undefined, error.code === "ENOENT" ? new Error("Claude Code was not found. Set CLAUDE_BIN to the CLI path.") : error);
      });
      child.on("close", code => {
        this.children.delete(child);
        finish(undefined, new Error(stderr.trim() || `Claude Code exited before responding (${code}).`));
      });
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
        if (settled) return;
        let output: Output;
        try { output = JSON.parse(line); } catch { return; }
        timer.refresh();
        const event = output.event;
        if (output.type === "stream_event") {
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            turn?.onMessage({ id: replyId, role: "assistant", text: event.delta.text }, true);
          }
          if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
            const id = event.content_block.id ?? randomUUID();
            tools.set(id, { name: event.content_block.name ?? "Tool", input: event.content_block.input, json: "" });
            blocks.set(event.index ?? 0, id);
            reportTool(id, "running");
          }
          const toolId = blocks.get(event?.index ?? -1);
          const tool = toolId && tools.get(toolId);
          if (tool && event?.delta?.type === "input_json_delta") tool.json += event.delta.partial_json ?? "";
          if (tool && event?.type === "content_block_stop") {
            try { tool.input = JSON.parse(tool.json); } catch { /* The full assistant message can supply the input. */ }
            reportTool(toolId!, "running");
            blocks.delete(event.index ?? 0);
          }
        } else if (output.type === "assistant") {
          const blocks = output.message?.content ?? [];
          for (const block of blocks.filter(block => block.type === "tool_use" && block.id)) {
            tools.set(block.id!, { name: block.name ?? "Tool", input: block.input, json: "" });
            reportTool(block.id!, "running");
          }
          const text = blocks.filter(block => block.type === "text").map(block => block.text ?? "").join("");
          if (text) finalText = text;
        } else if (output.type === "user") {
          for (const block of output.message?.content ?? []) {
            if (block.type === "tool_result" && block.tool_use_id) reportTool(block.tool_use_id, block.is_error ? "failed" : "completed", block.content);
          }
        } else if (output.type === "result") {
          const error = output.is_error ? output.errors?.join("\n") || output.result || finalText || "Claude Code could not complete the response." : undefined;
          const reply = output.result || finalText;
          if (reply && !error) turn?.onMessage({ id: replyId, role: "assistant", text: reply });
          finish(output, error ? new Error(error) : undefined);
          const exitTimer = setTimeout(() => child.kill(), 5000).unref();
          child.once("close", () => clearTimeout(exitTimer));
        }
      });
      if (signal.aborted) stop();
      else child.stdin.end(prompt);
    });
  }

  close() {
    for (const child of this.children) child.kill("SIGTERM");
  }
}
