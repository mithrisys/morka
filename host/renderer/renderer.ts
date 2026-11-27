import { renderMarkdown } from "./markdown.js";
import { ActivityFeed } from "./activity.js";

const preview = document.querySelector<HTMLIFrameElement>("#preview")!;
const workspace = document.querySelector<HTMLElement>(".workspace")!;
const chatPanel = document.querySelector<HTMLElement>("#chat-panel")!;
const chatToggle = document.querySelector<HTMLButtonElement>("#chat-toggle")!;
const runtimeButton = document.querySelector<HTMLButtonElement>("#runtime-retry")!;
const runtimeStatus = document.querySelector<HTMLSpanElement>("#runtime-status")!;
const shadowButton = document.querySelector<HTMLButtonElement>("#shadows-toggle")!;
const shadowDialog = document.querySelector<HTMLDialogElement>("#shadows-dialog")!;
const shadowList = document.querySelector<HTMLUListElement>("#shadows-list")!;
const shadowStatus = document.querySelector<HTMLElement>("#shadows-status")!;
const shadowCreate = document.querySelector<HTMLFormElement>("#shadow-create")!;
const shadowNew = document.querySelector<HTMLButtonElement>("#shadow-new")!;
const shadowName = document.querySelector<HTMLInputElement>("#shadow-name")!;
const shadowWorkspace = new URLSearchParams(location.search).get("scope") === "shadow";
const composer = document.querySelector<HTMLFormElement>("#composer")!;
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt")!;
const sendButton = document.querySelector<HTMLButtonElement>("#send")!;
const stopButton = document.querySelector<HTMLButtonElement>("#stop")!;
const newButton = document.querySelector<HTMLButtonElement>("#new-chat")!;
const chatNavigation = document.querySelector<HTMLElement>(".chat-navigation")!;
const chatPicker = document.querySelector<HTMLSelectElement>("#chat-picker")!;
const modelPicker = document.querySelector<HTMLSelectElement>("#model")!;
const providerPicker = document.querySelector<HTMLSelectElement>("#agent-provider")!;
const effortPicker = document.querySelector<HTMLSelectElement>("#effort")!;
const feed = document.querySelector<HTMLDivElement>("#feed")!;
const intro = document.querySelector<HTMLDivElement>("#intro")!;
const transcript = document.querySelector<HTMLDivElement>("#transcript")!;
const attachmentList = document.querySelector<HTMLDivElement>("#pending-attachments")!;
const attachButton = document.querySelector<HTMLButtonElement>("#attach-toggle")!;
const attachmentMenu = document.querySelector<HTMLDivElement>("#attachment-menu")!;
const activityFeed = new ActivityFeed(transcript);
const attachmentDrafts = new Map<string, ChatAttachment[]>();
const statusText = document.querySelector<HTMLSpanElement>("#status")!;
const agentIndicator = document.querySelector<HTMLButtonElement>("#agent-indicator")!;
const agentStatus = document.querySelector<HTMLSpanElement>("#agent-status")!;
const bubbles = new Map<string, { element: HTMLDivElement; text: string }>();
const savedProviders = new Map<string, string>();
const preferences = new Map<string, { model: string; effort: string }>();
let agentOptions: AgentOptions = { models: [] };
let modelRequest = 0;
let activeChat: string | undefined;
let busy = false;
let turning = false;
let managingShadows = false;
let attaching = false;

function attachments() { return attachmentDrafts.get(activeChat ?? "new") ?? []; }

function attachmentChip(attachment: ChatAttachment, remove?: () => void) {
  const chip = document.createElement("div");
  chip.className = "attachment-chip";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "attachment-open";
  const size = attachment.size < 1024 ? `${attachment.size} B` : new Intl.NumberFormat("en", { style: "unit", unit: "kilobyte", maximumFractionDigits: 1 }).format(attachment.size / 1024);
  open.title = `${attachment.name} · ${attachment.fileCount} ${attachment.fileCount === 1 ? "file" : "files"} · ${size}` +
    (attachment.omitted ? ` · ${attachment.omitted} symbolic links or .git/node_modules entries omitted` : "") + " · Show in Finder";
  const icon = document.createElement("span");
  icon.className = `icon icon-${attachment.kind === "folder" ? "folder" : "document"}`;
  icon.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.textContent = attachment.name;
  open.append(icon, name);
  open.addEventListener("click", () => void window.lab.revealAttachment(attachment.id).catch(showError));
  chip.append(open);
  if (remove) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "attachment-remove";
    button.setAttribute("aria-label", `Remove ${attachment.name}`);
    button.disabled = busy;
    const close = document.createElement("span");
    close.className = "icon icon-close";
    close.setAttribute("aria-hidden", "true");
    button.append(close);
    button.addEventListener("click", remove);
    chip.append(button);
  }
  return chip;
}

