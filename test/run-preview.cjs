const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const electron = require("electron");

const workspace = mkdtempSync(join(tmpdir(), "morka-preview-"));
try {
  execFileSync(electron, [join(__dirname, "live-preview-electron.test.cjs")], {
    env: { ...process.env, MORKA_PREVIEW_TEST_DIR: workspace },
    stdio: "inherit",
    timeout: 90_000,
    killSignal: "SIGKILL",
  });
} finally {
  // Chromium holds its profile open for the lifetime of the Electron process.
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
}
