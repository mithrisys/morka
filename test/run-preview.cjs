const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const electron = require("electron");
const { writableTree } = require("../dist/project/packages.js");
const { npmEntry } = require("../dist/project/toolchain.js");

async function run() {
  const workspace = mkdtempSync(join(tmpdir(), "morka-preview-"));
  try {
    const env = { ...process.env, MORKA_PREVIEW_TEST_DIR: workspace };
    if (process.platform !== "darwin") {
      env.MORKA_LOCAL_NODE = process.execPath;
      env.MORKA_LOCAL_NPM = await npmEntry(process.execPath, process.env.npm_execpath);
    }
    for (const suite of ["launcher-electron.test.cjs", "app-window-electron.test.cjs", "live-preview-electron.test.cjs", "scenario-review-electron.test.cjs"]) {
      execFileSync(electron, [join(__dirname, suite)], {
        env,
        stdio: "inherit",
        timeout: 90_000,
        killSignal: "SIGKILL",
      });
    }
  } finally {
    // The managed runtime makes its prepared releases read-only.
    await writableTree(workspace);
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
