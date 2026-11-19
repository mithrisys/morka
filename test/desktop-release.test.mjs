import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseNotes, desktopAssets, writeChecksums } from "../scripts/releases/metadata.mjs";

test("release notes select one exact dated version and retain its subsections", () => {
  const log = "# Changelog\r\n## 1.0.0 (2026-11-20)\r\nFirst stable.\r\n## 1.0.0-beta.1 (2026-11-19)\r\n### Fixes\r\n\r\n- A fix.\r\n";
  assert.equal(releaseNotes(log, "1.0.0-beta.1"), "### Fixes\n\n- A fix.\n");
  assert.throws(() => releaseNotes(log, "1.0.1"));
  assert.throws(() => releaseNotes(log + log, "1.0.0"));
  assert.throws(() => releaseNotes("## 1.0.0 (2026-11-20)\n", "1.0.0"));
});

test("checksums cover the exact three desktop downloads and reject missing or extra files", async t => {
  const dir = await mkdtemp(join(tmpdir(), "morka-checksums-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = Object.values(desktopAssets("1.2.3")).sort();
  assert.deepEqual(files, ["morka-1.2.3-Linux-x64.tar.gz", "morka-1.2.3-Windows-x64-Setup.exe", "morka-1.2.3-macOS-arm64.dmg"]);
  await assert.rejects(writeChecksums(dir, "1.2.3"));
  for (const file of files) await writeFile(join(dir, file), "abc");
  await writeChecksums(dir, "1.2.3");
  const sum = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(await readFile(join(dir, "SHA256SUMS.txt"), "utf8"), files.map(file => sum + "  " + file + "\n").join(""));
  await writeFile(join(dir, "unexpected"), "extra");
  await assert.rejects(writeChecksums(dir, "1.2.3"));
});
