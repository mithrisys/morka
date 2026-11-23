import { reviewScenario } from "./scenario-review";
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { execFile, spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { writeTextAtomically } from "../app-runtime/text-file";
import { applyFiles, digest, entryFile, info, snapshot, type Files } from "../project/files";
import { compileProject, jsonFile, starterManifest, type Project } from "../project/project";
import { LivePreview } from "../project/live-preview";
import { ManagedRuntime } from "../project/managed-runtime";
import type { Artifact } from "../project/packages";
import { bundledToolchain } from "../project/toolchain";
import { importShadow, readShadow, type Shadow } from "../project/shadows";
import { installedShadowDescription, planShadowRemoval } from "../project/shadow-effects";
import { AgentRunner } from "../agent-actions/runner";
import { ActionAccess } from "../agent-actions/access";
import { ChatSessions } from "../agents/sessions";
import { AgentRegistry } from "../agents/registry";
import { makeIcon, type AppInstance } from "../instances/macos";
import { prepareMacProjectExecutable } from "../instances/distribution";
import { installDesktopApp } from "../instances/desktop";
import { appIcon, appName, appsDirectory, bundledKit, checkoutKey, materializeRepository, portableAppName, preparedRelease, readRelease, releaseFile, releaseProject, repositoryFile, repositoryProfileId, repositoryProject, type AppRelease } from "../instances/repository";
import { containsPath, createShadowRepository, readShadowWorkspace, type ShadowWorkspace } from "../instances/shadow-repository";

const titleBarStyle = process.platform === "darwin" ? "hiddenInset" : undefined;

function projectKey(directory: string) {
  return createHash("sha256").update(directory).digest("hex");
}

function kitDirectory() {
  return process.env.MORKA_NPM_KIT || (app.isPackaged ? join(process.resourcesPath, bundledKit) : join(__dirname, "../npm"));
}

async function openRepository(directory: string) {
  const repository = dirname(await repositoryProject(directory));
  const spec = readRelease(repositoryFile(repository, "release.json"));
  const executable = process.platform === "darwin"
    ? await prepareMacProjectExecutable(process.execPath, app.getPath("appData"), repository, spec)
    : process.execPath;
  const env: NodeJS.ProcessEnv = { ...process.env, MORKA_NPM_REPOSITORY: repository };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, app.isPackaged ? [] : [app.getAppPath()], {
    cwd: app.getAppPath(), env, detached: true, stdio: "ignore", windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function installRepository(repository: string) {
  const toolchain = await bundledToolchain(process.env.MORKA_DESKTOP_TOOLCHAIN);
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
  await promisify(execFile)(toolchain.node, [repositoryFile(repository, "npm", "install-app.cjs"), "--open"], {
    cwd: repository, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, npm_execpath: toolchain.npm,
      [pathKey]: [dirname(toolchain.node), process.env[pathKey]].filter(Boolean).join(delimiter),
      MORKA_INSTALLER_ENGINE: resolve(__dirname, "../.."),
      MORKA_INSTALL_TOOLCHAIN: toolchain.system ? "" : toolchain.root },
  });
}

function registerInstaller(
  window: BrowserWindow, requireShell: (event: IpcMainInvokeEvent) => void, getFiles: () => Promise<Files>,
  options: { source?: () => AppInstance; onInstalled?: (path: string, openError: string) => void } = {},
) {
  let installing = false;
  ipcMain.handle("instance:install", async (event, rawName: unknown): Promise<AppInstallResult | undefined> => {
    requireShell(event);
    if (installing) return;
    installing = true;
    try {
      const name = portableAppName(rawName);
      const choice = await dialog.showOpenDialog(window, {
        properties: ["openDirectory", "createDirectory"],
        title: `Choose where to create “${name}”`,
        message: "Morka will create the project folder inside the selected folder.",
        defaultPath: app.getPath("documents"),
        buttonLabel: "Choose Folder",
      });
      const parent = choice.filePaths[0];
      if (choice.canceled || !parent) return;
      const files = await getFiles();
      await compileProject(files);
      const source = options.source?.();
      if (source && containsPath(source.repositoryDirectory ?? source.projectDirectory, await realpath(parent))) {
        throw new Error("Choose a folder outside the original project.");
      }
      const iconColor = (source ? source.iconColor + randomInt(1, 8) : randomInt(8)) % 8;
      const spec: AppRelease = { version: 1, id: randomUUID(), name, iconColor,
        ...(source ? { clonedFrom: { id: source.id, revision: digest(files) } } : {}) };
      const path = await materializeRepository(parent, spec, files, kitDirectory(), makeIcon(iconColor));
      const openError = await installRepository(path).then(() => "", error => String(error));
      if (options.onInstalled) setImmediate(options.onInstalled, path, openError);
      return { path, openError };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      installing = false;
    }
  });
  window.on("close", event => { if (installing) event.preventDefault(); });
  window.once("closed", () => ipcMain.removeHandler("instance:install"));
}

async function createLauncher() {
  const index = join(__dirname, "../renderer/launcher.html");
  const url = pathToFileURL(index).href;
  const window = new BrowserWindow({
    width: 560, height: 400, minWidth: 440, minHeight: 360,
    title: "Morka", titleBarStyle, backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", event => event.preventDefault());
  const requireLauncher = (event: IpcMainInvokeEvent) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame?.url !== url) {
      throw new Error("This request is not allowed.");
    }
  };
  registerInstaller(window, requireLauncher, async () => {
    const files = await snapshot(join(__dirname, "../app-runtime/starter"));
    files.set(entryFile, jsonFile(starterManifest));
    return files;
  }, {
    onInstalled(path, openError) {
      if (!openError) app.quit();
    },
  });
  ipcMain.handle("instance:open", async event => {
    requireLauncher(event);
    const choice = await dialog.showOpenDialog(window, { title: "Open a Morka project", properties: ["openDirectory"] });
    if (choice.canceled || !choice.filePaths[0]) return;
    await openRepository(choice.filePaths[0]);
    setImmediate(() => app.quit());
  });
  window.once("closed", () => ipcMain.removeHandler("instance:open"));
  await window.loadFile(index);
}

async function createWindow(instance: AppInstance, release?: AppRelease, sourceLaunch = false) {
  const index = join(__dirname, "../renderer/index.html");
  const shellUrl = pathToFileURL(index).href;
  const dataDirectory = app.getPath("userData");
  const appLibrary = appsDirectory(app.getPath("appData"));
  const workspaceFile = join(dataDirectory, "workspace-path");
  let repository = instance.repositoryDirectory;
  if (release && (await info(workspaceFile))?.isFile()) {
    repository = (await readFile(workspaceFile, "utf8")).trim();
    if (!isAbsolute(repository)) throw new Error("The saved project folder is invalid.");
  }
  let projectDirectory = repository ? await repositoryProject(repository) : await realpath(instance.projectDirectory);
  if (repository) repository = dirname(projectDirectory);
  if ((await info(projectDirectory))?.isSymbolicLink()) throw new Error("The project root cannot be a symbolic link.");
  const projectId = instance.id;
  const runtimeHome = join(dataDirectory, "runtime", projectId);
  const [checkout, bridge, registry] = await Promise.all([
    snapshot(projectDirectory).then(compileProject)
      .then(project => ({ project, error: undefined }), error => ({ project: undefined, error })),
    readFile(join(__dirname, "../app-runtime/bridge.js"), "utf8"),
    AgentRegistry.open(dataDirectory, repository ?? projectDirectory, join(__dirname, "../skills")),
  ]);
  const createManaged = () => new ManagedRuntime(projectDirectory, runtimeHome,
    join(dataDirectory, "runtime-data"), detail => setRuntimeState("error", detail), undefined,
    join(appLibrary, "origins"), bridge);
  let managed = createManaged();
  let savedProject: Project | undefined;
  let savedArtifact: Artifact | undefined;
  if ((await info(join(runtimeHome, "active.json")))?.isFile()) {
    for (const previous of [false, true]) {
      try {
        const artifact = await managed.recover(previous);
        if (artifact) {
          savedProject = await compileProject(artifact.source);
          savedArtifact = artifact;
          break;
        }
      } catch (error) { console.error(error); }
    }
  }
  const initialProject = savedProject ?? checkout.project;
  if (!initialProject) throw checkout.error;
  let project = initialProject;
  let previewProject = project;
  let recoveredCheckout = Boolean(savedProject && (!checkout.project || digest(savedProject.files) !== digest(checkout.project.files)));
  const chatDirectory = join(dataDirectory, "codex", projectId);
  const chats = await ChatSessions.open(chatDirectory, projectDirectory, registry, repository);
  const window = new BrowserWindow({
    width: 1120, height: 730, minWidth: 720, minHeight: 460,
    title: instance.name, titleBarStyle,
    backgroundColor: "#f2f3f7",
    webPreferences: {
      preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  window.on("page-title-updated", event => event.preventDefault());
  const access = sourceLaunch ? new ActionAccess(join(dataDirectory, "agent-access", checkoutKey(repository ?? projectDirectory) + ".json")) : undefined;
  const agents = new AgentRunner(join(chatDirectory, "runs"), registry, access && (action => access.choose(action, async choices => {
    const accounts = (await registry.setup()).filter(account => choices.includes(account.id) &&
      (account.state === "ready" || account.state === "unavailable"));
    if (!accounts.length) {
      const names = choices.map(id => registry.get(id).info.name);
      throw new Error(`Open AI setup and sign in to ${names.join(" or ")} to use this action.`);
    }
    const { response } = await dialog.showMessageBox(window, {
      type: "question", buttons: ["Cancel", ...accounts.map(account => `Allow ${account.name}`)], defaultId: 0, cancelId: 0,
      message: `Allow ${instance.name} to use your local AI account?`,
      detail: `The app requested “${action.id}”. Its AI actions can send app-provided inputs to the chosen provider and use that account's limits. You can reset access in AI setup.`,
    });
    return accounts[response - 1]?.id;
  })));

  const contents = window.webContents;
  let activeAgentCount = 0;
  async function whileAgentActive<T>(run: () => Promise<T>) {
    const notify = () => { if (!contents.isDestroyed()) contents.send("agent:activity", activeAgentCount > 0); };
    activeAgentCount += 1;
    notify();
    try {
      return await run();
    } finally {
      activeAgentCount -= 1;
      notify();
    }
  }
  let runtimeState: RuntimeState = { status: "stopped" };
  let runtimeUrl: string | undefined;
  let operation = false;
  let closing = false;
  let runtimeTask: Promise<void> = Promise.resolve();
  const setRuntimeState = (status: RuntimeState["status"], detail?: string) => {
    runtimeState = { status, detail };
    if (!contents.isDestroyed()) contents.send("runtime:state", runtimeState);
  };
  const livePreview = new LivePreview(contents, detail => setRuntimeState("error", detail));
  chats.setPreviewReviewer(reviewScenario);
  chats.setProjectPreparer((files, signal, onLog, recheck) => managed.prepare(files, { signal, updateLock: true, onLog, recheck }));
  type Publish = () => Promise<() => Promise<void>>;
  chats.setProjectActivator((next, publish, signal) => activateDraft(next, publish, signal));
  chats.setShadowLoader(loadImportedShadow);
  const isShell = (event: IpcMainInvokeEvent) =>
    event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame?.url === shellUrl;
  const requireShell = (event: IpcMainInvokeEvent) => {
    if (!isShell(event)) throw new Error("This request is not allowed.");
  };
  const shadowUrl = shellUrl + "?scope=shadow";
  const editors = new Map<number, {
    window: BrowserWindow; workspace: ShadowWorkspace; chats: ChatSessions; registry: AgentRegistry;
  }>();
  const openingEditors = new Map<string, Promise<void>>();
  function chatScope(event: IpcMainInvokeEvent) {
    if (isShell(event)) return { chats, registry, window, workspace: undefined };
    const editor = editors.get(event.sender.id);
    if (editor && event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === shadowUrl) return editor;
    throw new Error("This request is not allowed.");
  }

  async function openShadowEditor(workspace: ShadowWorkspace) {
    const current = [...editors.values()].find(editor => editor.workspace.repository === workspace.repository);
    if (current) {
      if (current.window.isMinimized()) current.window.restore();
      current.window.focus();
      return;
    }
    const pending = openingEditors.get(workspace.repository);
    if (pending) return pending;
    const open = async () => {
      const library = join(appLibrary, "shadow-chats", workspace.id, projectKey(workspace.repository));
      const services = await AgentRegistry.open(library, workspace.repository, join(__dirname, "../skills"));
      try {
        const sessions = await ChatSessions.open(library, workspace.root, services, workspace.repository, "shadow", repository ?? projectDirectory);
        if (window.isDestroyed()) throw new Error("The app window closed.");
        const editor = new BrowserWindow({
          parent: window, title: `Shadow · ${workspace.name}`, width: 690, height: 670,
          minWidth: 470, minHeight: 420, titleBarStyle, backgroundColor: "#f2f3f7",
          webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
        });
        const view = editor.webContents;
        const id = view.id;
        editors.set(id, { window: editor, workspace, chats: sessions, registry: services });
        view.setWindowOpenHandler(() => ({ action: "deny" }));
        view.on("will-navigate", event => event.preventDefault());
        editor.once("closed", () => {
          editors.delete(id);
          sessions.close();
          services.close();
        });
        try {
          await editor.loadFile(index, { query: { scope: "shadow" } });
        } catch (error) {
          editor.destroy();
          throw error;
        }
      } catch (error) {
        services.close();
        throw error;
      }
    };
    const result = open().finally(() => openingEditors.delete(workspace.repository));
    openingEditors.set(workspace.repository, result);
    return result;
  }
  ipcMain.handle("instance:current", event => {
    requireShell(event);
    return instance.name;
  });
  registerInstaller(window, requireShell, async () => {
    if (activeAgentCount) throw new Error("Wait for the agent to finish before cloning this app.");
    return managed.sourceFiles ?? snapshot(projectDirectory);
  }, { source: () => ({ ...instance, projectDirectory, repositoryDirectory: repository }) });

  let creatingWorkspace: Promise<boolean> | undefined;
  async function ensureEditable() {
    if (!release || repository) return true;
    creatingWorkspace ??= createEditableWorkspace(release).finally(() => { creatingWorkspace = undefined; });
    return creatingWorkspace;
  }
  async function createEditableWorkspace(spec: AppRelease) {
    const choice = await dialog.showOpenDialog(window, {
      title: "Choose where to create your editable project",
      message: "Morka will create a Git repository with the app source in the selected folder.",
      buttonLabel: "Create Project",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: app.getPath("documents"),
    });
    const parent = choice.filePaths[0];
    if (choice.canceled || !parent) return false;
    if (operation) throw new Error("Wait for the app service to finish starting or stopping.");
    operation = true;
    try {
      const icon = await readFile(join(process.resourcesPath, appIcon));
      const directory = await materializeRepository(parent, spec, project.files, join(process.resourcesPath, bundledKit), icon);
      const editable = await repositoryProject(directory);
      await livePreview.prepare();
      await managed.stop();
      await writeTextAtomically(workspaceFile, directory);
      repository = directory;
      projectDirectory = editable;
      project = await compileProject(await snapshot(editable));
      previewProject = project;
      chats.setProjectRoot(editable, directory);
      managed = createManaged();
      runtimeUrl = undefined;
      setRuntimeState("stopped");
      return true;
    } finally {
      operation = false;
      void syncRuntime();
    }
  }

  function previewTransition(next: Project) {
    const previous = previewProject;
    const previousUrl = runtimeUrl;
    let started = false;
    let stylesShown: string[] | undefined;
    return {
      async activate(url: string | undefined, styles?: string[]) {
        started = true;
        stylesShown = styles;
        if (!contents.isDestroyed()) contents.send("canvas:updating", true);
        previewProject = next;
        runtimeUrl = url;
        await livePreview.show(url, styles, { confirm: true, clear: !url });
      },
      async rollback() {
        previewProject = previous;
        runtimeUrl = previousUrl;
        if (started && !closing) await livePreview.show(previousUrl, stylesShown, { confirm: true, recover: true, clear: !previousUrl });
      },
    };
  }

  async function activateManaged(next: Project, prepared?: Artifact, publish?: Publish, signal?: AbortSignal) {
    const spec = next.manifest.runtime;
    if (!prepared && !(await info(join(managed.home, "active.json")))) {
      const directory = join(process.resourcesPath, preparedRelease);
      if (release && !repository) await managed.packages.importPrepared(directory, next.files);
      else {
        const marker = await readFile(join(directory, "artifact.json"), "utf8").then(JSON.parse).catch(() => undefined);
        if (marker?.sourceHash === digest(next.files)) await managed.packages.importPrepared(directory, next.files);
      }
    }
    const preview = previewTransition(next);
    setRuntimeState(managed.url ? "preparing" : "starting");
    let completed = false;
    try {
      runtimeUrl = await managed.update(next.files, spec, {
        beforeActivate: () => livePreview.prepare(),
        activate: preview.activate,
        rollback: preview.rollback,
        publish,
      }, { signal, prepared });
      project = previewProject = next;
      completed = true;
    } finally {
      if (completed) await livePreview.completeUpdate();
      else await livePreview.resume();
    }
    setRuntimeState("running");
  }

  function reportUpdateFailure(error: unknown, draft = false) {
    const detail = error instanceof Error ? error.message : String(error);
    const recovery = runtimeUrl ? "The last working release is still open. " : "";
    setRuntimeState("error", (draft ? "Update failed. Continue in the same chat to repair the saved draft. " : "") + recovery + detail);
  }

  async function activateDraft(next: Project, publish: Publish, signal: AbortSignal, draft = true) {
    await runtimeTask.catch(() => {});
    signal.throwIfAborted();
    if (operation || closing) throw new Error("Wait for the app service to finish its current operation.");
    operation = true;
    runtimeTask = activateManaged(next, undefined, publish, signal)
      .catch(error => {
        if (!closing && !signal.aborted) reportUpdateFailure(error, draft);
        if (!draft) throw error;
        throw new Error(`The update could not be applied. Your edits are still in this chat's draft.\n${error instanceof Error ? error.message : error}`, { cause: error });
      }).finally(() => { operation = false; });
    await runtimeTask;
    if (!contents.isDestroyed()) contents.send("shadow:changed");
  }

  function syncRuntime(next = project): Promise<void> {
    if (operation || closing) return runtimeTask;
    operation = true;
    const prepared = savedArtifact;
    savedArtifact = undefined;
    runtimeTask = (async () => {
      try { await activateManaged(next, prepared); }
      catch (error) {
        if (!prepared || closing) throw error;
        const previous = await managed.recover(true);
        if (!previous || previous.key === prepared.key) throw error;
        await activateManaged(await compileProject(previous.source), previous);
        recoveredCheckout = true;
      }
      if (recoveredCheckout) {
        recoveredCheckout = false;
        setRuntimeState("error", "Opened the last working release. Retry to check the current source.");
      }
      if (!contents.isDestroyed()) contents.send("shadow:changed");
    })().catch(error => {
      if (!closing) reportUpdateFailure(error);
    }).finally(() => { operation = false; });
    return runtimeTask;
  }

  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-frame-navigate", (event) => {
    const fromRuntime = runtimeUrl && URL.parse(event.url)?.origin === new URL(runtimeUrl).origin;
    if (event.isMainFrame || (!fromRuntime && event.url !== "about:blank")) event.preventDefault();
  });
  contents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  contents.session.setPermissionCheckHandler(() => false);

  ipcMain.handle("canvas:current", (event) => { requireShell(event); return runtimeUrl; });
  ipcMain.handle("runtime:state", (event) => { requireShell(event); return runtimeState; });
  ipcMain.handle("runtime:retry", async (event) => {
    requireShell(event);
    if (operation || closing || runtimeState.status !== "error") return;
    try {
      const fresh = await compileProject(await snapshot(projectDirectory));
      await syncRuntime(fresh);
    } catch (error) {
      reportUpdateFailure(error);
    }
  });
  ipcMain.handle("shadow:import", async (event) => {
    requireShell(event);
    const choice = await dialog.showOpenDialog(window, { properties: ["openDirectory"], title: "Choose a Plugin Shadow folder" });
    if (choice.canceled || !choice.filePaths[0]) return;
    try {
      const shadow = await importShadow(choice.filePaths[0], join(dataDirectory, "shadows"));
      return { id: shadow.id, version: shadow.version, description: shadow.description, digest: shadow.digest };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("shadow:list", event => {
    requireShell(event);
    return (project.manifest.shadows ?? []).map(({ id, version }) => ({
      id, version, description: installedShadowDescription(project.files, id),
    }));
  });
  let removingShadow = false;
  ipcMain.handle("shadow:remove", async (event, id: unknown) => {
    requireShell(event);
    if (typeof id !== "string" || removingShadow || chats.running) throw new Error("Wait for the current edit to finish.");
    removingShadow = true;
    try {
      const current = await snapshot(projectDirectory);
      const { only, clean, summary } = planShadowRemoval(current, id);
      const detail = [
        "Removing the Shadow stops its rules from guiding future app edits.",
        summary.changes.length
          ? "Cleanup can also change these files:\n" + summary.changes.map(row => `• ${row.path} — ${row.reason}`).join("\n")
          : "Morka found no prior source changes it could safely reverse.",
        summary.skipped.length ? "These files will be kept because the app may still use them or they changed later:\n" +
          summary.skipped.map(path => `• ${path}`).join("\n") : "",
      ].filter(Boolean).join("\n\n");
      const buttons = ["Cancel", "Remove Shadow Only"];
      if (summary.changes.length) buttons.push("Remove and Clean Up");
      const choice = await dialog.showMessageBox(window, {
        type: "question", buttons, defaultId: 0, cancelId: 0, message: `Remove “${summary.id}” v${summary.version}?`, detail,
      });
      if (choice.response === 0 || !(await ensureEditable())) return false;
      if (chats.running || digest(await snapshot(projectDirectory)) !== digest(current)) {
        throw new Error("The app changed during review. Open Remove again to see an updated plan.");
      }
      const selected = choice.response === 2 ? clean : only;
      const compiled = await compileProject(selected);
      await activateDraft(compiled, async () => {
        await applyFiles(projectDirectory, current, selected);
        return async () => { await applyFiles(projectDirectory, selected, current); };
      }, new AbortController().signal, false);
      return true;
    } finally {
      removingShadow = false;
    }
  });
  ipcMain.handle("shadow:new", async (event, rawName: unknown) => {
    requireShell(event);
    const name = appName(rawName);
    const answer = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"], title: `Choose where to create “${name}”`,
      message: "Morka will create the Shadow repository inside the selected folder.",
      buttonLabel: "Choose Folder", defaultPath: app.getPath("documents"),
    });
    if (answer.canceled || !answer.filePaths[0]) return false;
    const parent = await realpath(answer.filePaths[0]);
    if (containsPath(repository ?? projectDirectory, parent)) throw new Error("Choose a location outside the app repository.");
    await openShadowEditor(await createShadowRepository(parent, name, kitDirectory()));
    return true;
  });
  ipcMain.handle("shadow:open", async event => {
    requireShell(event);
    const answer = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"], title: "Open a Shadow repository", buttonLabel: "Open Shadow",
    });
    if (answer.canceled || !answer.filePaths[0]) return false;
    const workspace = await readShadowWorkspace(answer.filePaths[0]);
    const root = repository ?? projectDirectory;
    if (containsPath(root, workspace.repository) || containsPath(workspace.repository, root)) {
      throw new Error("A Shadow needs a repository outside the app repository.");
    }
    await openShadowEditor(workspace);
    return true;
  });
  ipcMain.handle("agent:activity", event => {
    const scope = chatScope(event);
    return scope.workspace ? scope.chats.running : activeAgentCount > 0;
  });
  ipcMain.handle("addon:invoke", async (event, url: unknown, request: AddonRequest | undefined): Promise<AddonResult> => {
    if (!isShell(event) || !livePreview.isCurrentRuntime(url, runtimeUrl)) return { error: "This request is not allowed." };
    if (request?.type !== "runAgentAction") return { error: "Invalid project action." };
    const requestedProject = previewProject;
    try {
      return { value: await whileAgentActive(() => agents.run(requestedProject, request.action, request.input)) };
    } catch (error) {
      console.error(error);
      return { error: error instanceof Error ? error.message : "The agent action could not be completed." };
    }
  });
  ipcMain.handle("chat:target", event => {
    const { workspace } = chatScope(event);
    return workspace ? { kind: "shadow", name: workspace.name, directory: workspace.repository }
      : { kind: "app", name: instance.name };
  });
  ipcMain.handle("chat:list", event => chatScope(event).chats.list());
  ipcMain.handle("chat:new", event => chatScope(event).chats.create());
  ipcMain.handle("chat:open", (event, id: string) => chatScope(event).chats.select(id));
  ipcMain.handle("chat:attach", async (event, kind: unknown) => {
    const scope = chatScope(event);
    if (kind !== "file" && kind !== "folder") throw new Error("Choose files or a folder.");
    const selection = await dialog.showOpenDialog(scope.window, {
      title: kind === "folder" ? "Attach folder" : "Attach files", buttonLabel: "Attach",
      properties: [kind === "folder" ? "openDirectory" : "openFile", "multiSelections"],
    });
    return selection.canceled ? [] : scope.chats.attachments.import(selection.filePaths);
  });
  ipcMain.handle("chat:attach-paths", async (event, paths: unknown) => {
    const scope = chatScope(event);
    if (!Array.isArray(paths) || paths.length > 100 || !paths.every(path => typeof path === "string" && isAbsolute(path))) throw new Error("Invalid attachments.");
    return scope.chats.attachments.import(paths);
  });
  ipcMain.handle("chat:attachment-reveal", async (event, id: string) => {
    const path = await chatScope(event).chats.attachments.path(id);
    shell.showItemInFolder(path);
  });
  ipcMain.handle("chat:open-link", async (event, url: unknown) => {
    chatScope(event);
    const link = typeof url === "string" && url.length <= 8192 ? URL.parse(url) : null;
    if (!link || !["https:", "http:", "mailto:"].includes(link.protocol)) throw new Error("Unsupported link.");
    await shell.openExternal(link.href);
  });
  ipcMain.handle("chat:providers", event => chatScope(event).registry.providers());
  ipcMain.handle("agent:setup", async event => {
    const scope = chatScope(event);
    const accounts = await scope.registry.setup();
    const authorized = scope.workspace ? [] : await access?.current() ?? [];
    return accounts.map(account => ({ ...account, authorized: authorized.includes(account.id) }));
  });
  ipcMain.handle("agent:clear-access", async event => {
    requireShell(event);
    if (activeAgentCount) throw new Error("Wait for the current agent action to finish.");
    await access?.clear();
  });
  ipcMain.handle("chat:agent-options", (event, providerId = "codex") => chatScope(event).chats.options(providerId));
  ipcMain.handle("chat:stop", (event, id: string) => chatScope(event).chats.stop(id));
  async function loadImportedShadow({ id, version, digest }: ShadowPackageReference) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) || !/^[0-9][a-zA-Z0-9.-]{0,47}$/.test(version) || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("Invalid Shadow package ID.");
    }
    const shadow = await readShadow(join(dataDirectory, "shadows", id, version, digest));
    if (shadow.id !== id || shadow.version !== version || shadow.digest !== digest) throw new Error("The Shadow package contents changed.");
    return shadow;
  }
  ipcMain.handle("chat:send", async (event, id: string, message: unknown, model: unknown, shadowRef?: unknown, agent?: unknown, attachments: unknown = []): Promise<ChatTurnResult> => {
    if (!Array.isArray(attachments) || attachments.length > 100 || !attachments.every(id => typeof id === "string")) return { error: "Invalid attachments." };
    if (typeof message !== "string" || (!message.trim() && !attachments.length) || message.length > 4_000) {
      return { error: "Enter a message or attach files. Messages can contain up to 4,000 characters." };
    }
    try {
      const scope = chatScope(event);
      if (!scope.workspace) {
        if (removingShadow) throw new Error("Finish reviewing the Shadow removal first.");
        if (!(await ensureEditable())) return { stopped: true };
      }
      const options = agent as Partial<AgentSelection> | undefined;
      const selection: AgentSelection = {
        providerId: typeof options?.providerId === "string" ? options.providerId : "codex",
        effort: typeof options?.effort === "string" && options.effort ? options.effort : undefined,
      };
      let shadow: Shadow | undefined;
      if (shadowRef !== undefined) {
        if (scope.workspace) throw new Error("Install Shadows from an app workspace.");
        shadow = await loadImportedShadow(shadowRef as ShadowPackageReference);
      }
      const target = event.sender;
      const send = () => scope.chats.send(id, message, typeof model === "string" && model ? model : undefined,
        chatEvent => { if (!target.isDestroyed()) target.send("chat:event", chatEvent); }, shadow, selection, attachments);
      let result;
      if (scope.workspace) {
        target.send("agent:activity", true);
        try { result = await send(); }
        finally { if (!target.isDestroyed()) target.send("agent:activity", scope.chats.running); }
      } else result = await whileAgentActive(send);
      return { stopped: result.stopped };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "The change could not be completed." };
    }
  });

  let readyToClose = false;
  window.on("close", (event) => {
    closing = true;
    livePreview.cancelUpdate();
    void livePreview.resume().then(() => { if (!contents.isDestroyed()) contents.send("canvas:updating", true); });
    if (readyToClose) return;
    event.preventDefault();
    void Promise.allSettled([managed.stop(), runtimeTask]).finally(() => {
      readyToClose = true;
      if (!window.isDestroyed()) window.close();
    });
  });
  window.once("closed", () => {
    for (const editor of editors.values()) if (!editor.window.isDestroyed()) editor.window.destroy();
    chats.close();
    agents.close();
    registry.close();
    for (const channel of ["instance:current", "canvas:current", "runtime:state", "runtime:retry", "shadow:import", "shadow:list", "shadow:remove", "shadow:new", "shadow:open", "addon:invoke", "chat:target", "chat:list", "chat:new", "chat:open", "chat:providers", "chat:agent-options", "chat:send", "chat:stop", "agent:activity", "agent:setup", "agent:clear-access"]) {
      ipcMain.removeHandler(channel);
    }
  });
  await window.loadFile(index);
  if (!closing) void syncRuntime();
}

