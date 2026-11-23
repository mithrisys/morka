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

test("desktop downloads select the asset by platform and architecture", () => {
  assert.deepEqual(desktopAssets("1.2.3"), {
    "darwin-arm64": "morka-1.2.3-macOS-arm64.dmg",
    "win32-x64": "morka-1.2.3-Windows-x64-Setup.exe",
    "win32-arm64": "morka-1.2.3-Windows-arm64-Setup.exe",
    "linux-x64": "morka-1.2.3-Linux-x64.tar.gz",
    "linux-arm64": "morka-1.2.3-Linux-arm64.tar.gz",
  });
});

test("checksums require the exact desktop downloads for all supported architectures", async t => {
  const dir = await mkdtemp(join(tmpdir(), "morka-checksums-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = [
    "morka-1.2.3-Linux-arm64.tar.gz",
    "morka-1.2.3-Linux-x64.tar.gz",
    "morka-1.2.3-Windows-arm64-Setup.exe",
    "morka-1.2.3-Windows-x64-Setup.exe",
    "morka-1.2.3-macOS-arm64.dmg",
  ];
  for (const file of files) await writeFile(join(dir, file), "abc");
  await writeChecksums(dir, "1.2.3");
  const sum = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(await readFile(join(dir, "SHA256SUMS.txt"), "utf8"), files.map(file => sum + "  " + file + "\n").join(""));
  for (const file of files) {
    await rm(join(dir, file));
    await assert.rejects(writeChecksums(dir, "1.2.3"));
    await writeFile(join(dir, file), "abc");
  }
  await writeFile(join(dir, "unexpected"), "extra");
  await assert.rejects(writeChecksums(dir, "1.2.3"));
});

test("desktop release scaffolds pin the same archives published by the release job", async () => {
  const { publishedProjectLock } = await import("../scripts/releases/project-lock.mjs");
  const { createHash } = await import("node:crypto");
  const archives = { runtime: Buffer.from("runtime"), packager: Buffer.from("packager") };
  const input = JSON.parse(await readFile("packages/project-template/package-lock.json", "utf8"));
  for (const [name, bytes] of Object.entries(archives)) {
    Object.assign(input.packages["node_modules/@morkaai/" + name], {
      version: "0.3.0-beta.3", resolved: "file:" + name + ".tgz",
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64")
    });
  }
  input.packages["node_modules/@morkaai/packager"].peerDependencies["@morkaai/runtime"] = "0.3.0-beta.3";
  assert.throws(() => publishedProjectLock("0.3.0-beta.3", {...archives, runtime: Buffer.from("wrong")}, structuredClone(input)), /does not match/);
  const lock = publishedProjectLock("0.3.0-beta.3", archives, input);
  assert.equal(lock.packages[""].dependencies["@morkaai/runtime"], "0.3.0-beta.3");
  assert.equal(lock.packages[""].devDependencies["@morkaai/packager"], "0.3.0-beta.3");
  for (const component of ["runtime", "packager"]) {
    const pkg = lock.packages["node_modules/@morkaai/" + component];
    assert.equal(pkg.version, "0.3.0-beta.3");
    assert.equal(pkg.resolved, "https://registry.npmjs.org/@morkaai/" + component + "/-/" + component + "-0.3.0-beta.3.tgz");
    assert.equal(pkg.integrity, "sha512-" + createHash("sha512").update(component).digest("base64"));
  }
  assert.equal(lock.packages["node_modules/@morkaai/packager"].peerDependencies["@morkaai/runtime"], "0.3.0-beta.3");
});