function showAttachments() {
  attachmentList.replaceChildren(...attachments().map(attachment => attachmentChip(attachment, () => {
    attachmentDrafts.set(activeChat ?? "new", attachments().filter(item => item.id !== attachment.id));
    showAttachments();
    updateComposer();
  })));
  attachmentList.hidden = !attachments().length;
}

async function attach(task: () => Promise<ChatAttachment[]>) {
  if (busy || attaching) return;
  const key = activeChat ?? "new";
  attaching = true;
  attachmentMenu.hidePopover();
  statusText.textContent = "Adding attachments…";
  updateComposer();
  try {
    const added = await task();
    attachmentDrafts.set(key, [...attachmentDrafts.get(key) ?? [], ...added]);
    showAttachments();
  } catch (error) { showError(error); }
  finally { attaching = false; statusText.textContent = ""; updateComposer(); }
}

document.querySelector("#attach-files")!.addEventListener("click", () => void attach(() => window.lab.attach("file")));
document.querySelector("#attach-folder")!.addEventListener("click", () => void attach(() => window.lab.attach("folder")));
composer.addEventListener("dragover", event => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = busy || attaching ? "none" : "copy";
  composer.classList.toggle("dragging-files", !busy && !attaching);
});
composer.addEventListener("dragleave", event => {
  if (!composer.contains(event.relatedTarget as Node | null)) composer.classList.remove("dragging-files");
});
composer.addEventListener("drop", event => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  composer.classList.remove("dragging-files");
  const files = [...event.dataTransfer.files];
  void attach(() => window.lab.attachDropped(files));
});

if (shadowWorkspace) {
  document.body.classList.add("shadow-workspace");
  document.querySelector(".preview-panel")?.setAttribute("hidden", "");
  shadowButton.hidden = chatToggle.hidden = true;
  intro.querySelector("h2")!.textContent = "What should this Shadow do?";
  setChatOpen(true);
}
void window.lab.chatTarget().then(target => {
  const heading = document.querySelector<HTMLElement>("#chat-heading")!;
  heading.textContent = `${target.kind === "shadow" ? "Shadow" : "App"} · ${target.name}`;
  if (target.kind === "shadow") {
    document.title = heading.textContent;
    const wordmark = document.querySelector<HTMLElement>(".wordmark")!;
    wordmark.textContent = target.name;
    wordmark.title = target.directory ?? target.name;
  }
}).catch(showError);

function showAgentActivity(active: boolean) {
  const state = String(active);
  if (agentIndicator.dataset.active === state) return;
  agentIndicator.dataset.active = state;
  const label = active ? "Agent working" : "Agent idle";
  agentIndicator.title = `AI setup · ${label}`;
  agentStatus.textContent = label;
}

let receivedActivityUpdate = false;
window.lab.onAgentActivity(active => {
  receivedActivityUpdate = true;
  showAgentActivity(active);
});
void window.lab.getAgentActivity().then(active => {
  if (!receivedActivityUpdate) showAgentActivity(active);
}).catch(() => {});

function setChatOpen(open: boolean) {
  if (!open && chatPanel.contains(document.activeElement)) chatToggle.focus();
  workspace.dataset.chatOpen = String(open);
  chatPanel.inert = !open;
  chatToggle.setAttribute("aria-expanded", String(open));
  chatToggle.title = open ? "Hide chat" : "Show chat";
  chatToggle.setAttribute("aria-label", chatToggle.title);
  if (open) {
    if (!modelRequest) void loadAgentOptions();
    feed.scrollTop = feed.scrollHeight;
    promptInput.focus({ preventScroll: true });
  }
}

chatToggle.addEventListener("click", () => setChatOpen(workspace.dataset.chatOpen !== "true"));

