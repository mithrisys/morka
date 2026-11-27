const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const { app } = require("electron");

const run = promisify(execFile);

async function waitFor(check) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { return await check(); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

async function testSharedInstall(root, support, source) {
  const { setBundleIdentity, signBundle } = require("../dist/instances/distribution.js");
  const { writeDesktopRuntime } = require("../dist/instances/desktop-runtimes.js");
  const { materializeRepository, repositoryProfileId } = require("../dist/instances/repository.js");
  const { makeIcon } = require("../dist/instances/macos.js");
  const { writableTree } = require("../dist/project/packages.js");
  const kit = join(root, "dist/npm");
  const host = join(temporary, "Morka.app");
  const previousHost = join(temporary, "Morka-0.2.0-test.app");
  const appRoot = join(host, "Contents/Resources/app");
  const morka = join(host, "Contents/MacOS/Morka");
  const projects = [];
  try {
    await run(join(root, "dist/toolchain/bin/node"), ["-e", `
      const [root, host, kit] = process.argv.slice(1);
      require('./dist/instances/distribution.js').buildMacBundle(root, host, kit).catch(error => {
        console.error(error);
        process.exitCode = 1;
      });
    `, root, host, kit], { cwd: root, timeout: 60_000 });
    const metadata = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
    await writeFile(join(appRoot, "package.json"), JSON.stringify({ ...metadata, main: "install-test.cjs" }));
    await writeFile(join(appRoot, "install-test.cjs"), `
      const { app } = require("electron");
      const { writeFile } = require("node:fs/promises");
      const { join } = require("node:path");
      const { installRepository, openInstalledProject, registerCurrentDesktopRuntime } = require("./dist/instances/desktop.js");
      const { readRelease, repositoryFile } = require("./dist/instances/repository.js");
      app.setPath("home", ${JSON.stringify(temporary)});
      app.setPath("appData", ${JSON.stringify(support)});
      const repository = process.argv[1];
      if (repository === "--register-runtime") {
        registerCurrentDesktopRuntime().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
      } else if (repository.startsWith("--morka-project=")) {
        app.on("browser-window-created", (_event, window) => {
          window.webContents.once("did-finish-load", async () => {
            await writeFile(join(app.getPath("userData"), "started.json"), JSON.stringify({
              pid: process.pid, name: app.name, executable: process.execPath, title: window.getTitle(),
            }));
          });
        });
        app.on("second-instance", () => { void writeFile(join(app.getPath("userData"), "reopened"), "yes"); });
        app.on("activate", (_event, hasWindows) => {
          if (hasWindows) void writeFile(join(app.getPath("userData"), "reopened"), "yes");
        });
        process.on("SIGTERM", () => app.quit());
        require("./dist/electron/main.js");
      } else {
        app.setActivationPolicy("prohibited");
        const spec = readRelease(repositoryFile(repository, "release.json"));
        app.whenReady().then(async () => {
          if (!await openInstalledProject(repository, spec)) await installRepository(repository, spec);
        }).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
      }
    `);
    await signBundle(host);
    await run("/usr/bin/ditto", [host, previousHost]);
    const previousVersion = "0.2.0-test";
    const previousResources = join(previousHost, "Contents/Resources");
    await writeFile(join(previousResources, "app/package.json"),
      JSON.stringify({ ...metadata, main: "install-test.cjs", version: previousVersion }));
    await writeDesktopRuntime(previousResources, previousVersion, "Morka");
    await setBundleIdentity(join(previousHost, "Contents/Info.plist"), {
      CFBundleIdentifier: `local.morka.runtime.${previousVersion}`,
    });
    await signBundle(previousHost);
    await run(join(previousHost, "Contents/MacOS/Morka"), ["--register-runtime"], { timeout: 15_000 });
    const testSource = new Map(source);
    testSource.set("server.mjs", Buffer.from(`
      import { createServer } from "node:http";
      import { readFile } from "node:fs/promises";
      import { join } from "node:path";
      const saved = await readFile(join(process.env.MORKA_DATA_DIR, "saved.txt"), "utf8");
      createServer((request, response) => response.end(request.url === "/health" ? "ready" :
        JSON.stringify({ saved, node: process.execPath }))).listen(Number(process.env.PORT), process.env.HOST);
    `));
    for (const [name, runtimeVersion, runtimeHost] of [
      ["Morka Shared Test A", metadata.version, host],
      ["Morka Shared Test B", previousVersion, previousHost],
      ["Morka Shared Test C", previousVersion, previousHost],
    ]) {
      const expectedExecutable = join(runtimeHost, "Contents/MacOS/Morka");
      const expectedNode = join(runtimeHost, "Contents/Resources/app/dist/toolchain/bin/node");
      const spec = { version: 1, id: require("node:crypto").randomUUID(), name, iconColor: projects.length, runtimeVersion };
      const repository = await materializeRepository(temporary, spec, testSource, kit, makeIcon(spec.iconColor));
      const profile = join(support, "Morka Apps", "instances", repositoryProfileId(spec, repository));
      const data = join(profile, "runtime-data");
      await mkdir(data, { recursive: true });
      await writeFile(join(data, "saved.txt"), name);
      const project = { profile, pid: undefined };
      projects.push(project);
      await run(morka, [repository], { timeout: 15_000 });
      const bundle = join(temporary, "Applications", `${name}.app`);
      assert.deepEqual((await readdir(join(bundle, "Contents"))).sort(), ["Info.plist", "MacOS", "Resources", "_CodeSignature"]);
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
      const launch = JSON.parse(await readFile(join(bundle, "Contents/Resources/morka-launch.json"), "utf8"));
      assert.equal(launch.runtimeVersion, runtimeVersion);
      assert.equal(await realpath(launch.host), await realpath(runtimeHost));
      const bundleSize = Number(execFileSync("/usr/bin/du", ["-sk", bundle], { encoding: "utf8" }).split(/\s+/)[0]);
      assert.ok(bundleSize <= 2 * 1024, `Expected a launcher under 2 MiB, got ${bundleSize} KiB`);
      await assert.rejects(lstat(join(repository, "node_modules")), { code: "ENOENT" });
      const receipt = join(profile, "started.json");
      const started = await waitFor(async () => JSON.parse(await readFile(receipt, "utf8")));
      project.pid = started.pid;
      assert.equal(started.name, name);
      assert.equal(started.title, name);
      assert.equal(await realpath(started.executable), await realpath(expectedExecutable));
      await waitFor(async () => {
        const { port } = JSON.parse(await readFile(join(profile, "runtime", spec.id, "origin.json"), "utf8"));
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        assert.deepEqual(await response.json(), { saved: name, node: expectedNode });
      });
      const reopened = join(profile, "reopened");
      await rm(reopened, { force: true });
      await run("/usr/bin/open", [bundle]);
      await waitFor(() => readFile(reopened, "utf8"));
      assert.equal(JSON.parse(await readFile(receipt, "utf8")).pid, project.pid);
      console.log(`PASS: ${name} is ${bundleSize} KiB, uses Morka ${runtimeVersion} and its Node, and reads its existing data.`);
    }
    assert.equal(new Set(projects.map(project => project.pid)).size, projects.length);
    assert.deepEqual((await readdir(join(support, "Morka Apps", "runtimes", `${process.platform}-${process.arch}`))).sort(),
      [`${previousVersion}.json`, `${metadata.version}.json`].sort());
  } finally {
    for (const project of projects) {
      if (project.pid) process.kill(project.pid, "SIGTERM");
      await waitFor(() => assert.rejects(lstat(join(project.profile, "SingletonSocket")), { code: "ENOENT" }));
    }
    await writableTree(temporary);
  }
}

let temporary;
(async () => {
  const root = resolve(__dirname, "..");
  temporary = await realpath(await mkdtemp(join(tmpdir(), "morka-install-test-")));
  const support = join(temporary, "Application Support");
  const profile = join(temporary, "profile");
  await Promise.all([mkdir(support), mkdir(profile)]);
  app.setPath("appData", support);
  app.setPath("home", temporary);
  app.setPath("userData", profile);
  app.setActivationPolicy("prohibited");
  await app.whenReady();

  const { installDesktopApp, openInstalledProject } = require("../dist/instances/desktop.js");
  const { makeIcon } = require("../dist/instances/macos.js");
  const { materializeRepository, readRelease, repositoryFile, repositoryProfileId } = require("../dist/instances/repository.js");
  const { entryFile, snapshot } = require("../dist/project/files.js");
  const { jsonFile, starterManifest } = require("../dist/project/project.js");
  const { bundledToolchain } = require("../dist/project/toolchain.js");
  const toolchain = await bundledToolchain(join(root, "dist/toolchain"));
  process.env.MORKA_LOCAL_NODE = toolchain.node;
  process.env.MORKA_LOCAL_NPM = toolchain.npm;
  const source = await snapshot(join(root, "dist/app-runtime/starter"));
  source.set(entryFile, jsonFile(starterManifest));
  const spec = { version: 1, id: require("node:crypto").randomUUID(), name: "Morka install test", iconColor: 0 };
  const repository = await materializeRepository(temporary, spec, source, join(root, "dist/npm"), makeIcon(spec.iconColor));
  assert.deepEqual(readRelease(repositoryFile(repository, "release.json")), spec);
  assert.equal(await openInstalledProject(repository, spec), false);
  await installDesktopApp(repository, spec, false);

  const bundle = join(temporary, "Applications", spec.name + ".app");
  const resources = join(bundle, "Contents/Resources/app");
  const launch = JSON.parse(await readFile(join(resources, "morka-launch.json"), "utf8"));
  assert.equal(launch.repository, repository);
  assert.equal(launch.profile, repositoryProfileId(spec, repository));
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);

  const engine = join(repository, "node_modules", "@morkaai", "runtime", "dist", "electron");
  const started = join(temporary, "started");
  await mkdir(engine, { recursive: true });
  await writeFile(join(engine, "main.js"), `
    const { app } = require("electron");
    app.setPath("userData", ${JSON.stringify(join(profile, "app"))});
    app.whenReady().then(() => {
      require("node:fs").writeFileSync(${JSON.stringify(started)}, process.env.MORKA_NPM_REPOSITORY);
      app.quit();
    });
  `);
  assert.equal(await openInstalledProject(repository, spec), true);
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      assert.equal(await readFile(started, "utf8"), repository);
      break;
    } catch (error) {
      if (error.code !== "ENOENT" || Date.now() >= deadline) throw error;
      await delay(40);
    }
  }
  console.log("PASS: the macOS installer registers a signed launcher and reopens the installed checkout.");
  await testSharedInstall(root, support, source);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
