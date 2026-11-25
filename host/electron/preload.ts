import { contextBridge, ipcRenderer, webUtils } from "electron";

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("lab", {
    currentApp: (): Promise<string | undefined> => ipcRenderer.invoke("instance:current"),
    installApp: (name: string): Promise<AppInstallResult | undefined> => ipcRenderer.invoke("instance:install", name),
    wakeProject: (kind: ProjectSourceKind, gitUrl?: string): Promise<{ error: string } | undefined> =>
      ipcRenderer.invoke("instance:wake", kind, gitUrl),
    getPreview: (): Promise<string | undefined> => ipcRenderer.invoke("canvas:current"),
    onPreview: (listener: (url?: string) => void) => {
      ipcRenderer.on("canvas:update", (_event, url) => listener(url));
    },
    onPreviewUpdating: (listener: (updating: boolean) => void) => {
      ipcRenderer.on("canvas:updating", (_event, updating) => listener(updating));
    },
    runtimeState: (): Promise<RuntimeState> => ipcRenderer.invoke("runtime:state"),
    retryRuntime: (): Promise<void> => ipcRenderer.invoke("runtime:retry"),
    onRuntimeState: (listener: (state: RuntimeState) => void) => {
      ipcRenderer.on("runtime:state", (_event, state) => listener(state));
    },
    importShadow: () => ipcRenderer.invoke("shadow:import"),
    installedShadows: (): Promise<InstalledShadowInfo[]> => ipcRenderer.invoke("shadow:list"),
    removeShadow: (id: string): Promise<boolean> => ipcRenderer.invoke("shadow:remove", id),
    newShadow: (name: string): Promise<boolean> => ipcRenderer.invoke("shadow:new", name),
    openShadow: (): Promise<boolean> => ipcRenderer.invoke("shadow:open"),
    onShadowsChanged: (listener: () => void) => ipcRenderer.on("shadow:changed", () => listener()),
    chatTarget: (): Promise<ChatTargetInfo> => ipcRenderer.invoke("chat:target"),
    listChats: (): Promise<ChatIndex> => ipcRenderer.invoke("chat:list"),
    newChat: (): Promise<ChatSession> => ipcRenderer.invoke("chat:new"),
    openChat: (id: string): Promise<ChatMessage[]> => ipcRenderer.invoke("chat:open", id),
    openLink: (url: string): Promise<void> => ipcRenderer.invoke("chat:open-link", url),
    attach: (kind: "file" | "folder"): Promise<ChatAttachment[]> => ipcRenderer.invoke("chat:attach", kind),
    attachDropped: (files: File[]): Promise<ChatAttachment[]> => ipcRenderer.invoke("chat:attach-paths", files.map(file => webUtils.getPathForFile(file))),
    revealAttachment: (id: string): Promise<void> => ipcRenderer.invoke("chat:attachment-reveal", id),
    providers: (): Promise<AgentProviderInfo[]> => ipcRenderer.invoke("chat:providers"),
    agentSetup: (): Promise<AgentSetupInfo[]> => ipcRenderer.invoke("agent:setup"),
    clearAgentAccess: (): Promise<void> => ipcRenderer.invoke("agent:clear-access"),
    agentOptions: (providerId?: string): Promise<AgentOptions> => ipcRenderer.invoke("chat:agent-options", providerId),
    models: async (providerId?: string): Promise<ChatModel[]> => (await ipcRenderer.invoke("chat:agent-options", providerId)).models,
    send: (id: string, message: string, model: string, shadow?: ImportedShadow, selection?: AgentSelection, attachments?: string[]): Promise<ChatTurnResult> =>
      ipcRenderer.invoke("chat:send", id, message, model, shadow, selection, attachments),
    stop: (id: string): Promise<void> => ipcRenderer.invoke("chat:stop", id),
    onChatEvent: (listener: (event: ChatEvent) => void) => {
      ipcRenderer.on("chat:event", (_event, data) => listener(data));
    },
    getAgentActivity: (): Promise<boolean> => ipcRenderer.invoke("agent:activity"),
    onAgentActivity: (listener: (active: boolean) => void) => {
      ipcRenderer.on("agent:activity", (_event, active) => listener(active));
    },
    invokeAddon: (url: string, request: AddonRequest): Promise<AddonResult> =>
      ipcRenderer.invoke("addon:invoke", url, request),
  });
}