function showRuntime(state: RuntimeState) {
  const labels = { stopped: "", preparing: "Preparing app update…", starting: "Starting app…", running: "",
    stopping: "Stopping project…", error: "Project failed to start", upgrade: "Runtime upgrade needs attention" };
  runtimeButton.hidden = state.status !== "error" && state.status !== "upgrade";
  runtimeButton.title = state.status === "upgrade" ? "Retry runtime upgrade" : "Retry starting app";
  runtimeButton.setAttribute("aria-label", runtimeButton.title);
  runtimeStatus.textContent = state.detail?.split("\n")[0] ?? labels[state.status];
  runtimeStatus.title = state.detail ?? "";
  runtimeStatus.hidden = !runtimeStatus.textContent;
}
if (!shadowWorkspace) {
  window.lab.onRuntimeState(showRuntime);
  void window.lab.runtimeState().then(showRuntime).catch(showError);
  runtimeButton.addEventListener("click", () => void window.lab.retryRuntime().catch(showError));
}

function updateComposer() {
  sendButton.disabled = busy || attaching || (!promptInput.value.trim() && !attachments().length);
  attachButton.disabled = busy || attaching;
  for (const button of attachmentList.querySelectorAll<HTMLButtonElement>(".attachment-remove")) button.disabled = busy || attaching;
  sendButton.hidden = turning;
  stopButton.hidden = !turning;
  newButton.disabled = busy;
  shadowButton.disabled = busy;
  chatPicker.disabled = busy || !chatPicker.options.length;
}

function showMessage(item: ChatMessage | { id: string; role: "error"; text: string }, append = false) {
  const following = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 72;
  if (item.role === "activity") {
    activityFeed.show(item);
    intro.hidden = true;
    if (following) feed.scrollTop = feed.scrollHeight;
    return;
  }
  let body = bubbles.get(item.id);
  if (!body) {
    const bubble = document.createElement("div");
    bubble.classList.add("message", item.role);
    if (item.role !== "user" && "providerName" in item && item.providerName) {
      const label = document.createElement("small");
      label.className = "message-provider";
      label.dir = "ltr";
      label.textContent = item.providerName;
      bubble.append(label);
    }
    const element = document.createElement("div");
    element.className = "message-content";
    element.dir = "auto";
    if (item.role === "assistant") element.classList.add("markdown");
    body = { element, text: "" };
    bubble.append(element);
    if (item.role === "user" && item.attachments?.length) {
      const list = document.createElement("div");
      list.className = "attachment-list message-attachments";
      list.append(...item.attachments.map(attachment => attachmentChip(attachment)));
      bubble.append(list);
    }
    bubbles.set(item.id, body);
    transcript.append(bubble);
  }
  body.text = append ? body.text + item.text : item.text;
  if (item.role === "assistant") renderMarkdown(body.element, body.text, item.id);
  else body.element.textContent = body.text;
  intro.hidden = true;
  if (following) feed.scrollTop = feed.scrollHeight;
}

transcript.addEventListener("click", event => {
  const link = (event.target as Element).closest<HTMLAnchorElement>(".markdown a[href]");
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href")!;
  if (href.startsWith("#")) {
    const target = document.getElementById(href.slice(1));
    if (target && link.closest(".message-content")?.contains(target)) target.scrollIntoView({ block: "nearest" });
  } else void window.lab.openLink(href).catch(showError);
});

function showError(error: unknown) {
  showMessage({ id: crypto.randomUUID(), role: "error", text: error instanceof Error ? error.message : String(error) });
}

function selectedProviderName() {
  return providerPicker.selectedOptions[0]?.textContent || "Codex";
}

function keepPreferences() {
  preferences.set(providerPicker.value, { model: modelPicker.value, effort: effortPicker.value });
}

function showEffort() {
  const model = agentOptions.models.find(item => item.id === (modelPicker.value || agentOptions.defaultModel));
  const efforts = model?.efforts ?? agentOptions.efforts ?? [];
  const defaultId = model?.defaultEffort ?? agentOptions.defaultEffort;
  const previous = preferences.get(providerPicker.value)?.effort;
  const defaultName = efforts.find(choice => choice.id === defaultId && choice.id !== "default")?.name;
  const fallback = efforts.length ? (defaultName ?? "Default") : "Unavailable";
  effortPicker.replaceChildren(new Option(fallback, ""),
    ...efforts.filter(choice => choice.id !== "default").map(choice => new Option(choice.name, choice.id)));
  if (previous && efforts.some(choice => choice.id === previous)) effortPicker.value = previous;
  effortPicker.disabled = !efforts.length;
  effortPicker.title = efforts.length ? "Reasoning effort for the next message" : "This agent or model does not offer adjustable reasoning effort.";
}

