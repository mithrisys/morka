const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { app, dialog, Menu } = require("electron");

async function testLauncher() {
  app.setPath("appData", process.env.MORKA_PREVIEW_TEST_DIR);
  const picker = new EventEmitter();
  dialog.showOpenDialog = async (_window, options) => {
    picker.emit("open", options.title);
    return { canceled: true, filePaths: [] };
  };

  const created = once(app, "browser-window-created");
  require("../dist/electron/main.js");
  const [, window] = await created;
  if (process.platform === "linux") {
    assert.equal(Menu.getApplicationMenu(), null);
    assert.equal(window.isMenuBarVisible(), false);
  }
  const contents = window.webContents;
  await once(contents, "did-finish-load");
  const evaluate = script => contents.executeJavaScript(script);
  await evaluate("document.querySelector('#new-app').click()");
  assert.equal(await evaluate("Boolean(document.querySelector('dialog[open] #app-name'))"), true,
    "Activating the launcher must open the project naming dialog");
  const createFolder = once(picker, "open", { signal: AbortSignal.timeout(5000) });
  await evaluate(`document.querySelector('#app-name').value = 'Launcher Test';
    document.querySelector('dialog form').requestSubmit();`);
  assert.deepEqual(await createFolder, ["Choose where to create “Launcher Test”"]);
  await evaluate("document.querySelector('dialog').close()");
  const openFolder = once(picker, "open", { signal: AbortSignal.timeout(5000) });
  await evaluate("document.querySelector('#open-project').click()");
  assert.deepEqual(await openFolder, ["Open a Morka project"]);
}

testLauncher().then(() => {
  console.log("PASS: the launcher opens both create and open project dialogs.");
  app.exit(0);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
