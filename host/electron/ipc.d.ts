type ChatSession = { id: string; title: string; providerId?: string };
type ChatIndex = { selected?: string; chats: ChatSession[] };
type ChatAttachment = { id: string; name: string; kind: "file" | "folder"; size: number; fileCount: number; omitted?: number };
type ChatActivity = {
  kind: "run" | "read" | "edit" | "search" | "command" | "tool" | "plan";
  status: "running" | "completed" | "failed" | "stopped";
  title: string; detail?: string; startedAt?: number; completedAt?: number;
};
type ChatMessage = {
  id: string; role: "user" | "assistant" | "activity"; text: string; providerId?: string; providerName?: string;
  turnId?: string; attachments?: ChatAttachment[]; activity?: ChatActivity;
};
type ChatEvent = { chatId: string; message: ChatMessage; append?: boolean };
type AgentChoice = { id: string; name: string };
type ChatModel = AgentChoice & { efforts?: AgentChoice[]; defaultEffort?: string };
type AgentOptions = { models: ChatModel[]; defaultModel?: string; efforts?: AgentChoice[]; defaultEffort?: string };
type AgentProviderInfo = { id: string; name: string };
type AgentAccountStatus = { state: "ready" | "signed-out" | "missing" | "unavailable" | "managed"; install?: string; login?: string };
type AgentSetupInfo = AgentProviderInfo & AgentAccountStatus & { supportsActions: boolean; authorized?: boolean };
type AgentSelection = { providerId: string; effort?: string };
type ChatTurnResult = { stopped?: boolean } | { error: string };
type ShadowPackageReference = { id: string; version: string; digest: string };
type ImportedShadow = ShadowPackageReference & { description: string };
type InstalledShadowInfo = { id: string; version: string; description?: string };
type ChatTargetInfo = { kind: "app" | "shadow"; name: string; directory?: string };
type RuntimeState = { status: "stopped" | "preparing" | "starting" | "running" | "stopping" | "error" | "upgrade"; detail?: string };
type AddonRequest =
  | { type: "runAgentAction"; action: unknown; input: unknown };
type AddonResult = { value?: unknown; error?: string };
type AppInstallResult = { path: string; openError: string } | { error: string };
type ProjectSourceKind = "folder" | "archive" | "git";
type MacUpdateState = { status: "idle" | "checking" | "current" }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "ready" | "installing"; version: string; detail?: string }
  | { status: "error"; detail: string };

interface Window {
  lab: {
    currentApp(): Promise<string | undefined>;
    installApp(name: string): Promise<AppInstallResult | undefined>;
    wakeProject(kind: ProjectSourceKind, gitUrl?: string): Promise<{ error: string } | undefined>;
    macUpdateState(): Promise<MacUpdateState | undefined>;
    checkMacUpdate(): Promise<void>;
    restartForMacUpdate(): Promise<void>;
    onMacUpdate(listener: (state: MacUpdateState) => void): void;
    getPreview(): Promise<string | undefined>;
    onPreview(listener: (url?: string) => void): void;
    onPreviewUpdating(listener: (updating: boolean) => void): void;
    runtimeState(): Promise<RuntimeState>;
    retryRuntime(): Promise<void>;
    onRuntimeState(listener: (state: RuntimeState) => void): void;
    importShadow(): Promise<ImportedShadow | { error: string } | undefined>;
    installedShadows(): Promise<InstalledShadowInfo[]>;
    removeShadow(id: string): Promise<boolean>;
    newShadow(name: string): Promise<boolean>;
    openShadow(): Promise<boolean>;
    onShadowsChanged(listener: () => void): void;
    chatTarget(): Promise<ChatTargetInfo>;
    listChats(): Promise<ChatIndex>;
    newChat(): Promise<ChatSession>;
    openChat(id: string): Promise<ChatMessage[]>;
    openLink(url: string): Promise<void>;
    attach(kind: "file" | "folder"): Promise<ChatAttachment[]>;
    attachDropped(files: File[]): Promise<ChatAttachment[]>;
    revealAttachment(id: string): Promise<void>;
    providers(): Promise<AgentProviderInfo[]>;
    agentSetup(): Promise<AgentSetupInfo[]>;
    clearAgentAccess(): Promise<void>;
    models(providerId?: string): Promise<ChatModel[]>;
    agentOptions(providerId?: string): Promise<AgentOptions>;
    send(id: string, message: string, model: string, shadow?: ImportedShadow, selection?: AgentSelection, attachments?: string[]): Promise<ChatTurnResult>;
    stop(id: string): Promise<void>;
    onChatEvent(listener: (event: ChatEvent) => void): void;
    getAgentActivity(): Promise<boolean>;
    onAgentActivity(listener: (active: boolean) => void): void;
    invokeAddon(url: string, request: AddonRequest): Promise<AddonResult>;
  };
}
