const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { pathToFileURL } = require("node:url");
const { runInNewContext } = require("node:vm");
const { LivePreview } = require("../dist/project/live-preview.js");

// Exercise the window's actual startup, IPC, edit and close paths without
// launching agents or changing the user's apps, projects or data.
const project = runtime => ({ manifest: { runtime }, files: new Map([["styles.css", Buffer.from("h1 { color: orange }")]]) });
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(initial, options = {}) {
  let current = initial;
  let window;
  let managed;
  const handlers = new Map();
  const messages = [];
  const chats = {
    close() {}, setPreviewReviewer() {}, setProjectPreparer() {}, setShadowLoader() {},
    setProjectActivator(activate) { this.activate = activate; },
    async send() {
      await this.activate(current, async () => async () => {}, new AbortController().signal);
      return {};
    },
  };
  class Window extends EventEmitter {
    constructor() {
      super();
      window = this;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, isDestroyed: () => false, send: (...args) => messages.push(args),
        setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
      });
    }
    isDestroyed() { return Boolean(this.destroyed); }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    close() {
      let prevented = false;
      this.emit("close", { preventDefault() { prevented = true; } });
      if (!prevented) { this.destroyed = true; this.emit("closed"); }
    }
  }
  class Managed {
    home = "/fixture/runtime";
    packages = { async importPrepared() {} };
    constructor() { managed = this; }
    async prepare(source) { return { source }; }
    async recover() { return options.saved && { source: options.saved, key: "fixture" }; }
    async update(source, spec, callbacks) {
      if (options.wait) await new Promise(resolve => { this.release = resolve; });
      if (this.stopped) throw Error("stopped during startup");
      if (options.failManaged) { options.failManaged = false; throw Error("candidate failed before activation"); }
      await callbacks.beforeActivate();
      this.spec = spec;
      this.sourceFiles = new Map(source);
      await callbacks.activate("http://127.0.0.1:42000/");
      return "http://127.0.0.1:42000/";
    }
    get url() { return this.spec && "http://127.0.0.1:42000/"; }
    async stop() { this.stopped = true; this.spec = undefined; this.release?.(); }
  }
  const mocks = {
    electron: { BrowserWindow: Window, app: { getPath: () => options.root ?? "/fixture/data" },
      ipcMain: { handle: (key, value) => handlers.set(key, value), removeHandler: key => handlers.delete(key) },
      dialog: { showMessageBox() { throw Error("Unexpected execution confirmation"); } } },
    "node:fs/promises": { realpath: async value => value, readFile: async () => "" },
    "../instances/macos": { projectIcon: () => ({}) },
    "../instances/repository": require("../dist/instances/repository.js"),
    "../project/files": { entryFile: "morka.project.json", digest: require("../dist/project/files.js").digest,
      info: async path => options.saved && path.endsWith("active.json") ? { isFile: () => true } : undefined, snapshot: async () => current },
    "../project/project": { compileProject: async value => {
      if (value instanceof Error) throw value;
      return value;
    } },
    "../project/live-preview": { LivePreview },
    "../project/managed-runtime": { ManagedRuntime: Managed },
    "../agents/registry": { AgentRegistry: { open: async () => ({ close() {} }) } },
    "../agents/sessions": { ChatSessions: { open: async () => chats } },
    "../agent-actions/runner": { AgentRunner: class { close() {} async run(project, action, input) {
      return { action, input, revision: project.revision };
    } } },
  };
  const module = { exports: {} };
  const source = readFileSync(join(__dirname, "../dist/electron/main.js"), "utf8");
  runInNewContext(source.slice(0, source.indexOf("void start().catch")) + "\nmodule.exports = { createWindow };", {
    require: name => mocks[name] ?? (name.startsWith("node:") ? require(name) : {}),
    module, exports: module.exports, __dirname: "/fixture/engine", process: { ...process, resourcesPath: "/fixture/resources" }, console, setImmediate,
  });
  await module.exports.createWindow({ projectDirectory: options.root ?? "/fixture/app", id: "fixture", name: "Fixture" });
  const invoke = (name, ...args) => handlers.get(name)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  return { window, messages, invoke, managed: () => managed,
    state: () => invoke("runtime:state"), preview: () => invoke("canvas:current"),
    async edit(next) {
      current = next;
      await invoke("chat:send", "chat", "edit", "");
      await tick();
    },
  };
}