async function start() {
  const macBundle = app.isPackaged && process.platform === "darwin";
  const requestedRepository = process.env.MORKA_NPM_REPOSITORY?.trim();
  const npmRepository = requestedRepository ? dirname(await repositoryProject(requestedRepository)) : undefined;
  const install = process.env.MORKA_INSTALL_APP;
  if (install === "1" || install === "open") {
    if (!npmRepository) throw new Error("App installation requires a Morka project.");
    const spec = readRelease(repositoryFile(npmRepository, "release.json"));
    if (process.platform === "darwin") app.setActivationPolicy("prohibited");
    await app.whenReady();
    await installDesktopApp(npmRepository, spec, install === "open");
    app.exit(0);
    return;
  }
  const metadata = macBundle ? join(process.resourcesPath, releaseFile) : "";
  const release = macBundle && statSync(metadata, { throwIfNoEntry: false })?.isFile() ? readRelease(metadata) : undefined;
  const instance = release ? { ...release, projectDirectory: join(process.resourcesPath, releaseProject) }
    : npmRepository ? {
      ...readRelease(repositoryFile(npmRepository, "release.json")),
      repositoryDirectory: npmRepository,
      projectDirectory: join(npmRepository, "app"),
    } : undefined;
  const localId = instance && npmRepository ? repositoryProfileId(instance, npmRepository) : instance?.id;
  const profile = localId ? join(release ? "releases" : "instances", localId) : "launcher";
  const data = join(appsDirectory(app.getPath("appData")), profile);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  app.setPath("userData", data);
  app.setName(instance?.name ?? "Morka");

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  await app.whenReady();
  if (instance) await createWindow(instance, release, Boolean(npmRepository && !release));
  else {
    app.dock?.setIcon(join(__dirname, "../branding/morka-icon.png"));
    await createLauncher();
  }
}

void start().catch(error => {
  console.error(error);
  if (process.env.MORKA_INSTALL_APP) {
    app.exit(1);
    return;
  }
  dialog.showErrorBox(app.name, error instanceof Error ? error.message : String(error));
  app.quit();
});
