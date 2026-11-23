import { repairReview } from "./review-repair";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeTextAtomically } from "../app-runtime/text-file";
import { applyFiles, changes, describeChanges, digest, snapshot, sourceContext, type Files } from "../project/files";
import { compileProject, instructionPaths, readManifest, type Project, type ShadowRef } from "../project/project";
import { synchronizeDraft } from "../project/drafts";
import { shadowContext, stageShadow, validateShadow, type Shadow } from "../project/shadows";
import { editableAppFiles, isShadowStorage, saveShadowInstallation } from "../project/shadow-effects";
import type { AgentConnection } from "./contracts";
import { AgentRegistry } from "./registry";
import { guideNames, selectSkills } from "./context";
import { firstWorkflow, previewFile, reviewTiming, type PreviewScenario } from "../project/preview-scenario";
import { inspectScreens } from "./visual-review";
import { AttachmentStore, type AgentAttachment } from "./attachments";

type NativeSession = { id: string; cursor: number; guideTool?: boolean };
type SavedChat = ChatSession & {
  base?: string; messages: ChatMessage[];
  native?: Record<string, NativeSession>;
  activationFailure?: string;
  pendingShadow?: { package: ShadowPackageReference; refs: ShadowRef[] };
};
type SavedIndex = { selected?: string; chats: SavedChat[] };
type Publish = () => Promise<() => Promise<void>>;

type ReviewCheck = (directory: string, scenario: PreviewScenario, signal: AbortSignal, visual: boolean) => Promise<string>;
type BackgroundReview = {
  id: string; turnId: string; root: string; source: Files; directory: string; scenario: PreviewScenario;
  visual: boolean; model?: string; request: string; connection: AgentConnection;
  check: ReviewCheck; emit: (event: ChatEvent) => void;
};

const newChatTitle = "New chat";
export class ChatSessions {
  private active?: { id: string; controller: AbortController };
  private background?: AbortController;
  private reviewActivation?: Promise<void>;
  private writing: Promise<void> = Promise.resolve();
  private reviewer?: (directory: string, scenario: PreviewScenario, signal: AbortSignal,
    inspect?: (images: AgentAttachment[], signal: AbortSignal) => Promise<void>) => Promise<void>;
  setPreviewReviewer(review: NonNullable<ChatSessions["reviewer"]>) { this.reviewer = review; }
  readonly attachments: AttachmentStore;
  private prepareProject?: (files: Files, signal: AbortSignal,
    onLog: (text: string) => void, recheck?: boolean) => Promise<{ source: Files; built: boolean; directory?: string }>;
  private activateProject?: (project: Project, publish: Publish, signal: AbortSignal) => Promise<void>;
  private readPendingShadow?: (reference: ShadowPackageReference) => Promise<Shadow>;

  setProjectPreparer(prepare: NonNullable<ChatSessions["prepareProject"]>) { this.prepareProject = prepare; }
  setProjectActivator(activate: NonNullable<ChatSessions["activateProject"]>) { this.activateProject = activate; }
  setShadowLoader(load: NonNullable<ChatSessions["readPendingShadow"]>) { this.readPendingShadow = load; }

  private constructor(
    private readonly directory: string, private root: string,
    private readonly registry: AgentRegistry, private index: SavedIndex,
    private repository?: string,
    private readonly target: "app" | "shadow" = "app",
    private readonly otherRepository?: string,
  ) { this.attachments = new AttachmentStore(join(directory, "attachments")); }