async function loadAgentOptions() {
  const request = ++modelRequest;
  const provider = providerPicker.value;
  agentOptions = { models: [] };
  modelPicker.disabled = true;
  effortPicker.disabled = true;
  modelPicker.replaceChildren(new Option("Loading…", ""));
  effortPicker.replaceChildren(new Option("Loading…", ""));
  modelPicker.title = `Loading models from ${selectedProviderName()}`;
  effortPicker.title = "Loading reasoning settings";
  try {
    const options = await window.lab.agentOptions(provider);
    if (request !== modelRequest) return;
    agentOptions = options;
    const defaultModel = options.models.find(model => model.id === options.defaultModel);
    const preferred = preferences.get(provider)?.model;
    const defaultLabel = defaultModel?.name ?? "Agent default";
    modelPicker.replaceChildren(new Option(defaultLabel, ""),
      ...options.models.filter(option => option.id !== "default").map(option => new Option(option.name, option.id)));
    if (preferred && options.models.some(option => option.id === preferred)) modelPicker.value = preferred;
    modelPicker.disabled = !options.models.length;
    modelPicker.title = options.models.length ? defaultLabel : "This agent uses its configured default model.";
    showEffort();
  } catch (error) {
    if (request !== modelRequest) return;
    modelPicker.replaceChildren(new Option("Model list unavailable", ""));
    modelPicker.title = error instanceof Error ? error.message : String(error);
    showEffort();
  }
}

providerPicker.addEventListener("change", () => void loadAgentOptions());
const setupDialog = document.querySelector<HTMLDialogElement>("#agent-setup")!;
const setupStatus = document.querySelector<HTMLElement>("#agent-setup-status")!;
const setupAccounts = document.querySelector<HTMLElement>("#agent-setup-accounts")!;
const setupRefresh = document.querySelector<HTMLButtonElement>("#agent-setup-refresh")!;
const setupReset = document.querySelector<HTMLButtonElement>("#agent-setup-reset")!;

async function refreshAccounts(reset = false) {
  setupRefresh.disabled = setupReset.disabled = true;
  setupStatus.textContent = reset ? "Removing saved access…" : "Checking local accounts…";
  setupStatus.hidden = false;
  try {
    if (reset) await window.lab.clearAgentAccess();
    const accounts = await window.lab.agentSetup();
    const labels = {
      ready: "Signed in",
      "signed-out": "Sign in from a terminal",
      missing: "Install from a terminal",
      unavailable: "Could not check this CLI. Update it or check its login status in a terminal.",
      managed: "Account managed by the agent’s own configuration",
    };
    setupAccounts.replaceChildren(...accounts.map(account => {
      const row = document.createElement("li");
      const title = document.createElement("strong");
      const state = document.createElement("p");
      title.textContent = account.name;
      state.textContent = labels[account.state] + (account.authorized ? " · App access allowed" : "");
      row.append(title, state);
      const command = account.state === "missing" ? account.install : account.state === "signed-out" ? account.login : undefined;
      if (command) {
        const code = document.createElement("code");
        code.textContent = command;
        row.append(code);
      }
      if (account.state === "ready") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "app-button";
        button.textContent = "Use in chat";
        button.addEventListener("click", () => {
          if (![...providerPicker.options].some(option => option.value === account.id)) return;
          providerPicker.value = account.id;
          void loadAgentOptions();
          setupDialog.close();
          setChatOpen(true);
        });
        row.append(button);
      }
      const capabilities = document.createElement("small");
      capabilities.textContent = account.supportsActions ? "Chat and in-app AI actions" : "Chat";
      row.append(capabilities);
      return row;
    }));
    setupReset.hidden = !accounts.some(account => account.authorized);
    setupStatus.hidden = true;
  } catch (error) {
    setupStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    setupRefresh.disabled = setupReset.disabled = false;
  }
}
agentIndicator.addEventListener("click", () => {
  setupDialog.showModal();
  if (!setupRefresh.disabled) void refreshAccounts();
});
setupRefresh.addEventListener("click", () => void refreshAccounts());
setupReset.addEventListener("click", () => void refreshAccounts(true));

