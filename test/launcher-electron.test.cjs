const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { EventEmitter, once } = require("node:events");
const { mkdir, readFile, realpath, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, dialog, Menu } = require("electron");

async function testLauncher() {
  const workspace = await realpath(process.env.MORKA_PREVIEW_TEST_DIR);
  app.setPath("appData", workspace);
  const project = join(workspace, "Wake Test");
  await mkdir(join(project, ".morka"), { recursive: true });
  await mkdir(join(project, "app"));
  const release = { version: 1, id: randomUUID(), name: "Wake Test", iconColor: 0 };
  await writeFile(join(project, ".morka", "release.json"), JSON.stringify(release));
  await writeFile(join(project, "app", "morka.project.json"), '{"version":1,"runtime":{"type":"node"}}');
  const git = (...args) => execFileSync("git", args, { cwd: project, windowsHide: true });
  git("init", "--quiet");
  git("add", ".");
  git("-c", "user.name=Morka Test", "-c", "user.email=test@example.com", "-c", "commit.gpgSign=false",
    "commit", "--quiet", "--no-verify", "-m", "Add test project");
  const archivePath = join(workspace, "project.zip");
  git("archive", "--format=zip", "--prefix=project/", "-o", archivePath, "HEAD");

  const picker = new EventEmitter();
  let nextPath;
  dialog.showOpenDialog = async (_window, options) => {
    const path = nextPath;
    nextPath = undefined;
    picker.emit("open", options);
    return { canceled: !path, filePaths: path ? [path] : [] };
  };
  const desktop = require("../dist/instances/desktop.js");
  const handoffs = new EventEmitter();
  const updateClient = new EventEmitter();
  let updateDownloads = 0;
  let updateInstalls = 0;
  let projectRunning = true;
  const desktopUpdates = require("../dist/electron/desktop-updates.js");
  desktopUpdates.runningProject = async () => projectRunning;
  updateClient.checkForUpdates = async () => ({ isUpdateAvailable: true,
    updateInfo: { version: "1.1.0", supportedRuntimeApis: [1], files: [
      { url: "morka-1.1.0-macOS-arm64.zip", sha512: Buffer.alloc(64).toString("base64"), size: 1 },
    ] } });
  updateClient.downloadUpdate = async () => { updateDownloads++; };
  updateClient.quitAndInstall = () => {
    updateInstalls++;
    updateClient.emit("error", new Error("Test installation stopped."));
  };
  desktopUpdates.updatesForLauncher = async (_runtime, notify) => new desktopUpdates.DesktopUpdates(updateClient, "1.0.0", [1], notify,
    { arch: "arm64", format: "zip" });
  const installed = new Set();
  const launches = [];
  let failInstall = true;
  desktop.openInstalledProject = async (repository, spec) => {
    assert.deepEqual(spec, release);
    if (!installed.has(repository)) return false;
    launches.push(["open", repository]);
    return true;
  };
  desktop.installRepository = async (repository, spec) => {
    assert.deepEqual(spec, release);
    if (failInstall) throw new Error("Test installation failed.");
    installed.add(repository);
    launches.push(["install", repository]);
  };
  const quit = app.quit;
  app.quit = () => handoffs.emit("quit");

  const created = once(app, "browser-window-created");
  require("../dist/electron/main.js");
  const [, window] = await created;
  if (process.platform === "linux" || process.platform === "win32") {
    assert.equal(Menu.getApplicationMenu(), null, "The launcher must remove Electron's default menu");
    assert.equal(window.isMenuBarVisible(), false);
  }
  const contents = window.webContents;
  await once(contents, "did-finish-load");
  const evaluate = script => contents.executeJavaScript(script);
  const waitForUpdate = text => evaluate(`(async () => {
    const deadline = Date.now() + 5000;
    while (!document.querySelector('#launcher-update-status').textContent.includes(${JSON.stringify(text)})) {
      if (Date.now() >= deadline) throw Error('Expected update status to include ' + ${JSON.stringify(text)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
  await waitForUpdate("1.1.0 is available");
  assert.equal(updateDownloads, 0);
  assert.equal(await evaluate("document.querySelector('#launcher-update-action').textContent"), "Download update");
  await evaluate("document.querySelector('#launcher-update-action').click()");
  await waitForUpdate("1.1.0 is ready");
  assert.equal(updateDownloads, 1);
  assert.equal(await evaluate("document.querySelector('#launcher-update-action').textContent"), "Restart to update");
  await evaluate("document.querySelector('#launcher-update-action').click()");
  await waitForUpdate("Close your open projects");
  assert.equal(updateInstalls, 0);
  projectRunning = false;
  await evaluate("document.querySelector('#launcher-update-action').click()");
  await waitForUpdate("Test installation stopped");
  assert.equal(updateInstalls, 1);
  await evaluate("document.querySelector('#new-app').click()");
  assert.equal(await evaluate("Boolean(document.querySelector('dialog[open] #app-name'))"), true,
    "Activating the launcher must open the project naming dialog");
  const createFolder = once(picker, "open", { signal: AbortSignal.timeout(5000) });
  await evaluate(`document.querySelector('#app-name').value = 'Launcher Test';
    document.querySelector('#app-name').form.requestSubmit();`);
  assert.equal((await createFolder)[0].title, "Choose where to create “Launcher Test”");
  await evaluate("document.querySelector('#app-name').closest('dialog').close()");
  assert.deepEqual(await evaluate(`(() => {
    const wake = document.querySelector('#wake-project');
    return wake && [wake.textContent.trim(), getComputedStyle(wake).textDecorationLine,
      wake.getBoundingClientRect().top >= document.querySelector('#birth-caption').getBoundingClientRect().bottom];
  })()`), ["or wake up a morka…", "underline", true]);
  const buttonCenter = await evaluate(`(() => {
    const { x, y, width, height } = document.querySelector('#wake-project').getBoundingClientRect();
    return { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
  })()`);
  contents.sendInputEvent({ type: "mouseMove", ...buttonCenter });
  assert.deepEqual(await evaluate(`new Promise(resolve => requestAnimationFrame(() => {
    const wake = document.querySelector('#wake-project');
    resolve([wake.matches(':hover'), getComputedStyle(wake).backgroundColor]);
  }))`), [true, "rgba(0, 0, 0, 0)"]);
  await evaluate("document.querySelector('#wake-project').click()");
  const ready = () => evaluate(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    function check() {
      if (!document.querySelector('#wake-folder').disabled) resolve();
      else if (performance.now() >= deadline) reject(new Error('Wake controls did not reset'));
      else setTimeout(check, 20);
    }
    check();
  })`);
  const pick = async (selector, path) => {
    await ready();
    nextPath = path;
    const opened = once(picker, "open", { signal: AbortSignal.timeout(5000) });
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    return (await opened)[0];
  };
  const wake = async (selector, path) => {
    const handedOff = once(handoffs, "quit", { signal: AbortSignal.timeout(5000) });
    await pick(selector, path);
    await handedOff;
    return launches.at(-1);
  };
  assert.deepEqual((await pick("#wake-folder")).properties, ["openDirectory"]);
  const archiveOptions = await pick("#wake-archive");
  assert.deepEqual(archiveOptions.properties, ["openFile"]);
  assert.ok(archiveOptions.filters[0].extensions.includes("zip"));
  assert.equal(await evaluate("document.querySelector('#wake-git-url').labels[0].textContent"), "or its git url");
  assert.equal(await evaluate("document.querySelector('#wake-dialog button[type=submit]').textContent"), "Launch");

  await pick("#wake-folder", project);
  await ready();
  assert.equal(await evaluate("document.querySelector('#wake-status').textContent"), "Test installation failed.");
  assert.equal(window.isDestroyed(), false);
  failInstall = false;
  assert.deepEqual(await wake("#wake-folder", project), ["install", project]);
  assert.deepEqual(await wake("#wake-folder", project), ["open", project]);

  const [archiveAction, extracted] = await wake("#wake-archive", archivePath);
  assert.equal(archiveAction, "install");
  assert.notEqual(extracted, project);
  assert.deepEqual(JSON.parse(await readFile(join(extracted, ".morka", "release.json"), "utf8")), release);
  assert.deepEqual(await wake("#wake-archive", archivePath), ["open", extracted]);

  await ready();
  await evaluate(`document.querySelector('#wake-git-url').value = 'not a Git URL';
    document.querySelector('#wake-dialog form').requestSubmit();`);
  await ready();
  assert.match(await evaluate("document.querySelector('#wake-status').textContent"), /Enter a Git repository URL/);
  app.quit = quit;
  const quitting = new Promise(resolve => app.once("will-quit", event => { event.preventDefault(); resolve(); }));
  await evaluate(`document.querySelector('#wake-git-url').value = ${JSON.stringify(pathToFileURL(project).href)};
    document.querySelector('#wake-dialog form').requestSubmit();`);
  await quitting;
  assert.equal(window.isDestroyed(), true);
  const [gitAction, cloned] = launches.at(-1);
  assert.equal(gitAction, "install");
  assert.notEqual(cloned, project);
  assert.notEqual(cloned, extracted);
  assert.deepEqual(JSON.parse(await readFile(join(cloned, ".morka", "release.json"), "utf8")), release);
}

testLauncher().then(() => {
  console.log("PASS: the launcher wakes folder, archive and Git projects, reuses installations, and closes after launch.");
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