  static async open(directory: string, root: string, registry: AgentRegistry, repository?: string, target: "app" | "shadow" = "app", otherRepository?: string) {
    const text = await readFile(join(directory, "chats.json"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const index: SavedIndex = text ? JSON.parse(text) : { chats: [] };
    let recovered = false;
    for (const chat of index.chats) {
      for (const message of chat.messages) {
        if (message.activity?.status !== "running") continue;
        message.activity = { ...message.activity, status: "stopped", completedAt: Date.now() };
        recovered = true;
      }
    }
    const sessions = new ChatSessions(directory, root, registry, index, repository, target, otherRepository);
    if (recovered) await sessions.save(index);
    return sessions;
  }

  get running() { return Boolean(this.active); }

  setProjectRoot(root: string, repository: string) {
    if (this.active) throw new Error("A turn is already in progress.");
    this.background?.abort();
    this.root = root;
    this.repository = repository;
  }

  private async save(index: SavedIndex) {
    this.index = index;
    const write = this.writing.then(() => writeTextAtomically(join(this.directory, "chats.json"), JSON.stringify(index)));
    this.writing = write.catch(() => {});
    await write;
  }

  private session(id: string) {
    const chat = this.index.chats.find(chat => chat.id === id);
    if (!chat) throw new Error("Chat not found.");
    return chat;
  }

  private async update(chat: SavedChat) {
    await this.save({ ...this.index, chats: this.index.chats.map(item => item.id === chat.id ? chat : item) });
  }

  list(): ChatIndex {
    return { selected: this.index.selected, chats: this.index.chats.map(({ id, title, providerId }) => ({ id, title, providerId })) };
  }

  async create(): Promise<ChatSession> {
    if (this.active) throw new Error("A turn is already in progress.");
    const chat = { id: randomUUID(), title: newChatTitle };
    await this.save({ selected: chat.id, chats: [{ ...chat, messages: [] }, ...this.index.chats] });
    return chat;
  }

  async select(id: string) {
    const chat = this.session(id);
    if (this.index.selected !== id) await this.save({ ...this.index, selected: id });
    return chat.messages;
  }

  options(providerId: string) { return this.registry.get(providerId).connection.options(); }

  async send(id: string, text: string, model: string | undefined, emit: (event: ChatEvent) => void, shadow: Shadow | undefined, selection: AgentSelection, attachmentIds: string[] = []) {
    if (this.active) throw new Error("A turn is already in progress.");
    if (shadow && this.target !== "app") throw new Error("Install Shadows from an app workspace.");
    this.background?.abort();
    let chat = this.session(id);
    const agent = this.registry.get(selection.providerId);
    const messages = new Map<string, ChatMessage>();
    const turnId = randomUUID();
    const fullReview = this.target === "app" && (
      /^\/review(?:\s|$)/i.test(text.trim()) ||
      /^(?:please )?(?:review|check|test) (?:the |my )?(?:whole|entire) app[.!]?$/i.test(text.trim()) ||
      /^(?:لطفاً? )?کل (?:اپ|برنامه) (?:رو|را) بررسی کن[.!]?$/.test(text.trim())
    );
    let startBackground: (() => void) | undefined;
    let transcript: ChatMessage[] | undefined;
    let finished = false;
    let outcome: ChatActivity["status"] = "failed";
    let failure: string | undefined;
    let preparationTitle: string | undefined;
    const startedAt = Date.now();
    function message(item: ChatMessage, append = false) {
      const idInTurn = `${turnId}:${item.id}`;
      const previous = messages.get(idInTurn);
      const tagged = { ...item, id: idInTurn, turnId, ...(item.role === "user" ? {} : { providerId: agent.info.id, providerName: agent.info.name }),
        ...(item.activity ? { activity: { ...item.activity, startedAt: previous?.activity?.startedAt ?? Date.now(),
          ...(item.activity.status !== "running" ? { completedAt: Date.now() } : {}) } } : {}) };
      messages.set(idInTurn, append ? { ...tagged, text: (messages.get(idInTurn)?.text ?? "") + tagged.text } : tagged);
      emit({ chatId: id, message: tagged, append });
    }
    const controller = new AbortController();
    const { signal } = controller;
    this.active = { id, controller };
    try {
      await this.reviewActivation?.catch(() => {});
      if (!shadow && chat.pendingShadow) shadow = await this.readPendingShadow?.(chat.pendingShadow.package);
      transcript = chat.messages;
      const attachments = await this.attachments.context([...transcript.flatMap(item => item.attachments?.map(attachment => attachment.id) ?? []), ...attachmentIds], signal);
      const selected = attachments.filter(attachment => attachmentIds.includes(attachment.id)).map(({ path: _path, files: _files, ...attachment }) => attachment);
      chat = { ...chat, providerId: agent.info.id, title: chat.title === newChatTitle ? (text.trim() || selected.map(item => item.name).join(", ")).replace(/\s+/g, " ").slice(0, 60) : chat.title };
      message({ id: "user", role: "user", text, ...(selected.length ? { attachments: selected } : {}) });
      message({ id: "run", role: "activity", text: "Working", activity: { kind: "run", status: "running", title: "Working", startedAt } });
      chat = { ...chat, messages: [...transcript, ...messages.values()] };
      await this.update(chat);
      const workspace = join(this.directory, "project-workspaces", id);
      const live = await snapshot(this.root);
      const current = this.target === "app" ? editableAppFiles(live) : live;
      const { draft, base } = await synchronizeDraft(workspace, current, chat, signal);
      chat = { ...chat, base };
      await this.update(chat);
      const manifest = this.target === "app" ? readManifest(current) : undefined;
      if (shadow) {
        const reference = { id: shadow.id, version: shadow.version, digest: shadow.digest };
        if (!isDeepStrictEqual(chat.pendingShadow?.package, reference)) {
          const before = new Map(draft);
          stageShadow(shadow, draft);
          await applyFiles(workspace, before, draft, signal);
          chat = { ...chat, pendingShadow: { package: reference, refs: readManifest(draft).shadows ?? [] } };
          await this.update(chat);
        }
      }
      const paths = manifest ? instructionPaths(manifest) : [];
      const instructions = Object.fromEntries(paths.map(name => [name, draft.get(name)?.toString()]));
      signal.throwIfAborted();
      const prompt = async (repair?: string, attempt = 0) => {
        const promptFiles = attempt ? await snapshot(workspace) : draft;
        const native = chat.native?.[agent.info.id];
        // Existing Codex threads keep their native ID and their original tool registration.
        const legacyGuides = this.target === "app" && agent.info.id === "codex" && native && !native.guideTool;
        return agent.connection.prompt({
        cwd: workspace, repository: this.repository, otherRepository: this.otherRepository,
        sessionId: native?.id, text: repair ?? (text || "Review the attached files and ask what the user would like to do with them."), model, effort: selection.effort, attachments,
        skills: legacyGuides ? [...selectSkills(this.target), ...guideNames] : selectSkills(this.target),
        files: sourceContext(promptFiles, paths),
        project: { target: this.target, instructions, paths: [...promptFiles.keys()], shadow: shadow && shadowContext(shadow),
          activationFailure: chat.activationFailure },
        history: transcript!, historySinceSession: transcript!.slice(native?.cursor ?? 0),
        onMessage: (item, append) => { if (item.role !== "user") message(attempt ? { ...item, id: `repair-${attempt}:${item.id}` } : item, append); },
        signal,
        storeSession: async sessionId => {
          chat = { ...chat, native: { ...chat.native, [agent.info.id]: { id: sessionId, cursor: 0 } } };
          await this.update(chat);
        },
      }); };
      const turn = fullReview && draft.has(previewFile) ? "completed" : await prompt();
      if (signal.aborted || turn === "interrupted") { outcome = "stopped"; return { stopped: true }; }
      finished = true;

      let updated = await snapshot(workspace);
      if (!fullReview && digest(current) === digest(updated)) {
        chat = { ...chat, activationFailure: undefined, pendingShadow: undefined };
        outcome = "completed";
        return {};
      }
      if (digest(await snapshot(this.root)) !== digest(live)) throw new Error("The project changed during this turn. The draft is preserved.");
      if (this.target === "shadow") {
        const packageResult = validateShadow(updated);
        if (packageResult.id !== validateShadow(current).id) throw new Error("Keep the Shadow's package ID when editing it.");
        await applyFiles(this.root, current, updated, signal);
        chat = { ...chat, base: digest(updated) };
        outcome = "completed";
        return { packageResult };
      }
      if ([...updated.keys()].some(isShadowStorage)) throw new Error("The Shadow installation directory is managed by Morka.");
      const expected = shadow ? chat.pendingShadow?.refs : manifest?.shadows;
      const next = new Map([...live].filter(([path]) => isShadowStorage(path)));
      for (const [path, bytes] of updated) next.set(path, bytes);
      if (shadow) {
        saveShadowInstallation(current, next, shadow, live);
        const text = describeChanges(current, updated);
        if (text) message({ id: randomUUID(), role: "activity", text });
      }
      let preparedDirectory: string | undefined;
      let timing: ReturnType<typeof reviewTiming>;
      const check = async (directory: string, scenario: PreviewScenario, reviewSignal: AbortSignal, visual: boolean) => {
        const inspect = visual && agent.connection.supportsImages && agent.connection.reviewConnection
          ? (images: AgentAttachment[], s: AbortSignal) => inspectScreens(agent.connection.reviewConnection!(), images, s, model)
          : undefined;
        await this.reviewer!(directory, scenario, reviewSignal, inspect);
        return "Scenario passed at 1280 and 640 px. " + (inspect ? "Visual inspection passed." : "Visual inspection did not run.");
      };
      let project: Awaited<ReturnType<typeof compileProject>>;
      for (let attempt = 0; ; attempt++) {
        let preparing = false;
        try {
          project = await compileProject(next);
          if (this.reviewer && !project.preview && firstWorkflow(current, next)) {
            throw Error("Add morka.preview.json with a user-visible expectation for the first workflow.");
          }
          if (!isDeepStrictEqual(project.manifest.shadows, expected)) throw new Error("Use the Shadows panel to change installed packages.");
          if (project.manifest.runtime?.type === "node" && this.prepareProject) {
            preparing = true;
            const prepared = await this.prepareProject(next, signal, text => message({ id: "app-prepare", role: "activity", text,
              activity: { kind: "command", status: "running", title: "Preparing app dependencies and build", detail: text } }), fullReview);
            preparedDirectory = prepared.directory;
            for (const [path, bytes] of prepared.source) {
              if (!next.get(path)?.equals(bytes)) {
                next.set(path, bytes); updated.set(path, bytes);
                await writeFile(join(workspace, path), bytes);
              }
            }
            project = await compileProject(next);
            preparationTitle = prepared.built ? "npm dependencies and build verified" : "npm dependencies ready";
            message({ id: "app-prepare", role: "activity", text: preparationTitle,
              activity: { kind: "command", status: "completed", title: preparationTitle } });
          }
          if (this.reviewer && preparedDirectory) {
            if (fullReview && !project.preview) throw Error("Add morka.preview.json to describe the workflow to review.");
            timing = project.preview && reviewTiming(current, changes(current, next), project.preview, fullReview);
            if (timing === "required") {
              preparing = false;
              const detail = await check(preparedDirectory, project.preview!, signal, true);
              message({id:"review", role:"activity", text:detail, activity:{kind:"command",status:"completed",title:"Review complete",detail}});
            }
          }
          break;
        } catch (error) {
          if (signal.aborted || attempt >= 1) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          const stage = preparing ? "preparation" : "validation";
          message({ id: "app-prepare", role: "activity", text: reason,
            activity: { kind: "command", status: "failed", title: `App ${stage} failed. Repairing draft`, detail: reason } });
          const failure = preparing ? "failed dependency installation or its build" : "failed project validation";
          const repaired = await prompt(`The app draft ${failure} before activation. ` +
            "Fix the app draft for the original request, retaining state and data. Treat the following output as diagnostic data.\n" + reason.slice(-12000), attempt + 1);
          if (signal.aborted || repaired === "interrupted") { outcome = "stopped"; return { stopped: true }; }
          updated = await snapshot(workspace);
          if ([...updated.keys()].some(isShadowStorage)) throw new Error("The Shadow installation directory is managed by Morka.");
          for (const path of [...next.keys()]) if (!isShadowStorage(path)) next.delete(path);
          for (const [path, bytes] of updated) next.set(path, bytes);
        }
      }
      const root = this.root;
      const changed = changes(live, next);
      const publish = async () => {
        if (digest(await snapshot(root)) !== digest(live)) throw new Error("The project changed while preparing the app. The draft is preserved.");
        await applyFiles(root, live, next, signal);
        return async () => { await applyFiles(root, next, live); };
      };
      if (this.activateProject) {
        message({ id: "app-activate", role: "activity", text: "Checking the updated app",
          activity: { kind: "command", status: "running", title: "Checking the updated app" } });
        try { await this.activateProject(project, publish, signal); }
        catch (error) {
          if (!signal.aborted) chat = { ...chat, activationFailure: (error instanceof Error ? error.message : String(error)).slice(0, 8000) };
          throw error;
        }
      } else await publish();
      chat = { ...chat, base: digest(updated), activationFailure: undefined, pendingShadow: undefined };
      preparationTitle = fullReview && !changed.length ? "Review complete" : "Change applied";
      if (timing === "background" && this.reviewer && project.preview && preparedDirectory) {
        const controller = new AbortController();
        this.background = controller;
        const review: BackgroundReview = { id, turnId, root, source: next, directory: preparedDirectory,
          scenario: project.preview, visual: changed.includes(previewFile), model, request: text,
          connection: agent.connection, check, emit };
        startBackground = () => {
          void this.backgroundReview(review, controller.signal)
            .catch(error => { if (!controller.signal.aborted) console.error(error); })
            .finally(() => { if (this.background === controller) this.background = undefined; });
        };
      }
      outcome = "completed";
      return this.activateProject ? {} : { project, changed };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (signal.aborted) { outcome = "stopped"; return { stopped: true }; }
      throw error;
    } finally {
      try {
        if (transcript) {
          for (const item of messages.values()) {
            if (item.activity?.status !== "running" || item.activity.kind === "run") continue;
            const update = { ...item, activity: { ...item.activity, status: outcome, completedAt: Date.now() } };
            messages.set(item.id, update);
            emit({ chatId: id, message: update });
          }
          if (messages.has(`${turnId}:run`)) message({ id: "run", role: "activity", text: outcome,
            activity: { kind: "run", status: outcome, title: outcome === "completed" ? preparationTitle ?? "Completed" : outcome === "stopped" ? "Stopped" : "Failed", detail: failure, startedAt, completedAt: Date.now() } });
          const timeline = [...transcript, ...messages.values()];
          const session = chat.native?.[agent.info.id];
          if (finished && session) chat = {
            ...chat, native: { ...chat.native, [agent.info.id]: { ...session, cursor: timeline.length } },
          };
          await this.update({ ...chat, messages: timeline });
        }
      } finally {
        this.active = undefined;
        if (startBackground) setImmediate(startBackground);
      }
    }
  }

  private async backgroundReview(review: BackgroundReview, signal: AbortSignal) {
    signal.throwIfAborted();
    const { id, turnId, root, source, directory, scenario, visual, check, emit } = review;
    let revision = digest(source);
    let detail: string;
    let status: ChatActivity["status"] = "completed";
    try {
      detail = await check(directory, scenario, signal, visual);
    } catch (error) {
      status = "failed";
      detail = error instanceof Error ? error.message : String(error);
      if (signal.aborted) return;
      if (review.connection.reviewConnection && this.prepareProject && this.activateProject && digest(await snapshot(root)) === revision) {
        try {
          signal.throwIfAborted();
          const repaired = await repairReview(this.directory, source, review.connection.reviewConnection(), review.request, detail, review.model, signal);
          const prepared = await this.prepareProject(repaired, signal, () => {});
          const candidate = await compileProject(prepared.source);
          if (!prepared.directory) throw Error("Missing prepared review assets.");
          const checked = await check(prepared.directory, scenario, signal, visual);
          signal.throwIfAborted();
          if (digest(await snapshot(root)) !== revision) return;
          signal.throwIfAborted();
          this.reviewActivation = this.activateProject(candidate, async () => {
            if (digest(await snapshot(root)) !== revision) throw Error("A newer edit superseded this repair.");
            await applyFiles(root, source, prepared.source, signal);
            return async () => { await applyFiles(root, prepared.source, source); };
          }, signal);
          try { await this.reviewActivation; } finally { this.reviewActivation = undefined; }
          revision = digest(prepared.source);
          detail = "Applied a verified repair. " + checked;
          status = "completed";
        } catch (repairError) {
          detail += "\nRepair: " + (repairError instanceof Error ? repairError.message : repairError);
        }
      }
    }
    if (signal.aborted) return;
    const currentRevision = digest(await snapshot(root));
    if (signal.aborted || currentRevision !== revision) return;
    const item: ChatMessage = {
      id: turnId + ":background-review", role: "activity", turnId: turnId + ":review", text: detail,
      activity: { kind: "run", status, title: status === "completed" ? "Review complete" : "Review needs attention", detail },
    };
    const latest = this.session(id);
    await this.update({ ...latest, messages: [...latest.messages, item] });
    if (!signal.aborted) emit({ chatId: id, message: item });
  }

  stop(id: string) {
    if (this.active?.id === id) this.active.controller.abort();
  }

  close() {
    this.background?.abort();
    this.active?.controller.abort();
  }
}
