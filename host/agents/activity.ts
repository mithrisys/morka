import { basename } from "node:path";

export function activityStatus(status?: string): ChatActivity["status"] {
  if (["completed", "success", "succeeded"].includes(status ?? "")) return "completed";
  if (["failed", "error", "declined"].includes(status ?? "")) return "failed";
  if (["cancelled", "canceled", "interrupted"].includes(status ?? "")) return "stopped";
  return "running";
}

export function toolActivity(name: string, input: unknown, status: ChatActivity["status"], output?: string): ChatActivity {
  const values = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const path = [values.file_path, values.path, values.filename].find(value => typeof value === "string") as string | undefined;
  const kind = /read|view|open/i.test(name) ? "read" : /edit|write|patch/i.test(name) ? "edit"
    : /search|grep|glob|find/i.test(name) ? "search" : /command|bash|terminal|exec/i.test(name) ? "command"
      : /plan/i.test(name) ? "plan" : "tool";
  const labels = { read: "Read", edit: "Edit", search: "Search", command: "Run", plan: "Plan", tool: name };
  const target = path ? basename(path) : [values.pattern, values.query, values.command].find(value => typeof value === "string");
  const title = (labels[kind] + (target ? ` · ${target}` : "")).slice(0, 180);
  const detail = [input === undefined ? undefined : JSON.stringify(input, null, 2), output].filter(Boolean).join("\n\n").slice(-32_000);
  return { kind, status, title, detail: detail || undefined };
}