modelPicker.addEventListener("change", () => {
  showEffort();
  keepPreferences();
});
effortPicker.addEventListener("change", keepPreferences);

async function refreshChats() {
  const index = await window.lab.listChats();
  savedProviders.clear();
  chatNavigation.hidden = !index.chats.length;
  chatPicker.replaceChildren(...index.chats.map(chat => {
    if (chat.providerId) savedProviders.set(chat.id, chat.providerId);
    return new Option(chat.title, chat.id);
  }));
  chatPicker.value = activeChat ?? "";
  updateComposer();
  return index;
}

function showChat(id: string, messages: ChatMessage[]) {
  activeChat = id;
  chatPicker.value = id;
  const preferred = savedProviders.get(id);
  if (preferred && [...providerPicker.options].some(option => option.value === preferred)) {
    providerPicker.value = preferred;
    if (!chatPanel.inert) void loadAgentOptions();
  }
  transcript.replaceChildren();
  bubbles.clear();
  activityFeed.clear();
  intro.hidden = messages.length > 0;
  for (const message of messages) showMessage(message);
  showAttachments();
}

async function createChat() {
  const chat = await window.lab.newChat();
  if (!activeChat && attachmentDrafts.has("new")) {
    attachmentDrafts.set(chat.id, attachmentDrafts.get("new")!);
    attachmentDrafts.delete("new");
  }
  showChat(chat.id, []);
  await refreshChats();
  return chat.id;
}

async function switchChat(task: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  statusText.textContent = "Opening chat…";
  updateComposer();
  try {
    await task();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
    statusText.textContent = "";
    chatPicker.value = activeChat ?? "";
    updateComposer();
  }
}

async function send(message: string, shadow?: ImportedShadow) {
  if ((!message && !attachments().length) || busy || attaching) return;
  const selection = { providerId: providerPicker.value, effort: effortPicker.value || undefined };
  const model = modelPicker.value || agentOptions.defaultModel || "";
  const agentName = selectedProviderName();
  busy = true;
  updateComposer();

  try {
    const id = activeChat ?? await createChat();
    promptInput.value = "";
    promptInput.focus();
    turning = true;
    feed.scrollTop = feed.scrollHeight;
    stopButton.disabled = false;
    statusText.textContent = `Waiting for ${agentName}…`;
    updateComposer();
    const result = await window.lab.send(id, message, model, shadow, selection, attachments().map(attachment => attachment.id));
    if ("error" in result) {
      showError(result.error);
    }
    await refreshChats();
    if (providerPicker.value === selection.providerId) void loadAgentOptions();
  } catch (error) {
    showError(error);
  } finally {
    turning = false;
    busy = false;
    statusText.textContent = "";
    updateComposer();
  }
}

window.lab.onChatEvent((event) => {
  if (turning && !stopButton.disabled && event.message.role !== "user") statusText.textContent = "";
  if (event.message.role === "user" && event.message.attachments?.length) {
    const sent = new Set(event.message.attachments.map(item => item.id));
    attachmentDrafts.set(event.chatId, (attachmentDrafts.get(event.chatId) ?? []).filter(item => !sent.has(item.id)));
    if (event.chatId === activeChat) showAttachments();
  }
  if (event.chatId === activeChat) showMessage(event.message, event.append);
});
stopButton.addEventListener("click", () => {
  if (!turning || !activeChat) return;
  stopButton.disabled = true;
  statusText.textContent = "Stopping…";
  void window.lab.stop(activeChat).catch(showError);
});
newButton.addEventListener("click", () => void switchChat(createChat));
async function shadowOperation(task: () => Promise<unknown>) {
  if (managingShadows) return;
  managingShadows = true;
  shadowStatus.hidden = true;
  const actions = [...shadowDialog.querySelectorAll<HTMLButtonElement>("button")];
  for (const action of actions) action.disabled = true;
  try {
    await task();
  } catch (error) {
    shadowStatus.textContent = error instanceof Error ? error.message : String(error);
    shadowStatus.hidden = false;
  } finally {
    managingShadows = false;
    for (const action of actions) action.disabled = false;
  }
}

