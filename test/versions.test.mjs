import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-versions.mjs", import.meta.url));

function check(t, change = () => {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), "morka-versions-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const version = "0.2.1";
  const files = {
    "package.json": { version },
    "packages/runtime/package.json": { version },
    "packages/packager/package.json": { version, peerDependencies: { "@morkaai/runtime": version } },
    "package-lock.json": { version, packages: { "": { version } } },
  };
  change(files);
  for (const [name, manifest] of Object.entries(files)) {
    const target = path.join(cwd, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(manifest));
  }
  return spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
}

test("accepts a coordinated release", (t) => {
  const result = check(t);
  assert.equal(result.status, 0, result.stderr);
});

for (const [label, change, diagnostic] of [
  ["runtime version", (f) => { f["packages/runtime/package.json"].version = "0.3.0"; }, "packages/runtime/package.json"],
  ["packager version", (f) => { f["packages/packager/package.json"].version = "0.3.0"; }, "packages/packager/package.json"],
  ["runtime peer range", (f) => { f["packages/packager/package.json"].peerDependencies["@morkaai/runtime"] = "^0.2.1"; }, "@morkaai/runtime"],
  ["outer lockfile version", (f) => { f["package-lock.json"].version = "0.1.0"; }, "package-lock.json"],
  ["missing locked root version", (f) => { delete f["package-lock.json"].packages[""].version; }, "package-lock.json"],
  ["missing root version", (f) => { delete f["package.json"].version; }, "package.json"],
]) {
  test(`rejects ${label} drift`, (t) => {
    const result = check(t, change);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(diagnostic), result.stderr);
  });
}
