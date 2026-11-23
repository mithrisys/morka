import Ajv from "ajv";
import { projectPath, type Files } from "./files";

export const previewFile = "morka.preview.json";
export type PreviewStep =
  | { kind: "fill"; selector: string; value: string }
  | { kind: "key"; selector: string; key: string }
  | { kind: "click"; selector: string }
  | { kind: "expect"; selector: string; text?: string };
export type PreviewScenario = {
  route?: string; entry?: string; publicRoot?: string; steps: PreviewStep[]; watch?: string[];
  actions?: Record<string, unknown>; responses?: Record<string, unknown>;
};

const string = { type: "string", minLength: 1, maxLength: 1024 };
const ajv = new Ajv();
const validate = ajv.compile({
  type: "object", required: ["steps"], additionalProperties: false,
  properties: {
    route: string, entry: string, publicRoot: string,
    watch: { type: "array", maxItems: 100, uniqueItems: true, items: string },
    actions: { type: "object", propertyNames: { pattern: "^[a-z0-9][a-z0-9-]{0,62}$" } },
    responses: { type: "object", propertyNames: { pattern: "^(GET|POST|PUT|PATCH|DELETE) /" } },
    steps: { type: "array", minItems: 1, maxItems: 40, items: { oneOf:
      Object.entries({
        click: {}, fill: { value: { type: "string", maxLength: 4096 } },
        key: { key: { enum: ["Enter", "Space", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"] } },
        expect: { text: string },
      }).map(([kind, fields]) => ({ type: "object", additionalProperties: false,
        required: ["kind", "selector", ...(kind === "expect" ? [] : Object.keys(fields))],
        properties: { kind: { const: kind }, selector: string, ...fields } })) } },
  },
});

export function readPreview(files: Files): PreviewScenario | undefined {
  const bytes = files.get(previewFile);
  if (!bytes) return;
  try {
    if (bytes.length > 65536) throw Error("Maximum scenario size is 64 KiB.");
    const scenario = JSON.parse(bytes.toString());
    if (!validate(scenario)) throw Error(ajv.errorsText(validate.errors));
    const value = scenario as PreviewScenario;
    const route = value.route ?? "/";
    if (!route.startsWith("/") || new URL(route, "https://preview.invalid").origin !== "https://preview.invalid") throw Error("Use an app-relative route.");
    for (const path of [value.entry, value.publicRoot, ...value.watch ?? []]) if (path !== undefined) projectPath(path);
    if (!value.steps.some(step => step.kind === "expect")) throw Error("Include an expect step for the user-visible outcome.");
    return value;
  } catch (error) {
    throw Error(previewFile + ": " + (error instanceof Error ? error.message : error));
  }
}

export function firstWorkflow(previous: Files, next: Files) {
  const entry = previous.get("index.html");
  return entry?.includes("<body></body>") && !previous.get("main.js")?.length &&
    (!next.get("index.html")?.equals(entry) || Boolean(next.get("main.js")?.length));
}

export function reviewTiming(previous: Files, changed: string[], scenario?: PreviewScenario, full = false) {
  if (!scenario) return;
  if (full || !previous.has(previewFile)) return "required";
  if (changed.every(path => path.endsWith(".css"))) return;
  if (changed.includes(previewFile) || scenario.watch?.some(path => changed.includes(path))) return "background";
}