async function refreshShadows() {
  const items = await window.lab.installedShadows();
  document.querySelector<HTMLElement>("#shadows-empty")!.hidden = Boolean(items.length);
  shadowList.replaceChildren(...items.map(item => {
    const row = document.createElement("li");
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${item.id} · v${item.version}`;
    info.append(name);
    if (item.description) {
      const description = document.createElement("small");
      description.textContent = item.description;
      info.append(description);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button shadow-remove";
    remove.title = `Remove ${item.id}`;
    remove.setAttribute("aria-label", `Remove ${item.id}`);
    const icon = document.createElement("span");
    icon.className = "icon icon-remove";
    icon.setAttribute("aria-hidden", "true");
    remove.append(icon);
    remove.addEventListener("click", () => void shadowOperation(async () => {
      if (await window.lab.removeShadow(item.id)) await refreshShadows();
    }));
    row.append(info, remove);
    return row;
  }));
}

shadowButton.addEventListener("click", () => {
  setShadowCreateOpen(false);
  shadowDialog.showModal();
  void shadowOperation(refreshShadows);
});
document.querySelector("#shadows-close")!.addEventListener("click", () => shadowDialog.close());
shadowDialog.addEventListener("cancel", event => { if (managingShadows) event.preventDefault(); });
window.lab.onShadowsChanged(() => {
  if (shadowDialog.open && !managingShadows) void shadowOperation(refreshShadows);
});
function setShadowCreateOpen(open: boolean) {
  shadowCreate.hidden = !open;
  shadowNew.setAttribute("aria-expanded", String(open));
}
shadowNew.addEventListener("click", () => {
  const open = Boolean(shadowCreate.hidden);
  setShadowCreateOpen(open);
  if (open) {
    shadowName.value = "";
    shadowName.focus();
  }
});
document.querySelector("#shadow-create-cancel")!.addEventListener("click", () => {
  setShadowCreateOpen(false);
  shadowNew.focus();
});
shadowCreate.addEventListener("submit", event => {
  event.preventDefault();
  void shadowOperation(async () => {
    if (await window.lab.newShadow(shadowName.value)) shadowDialog.close();
  });
});
document.querySelector("#shadow-open")!.addEventListener("click", () => void shadowOperation(async () => {
  if (await window.lab.openShadow()) shadowDialog.close();
}));
document.querySelector("#shadow-import")!.addEventListener("click", () => void shadowOperation(async () => {
    const shadow = await window.lab.importShadow();
    if (!shadow) return;
    if ("error" in shadow) throw new Error(shadow.error);
    shadowDialog.close();
    setChatOpen(true);
    await switchChat(createChat);
    await send(`Apply Shadow "${shadow.id}" version ${shadow.version} to this project. ` +
      "Adapt the package to this project's layout and register its skill and rule for future edits, even when there is no current match. " +
      "Ask if applying the current change needs clarification. Preserve the user's existing adaptations when updating.", shadow);
}));
chatPicker.addEventListener("change", () => {
  const id = chatPicker.value;
  void switchChat(async () => showChat(id, await window.lab.openChat(id)));
});

void switchChat(async () => {
  const providers = await window.lab.providers();
  providerPicker.replaceChildren(...providers.map(provider => new Option(provider.name, provider.id)));
  const index = await refreshChats();
  if (index.selected) showChat(index.selected, await window.lab.openChat(index.selected));
  if (!chatPanel.inert && (!index.selected || !savedProviders.has(index.selected)) && !modelRequest) void loadAgentOptions();
});


composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void send(promptInput.value.trim());
});
promptInput.addEventListener("input", updateComposer);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
window.addEventListener("message", async (event) => {
  const frame = preview.contentWindow;
  const source = preview.getAttribute("src");
  if (!source || !frame || event.source !== frame || event.data?.type !== "morka:addon-request") return;
  const expected = new URL(source).origin;
  if (event.origin !== expected) return;
  const { id, request } = event.data;
  if (!Number.isSafeInteger(id)) return;

  const url = preview.src;
  const result = await window.lab.invokeAddon(url, request).catch(() => ({ error: "The connection to the project module was lost." }));
  if (preview.src === url) frame.postMessage({ type: "morka:addon-result", id, result }, "*");
});

function showPreview(url?: string) {
  if (url) preview.src = url;
  else preview.removeAttribute("src");
}

if (!shadowWorkspace) {
  window.lab.onPreview(showPreview);
  window.lab.onPreviewUpdating(updating => { preview.inert = updating; });
  void window.lab.getPreview().then((url) => {
    if (url && !preview.hasAttribute("src")) showPreview(url);
  }).catch(() => {
    showError("Could not restore the preview.");
  });
}