test("the app window starts a managed Node release and uses its stable preview origin", async () => {
  const runtime = { type: "node", script: "start", url: "http://127.0.0.1:0/", ready: "http://127.0.0.1:0/health" };
  const h = await harness(project(runtime));
  await tick();
  assert.equal(h.state().status, "running", h.state().detail);
  assert.equal(h.preview(), "http://127.0.0.1:42000/");
  assert.equal(h.managed().spec.type, "node");
  h.window.close(); await tick();
  assert.equal(h.managed().spec, undefined);
});

test("a failed managed update leaves the running app's preview and release intact", async () => {
  const options = {};
  const runtime = { type: "node", script: "start", url: "http://127.0.0.1:0/", ready: "http://127.0.0.1:0/health" };
  const h = await harness({ ...project(runtime), revision: "working-actions" }, options);
  await tick();
  const active = h.managed().sourceFiles;
  options.failManaged = true;
  await h.edit({ ...project(runtime), revision: "broken-actions" });
  assert.equal(h.state().status, "error");
  assert.equal(h.preview(), "http://127.0.0.1:42000/");
  assert.equal(h.managed().sourceFiles, active);
  h.window.webContents.mainFrame.frames = [{ name: "morka-preview", url: h.preview(), async executeJavaScript() {} }];
  const action = await h.invoke("addon:invoke", h.preview(), { type: "runAgentAction", action: "echo", input: {} });
  assert.equal(action.value.revision, "working-actions");
  h.window.close(); await tick();
});

test("a restart opens the saved UI and AI actions when the checkout no longer compiles", async () => {
  const runtime = { type: "node", script: "start", url: "http://127.0.0.1:0/", ready: "http://127.0.0.1:0/health" };
  const h = await harness(new Error("broken manifest"), { saved: { ...project(runtime), revision: "working-actions" } });
  await tick();
  assert.match(h.state().detail, /Opened the last working release/);
  assert.equal(h.preview(), "http://127.0.0.1:42000/");
  const frame = { name: "morka-preview", url: h.preview(), async executeJavaScript() {} };
  h.window.webContents.mainFrame.frames = [frame];
  const action = await h.invoke("addon:invoke", h.preview(), { type: "runAgentAction", action: "echo", input: {} });
  assert.equal(action.value.revision, "working-actions");
  await h.invoke("runtime:retry");
  assert.equal(h.preview(), "http://127.0.0.1:42000/");
  h.window.close();
  await tick();
});

test("managed app host actions accept only the active preview's origin", async () => {
  const runtime = { type: "node", script: "start", url: "http://127.0.0.1:0/", ready: "http://127.0.0.1:0/health" };
  const h = await harness(project(runtime)); await tick();
  const frame = { name: "name-changed-by-a-library", url: "http://127.0.0.1:42000/nested", async executeJavaScript() {} };
  h.window.webContents.mainFrame.frames = [frame];
  const request = { type: "runAgentAction", action: "echo", input: { value: "kept" } };
  const result = await h.invoke("addon:invoke", "http://127.0.0.1:42000/", request);
  assert.equal(result.value.action, "echo"); assert.equal(result.value.input.value, "kept");
  assert.ok((await h.invoke("addon:invoke", "http://127.0.0.1:43000/", request)).error);
  frame.url = "https://external.example/";
  assert.ok((await h.invoke("addon:invoke", "http://127.0.0.1:42000/", request)).error);
  h.window.close(); await tick();
});

test("a startup error can be retried", async () => {
  const runtime = { type: "node", script: "start", url: "http://127.0.0.1:0/", ready: "http://127.0.0.1:0/health" };
  const h = await harness(project(runtime), { failManaged: true });
  await tick();
  assert.equal(h.state().status, "error");
  await h.invoke("runtime:retry");
  assert.equal(h.state().status, "running");
  h.window.close();
  await tick();
});

test("closing during startup stops the runtime", async () => {
  const runtime = { type: "node", script: "start", url: "http://127.0.0.1:0/", ready: "http://127.0.0.1:0/health" };
  const h = await harness(project(runtime), { wait: true });
  await tick();
  assert.equal(h.state().status, "starting");
  h.window.close();
  await tick();
  assert.equal(h.managed().stopped, true);
  assert.equal(h.window.isDestroyed(), true);
});
