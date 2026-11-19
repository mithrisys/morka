// Run inside the unpacked or installed download, using its own scaffold and toolchain.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [executable, resources] = process.argv.slice(2).map(value => resolve(value));
const local = createRequire(join(resources, "app/package.json"));
const { materializeRepository, repositoryProfileId, bundledKit, appsDirectory } = local("./dist/instances/repository.js");
const { snapshot, entryFile } = local("./dist/project/files.js");
const { starterManifest, jsonFile } = local("./dist/project/project.js");
const { bundledToolchain } = local("./dist/project/toolchain.js");
const { writableTree } = local("./dist/project/packages.js");
const work = await realpath(await mkdtemp(join(tmpdir(), "morka-download-")));
const spec = { version: 1, id: randomUUID(), name: "Release Smoke", iconColor: 0 };
let child, profile;
try {
  if (process.platform !== "darwin") {
    const locales = await readdir(join(resources, "../locales"));
    assert.ok(locales.includes("en-US.pak") && locales.every(name => /^en(?:-[A-Z]+)?\.pak$/.test(name)));
  }
  const appRoot = join(resources, "app");
  const tools = await bundledToolchain(join(appRoot, "dist/toolchain"));
  assert.equal(execFileSync(tools.node, [tools.npm, "--version"], { encoding: "utf8" }).trim(), JSON.parse(tools.identity).npm);
  const files = await snapshot(join(appRoot, "dist/app-runtime/starter"));
  files.set(entryFile, jsonFile(starterManifest));
  const repo = await materializeRepository(work, spec, files, join(resources, bundledKit), await readFile(join(appRoot, "dist/branding/Morka.icns")));
  const env = { ...process.env, MORKA_NPM_REPOSITORY: repo, XDG_CONFIG_HOME: work };
  for (const key of ["MORKA_LOCAL_NODE", "MORKA_LOCAL_NPM", "MORKA_NPM_KIT", "MORKA_DESKTOP_TOOLCHAIN", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  const appData = process.platform === "darwin" ? join(homedir(), "Library/Application Support")
    : process.platform === "win32" ? process.env.APPDATA : work;
  profile = join(appsDirectory(appData), "instances", repositoryProfileId(spec, repo));
  const origin = join(profile, "runtime", spec.id, "origin.json");
  // Observe the shell and its live preview in the packaged Chromium instance.
  const probe = createServer();
  await new Promise((done, fail) => probe.once("error", fail).listen(0, "127.0.0.1", done));
  const debugPort = probe.address().port;
  await new Promise(done => probe.close(done));
  child = spawn(executable, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${debugPort}`], {
    cwd: work, env, stdio: "inherit",
  });
  let error;
  child.on("error", reason => { error = reason; });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (error) throw error;
    assert.equal(child.exitCode, null, "The packaged desktop exited before the starter was ready");
    if (existsSync(origin)) {
      const { port } = JSON.parse(await readFile(origin, "utf8"));
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(reply => reply.json()).catch(() => []);
      const rendered = targets.some(target => target.type === "page" && target.url.endsWith("/renderer/index.html"))
        && targets.some(target => target.url === `http://127.0.0.1:${port}/`);
      if (!rendered) { await delay(300); continue; }
      const health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      if (health?.ok && await health.text() === "ready") {
        const page = await fetch(`http://127.0.0.1:${port}/`);
        assert.ok(page.ok && (await page.text()).includes("<html"));
        console.log("PASS: the installed desktop rendered the project window and served a fresh starter using the bundled Node and npm.");
        break;
      }
    }
    await delay(300);
  }
  assert.ok(Date.now() < deadline, "Timed out waiting for the packaged starter");
} finally {
  if (child?.pid && child.exitCode === null) {
    const closed = new Promise(done => child.once("close", done));
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    else child.kill("SIGTERM");
    await closed;
  }
  for (const dir of [profile, work]) {
    if (dir && existsSync(dir)) {
      await writableTree(dir);
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 500 });
    }
  }
}
