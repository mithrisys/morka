import type { AgentAttachment } from "./attachments";

export type ProjectContext = { instructions: Record<string, string | undefined>; paths: string[]; shadow?: string; target?: "app" | "shadow"; activationFailure?: string };
export type AgentPrompt = {
  cwd: string;
  repository?: string;
  otherRepository?: string;
  sessionId?: string;
  text: string;
  attachments?: AgentAttachment[];
  model?: string;
  effort?: string;
  files: Readonly<Record<string, string>>;
  project: ProjectContext;
  history: ChatMessage[];
  historySinceSession: ChatMessage[];
  skills: string[];
  signal: AbortSignal;
  onMessage: (message: ChatMessage, append?: boolean) => void;
  storeSession: (id: string) => Promise<void>;
};
export type ActionPrompt = {
  cwd: string; skillRoot: string; skill: string; text: string; schema: object;
  signal: AbortSignal;
};
export type AgentConnection = {
  options(): Promise<AgentOptions>;
  prompt(turn: AgentPrompt): Promise<"completed" | "interrupted">;
  runAction?(turn: ActionPrompt): Promise<string>;
  close(): void;
};
