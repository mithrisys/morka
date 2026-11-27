const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { MacUpdates, runningProject, updateError } = require("../dist/electron/macos-updates.js");
const { mkdtemp, mkdir, rm, symlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

test("only newer releases on the installed channel that preserve project APIs can download", () => {
  const compatible = { version: "1.1.0", supportedRuntimeApis: [1, 2] };
  assert.equal(updateError("1.0.0", [1], compatible), undefined);
  assert.match(updateError("1.0.0", [1], { ...compatible, version: "1.1.0-beta.1" }), /channel/);
  assert.equal(updateError("1.1.0-beta.9", [1], { ...compatible, version: "1.1.0-beta.10" }), undefined);
  assert.match(updateError("1.1.0-beta.9", [1], { ...compatible, version: "1.2.0-alpha.10" }), /channel/);
  assert.match(updateError("1.1.0", [1], compatible), /newer/);
  assert.match(updateError("1.0.0", [1], { ...compatible, supportedRuntimeApis: [2] }), /runtime API/);
});

test("an update waits for download approval and a safe, explicit restart", async () => {
  const client = new EventEmitter();
  let checks = 0;
  let installs = 0;
  let downloads = 0;
  const candidate = { version: "1.1.0", supportedRuntimeApis: [1], files: [{ url: "morka-1.1.0-macOS-arm64.zip" }] };
  client.checkForUpdates = async () => { checks++; return { isUpdateAvailable: true, updateInfo: candidate }; };
  client.downloadUpdate = async () => { downloads++; };
  client.quitAndInstall = () => { installs++; };
  const states = [];
  const updater = new MacUpdates(client, "1.0.0", [1], state => states.push(state.status));

  await Promise.all([updater.check(), updater.check()]);
  assert.equal(checks, 1);
  assert.equal(downloads, 0);
  assert.equal(client.autoDownload, false);
  assert.deepEqual(updater.state, { status: "available", version: "1.1.0" });
  await updater.check();
  assert.equal(checks, 1);
  assert.equal(downloads, 0);
  await Promise.all([updater.download(), updater.download()]);
  assert.equal(downloads, 1);
  assert.equal(client.autoInstallOnAppQuit, false);
  assert.equal(updater.state.status, "ready");
  assert.equal(installs, 0);
  await updater.restart(async () => { throw new Error("Close your open projects to install the update."); });
  assert.equal(updater.state.status, "ready");
  assert.match(updater.state.detail, /Close your open projects/);
  await updater.restart(async () => {});
  assert.equal(installs, 1);
  assert.deepEqual(states, ["checking", "available", "downloading", "ready", "installing", "ready", "installing"]);
  client.emit("error", new Error("macOS rejected the signature"));
  assert.equal(updater.state.status, "error");
  await updater.check();
  assert.equal(updater.state.status, "available");
  assert.equal(downloads, 1);
  await updater.download();
  assert.equal(updater.state.status, "ready");
  client.emit("error", new Error("Ignored outside installation"));
  assert.equal(updater.state.status, "ready");
});

test("the updater rejects a mismatched archive before downloading it", async () => {
  const client = new EventEmitter();
  client.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: { version: "1.1.0",
    supportedRuntimeApis: [1], files: [{ url: "morka-1.1.0-macOS-x64.zip" }] } });
  client.downloadUpdate = () => assert.fail("The archive must be rejected before downloading");
  const updater = new MacUpdates(client, "1.0.0", [1], () => {});
  await updater.check();
  assert.equal(updater.state.status, "error");
  assert.match(updater.state.detail, /Apple Silicon/);
});

test("installed projects block restart until their process locks are released", { skip: process.platform !== "darwin" }, async t => {
  const library = await mkdtemp(join(tmpdir(), "morka-update-projects-"));
  t.after(() => rm(library, { recursive: true, force: true }));
  const profile = join(library, "instances", "project");
  await mkdir(profile, { recursive: true });
  const lock = join(profile, "SingletonLock");
  assert.equal(await runningProject(library), false);
  await symlink(`test-host-${process.pid}`, lock);
  assert.equal(await runningProject(library), true);
  await rm(lock);
  assert.equal(await runningProject(library), false);
});
