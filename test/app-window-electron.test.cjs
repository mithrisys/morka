const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { cp, mkdir, readFile, realpath, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { app, dialog, Menu } = require("electron");
const { AgentRegistry } = require("../dist/agents/registry.js");
const { starterManifest } = require("../dist/project/project.js");

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message);
    await delay(30);
  }
}

async function testApp() {
  const workspace = await realpath(process.env.MORKA_PREVIEW_TEST_DIR);
  const repository = join(workspace, "Circle Project");
  const source = join(repository, "app");
  const name = "Circle Project";
  await mkdir(join(repository, ".morka"), { recursive: true });
  await cp(join(__dirname, "../dist/app-runtime/starter"), source, { recursive: true });
  await writeFile(join(source, "morka.project.json"), JSON.stringify(starterManifest));
  await writeFile(join(repository, ".morka", "release.json"), JSON.stringify({
    version: 1, id: randomUUID(), name, iconColor: 0,
  }));
  app.setPath("appData", workspace);
  app.setName("Morka");
  dialog.showErrorBox = (title, message) => { console.error(title, message); app.exit(1); };
  await app.whenReady();
  process.env.MORKA_NPM_REPOSITORY = repository;

  const request = "Put a circle on the center of the page";
  const finishEditing = Promise.withResolvers();
  const finishReviewing = Promise.withResolvers();
  let editing = false;
  let reviewing = false;
  const connection = {
    async options() { return { models: [] }; },
    async prompt(turn) {
      assert.equal(turn.text, request);
      editing = true;
      await finishEditing.promise;
      const html = await readFile(join(turn.cwd, "index.html"), "utf8");
      await writeFile(join(turn.cwd, "index.html"), html.replace("<body></body>", '<body><div id="circle"></div></body>'));
      await writeFile(join(turn.cwd, "styles.css"), "body { margin: 0; display: grid; place-items: center; min-height: 100vh; }\n" +
        "#circle { width: 80px; height: 80px; background: blue; border-radius: 50%; }\n");
      await writeFile(join(turn.cwd, "morka.preview.json"), JSON.stringify({ steps: [{ kind: "expect", selector: "#circle" }] }));
      turn.onMessage({ id: "reply", role: "assistant", text: "I added a centered circle." });
      return "completed";
    },
    supportsImages: true,
    reviewConnection() {
      return {
        async prompt(turn) {
          if (!turn.attachments) return "interrupted";
          assert.equal(turn.attachments?.length, 4);
          reviewing = true;
          await finishReviewing.promise;
          turn.onMessage({ id: "report", role: "assistant", text: "Circle lacks contrast at 640 px." });
          return "completed";
        },
        close() {},
      };
    },
  };
  const provider = { id: "mock", name: "Test Agent" };
  AgentRegistry.open = async () => ({
    get: () => ({ info: provider, connection }), providers: () => [provider],
    setup: async () => [{ ...provider, state: "ready", supportsActions: true }], close() {},
  });

  const created = once(app, "browser-window-created", { signal: AbortSignal.timeout(5000) });
  require("../dist/electron/main.js");
  const [, window] = await created;
  const contents = window.webContents;
  await once(contents, "did-finish-load", { signal: AbortSignal.timeout(5000) });
  const evaluate = script => contents.executeJavaScript(script);
  const frame = () => contents.mainFrame.frames.find(item => item.name === "morka-preview");
  const isActive = () => evaluate("document.querySelector('#agent-indicator').dataset.active === 'true'");

  const outcomes = await Promise.allSettled([
    (async () => {
      await waitFor(() => evaluate("document.querySelector('.wordmark').textContent === 'Circle Project'"), "The title bar should show the project name");
      assert.equal(window.getTitle(), name);
      assert.equal(await evaluate("document.title"), name);
      if (process.platform === "darwin") assert.equal(Menu.getApplicationMenu().items[0].label, name);
    })(),
    (async () => {
      try {
        await waitFor(() => frame()?.url.startsWith("http://"), "The starter app did not load", 20000);
        await evaluate(`document.querySelector('#chat-toggle').click();
          const input = document.querySelector('#prompt');
          input.value = ${JSON.stringify(request)};
          input.dispatchEvent(new Event('input'));
          input.form.requestSubmit();`);
        await waitFor(() => editing && isActive(), "The indicator should show the agent working");
        finishEditing.resolve();
        await waitFor(() => reviewing, "The visual review did not start", 20000);
        await waitFor(() => frame()?.executeJavaScript(`(() => {
          const circle = document.querySelector('#circle');
          if (!circle) return false;
          const box = circle.getBoundingClientRect();
          return box.width === 80 && Math.abs(box.left + box.width / 2 - innerWidth / 2) < 1 &&
            Math.abs(box.top + box.height / 2 - innerHeight / 2) < 1 && getComputedStyle(circle).borderRadius === '50%';
        })()`), "The circle should be visible while the visual review is still pending");
        assert.equal(await isActive(), false, "The chat turn should have finished");
        finishReviewing.resolve();
        await waitFor(() => evaluate("document.querySelector('#transcript').textContent.includes('Review needs attention')"), "The review finding should be reported in chat");
        assert.match(await readFile(join(source, "index.html"), "utf8"), /id="circle"/);
      } finally {
        finishEditing.resolve();
        finishReviewing.resolve();
      }
    })(),
  ]);

  try {
    assert.equal(await evaluate("document.querySelector('#agent-indicator').tagName"), "BUTTON");
    assert.equal(await evaluate("document.querySelector('#agent-setup-open') === null"), true);
    window.focus();
    await evaluate("document.querySelector('#agent-indicator').focus()");
    await waitFor(() => evaluate("document.hasFocus() && document.activeElement.id === 'agent-indicator'"),
      "The AI setup button should have keyboard focus");
    contents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await waitFor(() => evaluate("document.querySelector('#agent-setup[open] #agent-setup-accounts')?.textContent.includes('Test Agent')"), "Keyboard activation should open AI setup");
    await evaluate("document.querySelector('#agent-setup').close()");
    assert.equal(await evaluate("document.activeElement.id"), "agent-indicator");
    const gaps = await evaluate(`Array.from(document.querySelector('#transcript').children)
      .map(item => item.getBoundingClientRect()).slice(1)
      .map((box, i) => box.top - document.querySelector('#transcript').children[i].getBoundingClientRect().bottom)`);
    assert.ok(gaps.length >= 2 && gaps.every(gap => gap >= 14), `Expected spacing between chat messages, got ${gaps.join(', ')}`);
  } catch (error) {
    outcomes.push({ status: "rejected", reason: error });
  }
  const errors = outcomes.filter(outcome => outcome.status === "rejected").map(outcome => outcome.reason);
  const closed = once(window, "closed", { signal: AbortSignal.timeout(5000) });
  window.close();
  await closed;
  if (errors.length) throw new AggregateError(errors, "App workspace checks failed");
}

testApp().then(() => {
  console.log("PASS: project title, AI setup indicator, and a centered circle published before visual review finishes.");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
