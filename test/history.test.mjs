import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-history.mjs", import.meta.url));

function repository(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "morka-history-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=Morka Test", "-c", "user.email=test@example.org",
    "-c", "commit.gpgsign=false", ...args,
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (subject) => git("commit", "--allow-empty", "-m", subject);
  const check = (...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
  git("init", "-b", "main");
  commit("Existing history");
  git("switch", "-c", "fix/42-preview-state");
  return { git, commit, check };
}

test("checks only the topic commits against main by default", (t) => {
  const { commit, check } = repository(t);
  commit("test: cover preview state");
  commit("fix(desktop): preserve preview state");
  const result = check();
  assert.equal(result.status, 0, result.stderr);
});

test("uses the supplied PR head and branch in a detached checkout", (t) => {
  const { git, commit, check } = repository(t);
  commit("feat(runtime)!: change the manifest contract");
  const head = git("rev-parse", "HEAD");
  git("switch", "--detach", "main");
  const result = check("main", head, "feat/manifest-contract");
  assert.equal(result.status, 0, result.stderr);
});

test("rejects an earlier invalid commit even when the tip is valid", (t) => {
  const { commit, check } = repository(t);
  commit("wip");
  commit("fix: preserve preview state");
  const result = check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wip/);
});

test("rejects malformed types, scopes, and empty summaries", (t) => {
  const { commit, check } = repository(t);
  for (const title of ["update: add retries", "fix(): retry", "fix:"]) commit(title);
  const result = check();
  assert.equal(result.status, 1);
  for (const title of ["update: add retries", "fix(): retry", "fix:"]) {
    assert.ok(result.stderr.includes(title), result.stderr);
  }
});

test("requires a typed kebab-case topic branch", (t) => {
  const { check } = repository(t);
  for (const branch of ["main", "updates/retry", "fix/Preview_State", "fix/42", "fix/a--b"]) {
    const result = check("main", "HEAD", branch);
    assert.equal(result.status, 1, branch);
    assert.ok(result.stderr.includes(branch), result.stderr);
  }
});
