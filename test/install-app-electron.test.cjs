const assert = require("node:assert/strict");
const { execFile, execFileSync } = require("node:child_process");
const { lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { promisify } = require("node:util");
const { app } = require("electron");

const run = promisify(execFile);

async function macAppIdentity(pid) {
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
    ObjC.import('AppKit');
    function run(args) {
      const application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
      const bundle = $.NSBundle.bundleWithURL(application.bundleURL);
      return JSON.stringify({ name: ObjC.unwrap(application.localizedName),
        bundleName: ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleName')),
        visibleInDock: Number(application.activationPolicy) === 0 });
    }
  `, String(pid)]);
  return JSON.parse(stdout);
}

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
  const { materializeRepository, readRelease, repositoryFile, repositoryProfileId } = require("../dist/instances/repository.js");
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
      const { app, BrowserWindow, dialog, Menu } = require("electron");
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
        if (!require("node:fs").existsSync(join(process.resourcesPath, "morka-project-launch.json"))) {
          const { execFile } = require("node:child_process");
          const run = require("node:util").promisify(execFile);
          const macAppIdentity = ${macAppIdentity.toString()};
          const distribution = require("./dist/instances/distribution.js");
          const prepare = distribution.prepareMacProjectExecutable;
          distribution.prepareMacProjectExecutable = async (...args) => {
            await app.whenReady();
            const identity = await macAppIdentity(process.pid);
            const receipt = join(${JSON.stringify(temporary)}, args[3].id + "-handoff.json");
            await writeFile(receipt, JSON.stringify({ ...identity, windows: BrowserWindow.getAllWindows().length }));
            return prepare(...args);
          };
        }
        const contract = require(join(process.resourcesPath, "morka-runtime.json"));
        if (contract.runtimeApi === 2) {
          const assert = require("node:assert/strict");
          const upgrades = require("./dist/instances/runtime-upgrades.js");
          const plan = upgrades.planRuntimeUpgrade;
          upgrades.planRuntimeUpgrade = (spec, runtime) => plan(spec, runtime, [{
            from: 1, to: 2, minimumVersion: contract.version, instructions: "Update the existing health response label.",
            requiresAgent: true,
          }]);
          dialog.showMessageBox = async (...args) => {
            const options = args.at(-1);
            if (options.buttons[0] === "Open in Morka to Upgrade") {
              await writeFile(join(${JSON.stringify(temporary)}, "upgrade-confirmation"), options.buttons[0]);
            } else assert.equal(options.buttons[0], "Test upgrade agent");
            return { response: 0 };
          };
          const { AgentRegistry } = require("./dist/agents/registry.js");
          const open = AgentRegistry.open.bind(AgentRegistry);
          AgentRegistry.open = async (...args) => {
            const registry = await open(...args);
            const get = registry.get.bind(registry);
            registry.setup = async () => [{ id: "test-upgrade", name: "Test upgrade agent", state: "ready" }];
            registry.get = id => id === "test-upgrade" ? { connection: {
              async prompt(turn) {
                const { readFile } = require("node:fs/promises");
                assert.deepEqual(turn.skills, ["morka-runtime-migration"]);
                const server = join(turn.cwd, "server.mjs");
                await writeFile(server, (await readFile(server, "utf8")).replace('"ready"', '"migrated"'));
                return "completed";
              },
            } } : get(id);
            return registry;
          };
        }
        app.on("browser-window-created", (_event, window) => {
          window.webContents.once("did-finish-load", async () => {
            await writeFile(join(app.getPath("userData"), "started.json"), JSON.stringify({
              pid: process.pid, name: app.name, executable: process.execPath, title: window.getTitle(),
              menuTitle: Menu.getApplicationMenu().items[0].label,
              aboutTitle: Menu.getApplicationMenu().items[0].submenu.items.find(item => item.role === "about").label,
              windows: BrowserWindow.getAllWindows().length,
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
    for (const [name, runtimeVersion] of [
      ["Morka Shared Test A", metadata.version],
      ["Morka Shared Test B", previousVersion],
      ["Morka Shared Test C", previousVersion],
    ]) {
      const expectedExecutable = join(host, "Contents/MacOS/Morka");
      const spec = { version: 1, id: require("node:crypto").randomUUID(), name, iconColor: projects.length, runtimeVersion, runtimeApi: 1 };
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
      assert.equal((await readFile(launch.activeRuntime, "utf8")).trim(), expectedExecutable);
      assert.equal(await realpath(launch.host), await realpath(host));
      const bundleSize = Number(execFileSync("/usr/bin/du", ["-sk", bundle], { encoding: "utf8" }).split(/\s+/)[0]);
      assert.ok(bundleSize <= 2 * 1024, `Expected a launcher under 2 MiB, got ${bundleSize} KiB`);
      await assert.rejects(lstat(join(repository, "node_modules")), { code: "ENOENT" });
      const receipt = join(profile, "started.json");
      const started = await waitFor(async () => JSON.parse(await readFile(receipt, "utf8")));
      project.pid = started.pid;
      Object.assign(project, { repository, spec, bundle, receipt });
      assert.equal(started.name, name);
      assert.equal(started.title, name);
      assert.equal(started.menuTitle, name);
      assert.equal(started.aboutTitle, `About ${name}`);
      assert.deepEqual(await macAppIdentity(project.pid), { name, bundleName: name, visibleInDock: true });
      assert.equal(started.windows, 1);
      const handoffFile = join(temporary, spec.id + "-handoff.json");
      const handoff = JSON.parse(await readFile(handoffFile, "utf8"));
      assert.equal(handoff.visibleInDock, false, "The shared runtime handoff should stay out of the Dock");
      assert.equal(handoff.windows, 0, "Only the final project process should open a window");
      const plist = join(bundle, "Contents/Info.plist");
      const launcherPolicy = await run("/usr/bin/plutil", ["-extract", "LSUIElement", "raw", plist]);
      assert.equal(launcherPolicy.stdout.trim(), "true");
      const runningResources = resolve(started.executable, "../../Resources");
      assert.deepEqual(JSON.parse(await readFile(join(runningResources, "morka-project-launch.json"), "utf8")), {
        repository, runtimeResources: join(host, "Contents/Resources"),
      });
      assert.ok(started.executable.startsWith(join(support, "Morka Apps", "macOS") + "/"));
      const expectedNode = join(runningResources, "app/dist/toolchain/bin/node");
      await waitFor(async () => {
        const { port } = JSON.parse(await readFile(join(profile, "runtime", spec.id, "origin.json"), "utf8"));
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        assert.deepEqual(await response.json(), { saved: name, node: expectedNode });
      });
      if (name === "Morka Shared Test B") {
        // Existing installed launchers have no background activation setting in their plist.
        await run("/usr/bin/plutil", ["-remove", "LSUIElement", plist]);
        await signBundle(bundle);
      }
      const reopened = join(profile, "reopened");
      await Promise.all([rm(reopened, { force: true }), rm(handoffFile)]);
      await run("/usr/bin/open", [bundle]);
      await waitFor(() => readFile(reopened, "utf8"));
      assert.equal(JSON.parse(await readFile(receipt, "utf8")).pid, project.pid);
      const reopenHandoff = JSON.parse(await readFile(handoffFile, "utf8"));
      assert.equal(reopenHandoff.visibleInDock, false);
      assert.equal(reopenHandoff.windows, 0);
      console.log(`PASS: ${name} opens one window with its native name, and its ${bundleSize} KiB launcher stays out of the Dock.`);
    }
    assert.equal(new Set(projects.map(project => project.pid)).size, projects.length);
    assert.deepEqual((await readdir(join(support, "Morka Apps", "runtimes", `${process.platform}-${process.arch}`))).sort(),
      [`${previousVersion}.json`, `${metadata.version}.json`, "active-executable"].sort());

    const nextVersion = "0.4.0-test";
    const nextHost = join(temporary, `Morka-${nextVersion}.app`);
    const nextResources = join(nextHost, "Contents/Resources");
    await run("/usr/bin/ditto", [host, nextHost]);
    await writeFile(join(nextResources, "app/package.json"),
      JSON.stringify({ ...metadata, main: "install-test.cjs", version: nextVersion }));
    await writeDesktopRuntime(nextResources, nextVersion, "Morka");
    const marker = join(nextResources, "morka-runtime.json");
    await writeFile(marker, JSON.stringify({ ...JSON.parse(await readFile(marker, "utf8")), runtimeApi: 2, supportedRuntimeApis: [2] }));
    await setBundleIdentity(join(nextHost, "Contents/Info.plist"), { CFBundleIdentifier: `local.morka.runtime.${nextVersion}` });
    await signBundle(nextHost);
    await run(join(nextHost, "Contents/MacOS/Morka"), ["--register-runtime"], { timeout: 15_000 });
    const project = projects[0];
    process.kill(project.pid, "SIGTERM");
    await waitFor(() => assert.rejects(lstat(join(project.profile, "SingletonSocket")), { code: "ENOENT" }));
    project.pid = undefined;
    await rm(project.receipt);
    await run("/usr/bin/open", [project.bundle]);
    const started = await waitFor(async () => JSON.parse(await readFile(project.receipt, "utf8")));
    project.pid = started.pid;
    const runningResources = resolve(started.executable, "../../Resources");
    assert.deepEqual(JSON.parse(await readFile(join(runningResources, "morka-project-launch.json"), "utf8")), {
      repository: project.repository, runtimeResources: nextResources,
    });
    assert.deepEqual(await macAppIdentity(project.pid), {
      name: project.spec.name, bundleName: project.spec.name, visibleInDock: true,
    });
    assert.equal(await readFile(join(temporary, "upgrade-confirmation"), "utf8"), "Open in Morka to Upgrade");
    await waitFor(async () => assert.deepEqual(readRelease(repositoryFile(project.repository, "release.json")), {
      ...project.spec, runtimeVersion: nextVersion, runtimeApi: 2,
    }));
    const { port } = JSON.parse(await readFile(join(project.profile, "runtime", project.spec.id, "origin.json"), "utf8"));
    await waitFor(async () => {
      const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      assert.equal(await health.text(), "migrated");
    });
    assert.equal(await readFile(join(project.profile, "runtime-data/saved.txt"), "utf8"), project.spec.name);
    console.log("PASS: the existing macOS launcher opened Morka's runtime upgrade and published a verified agent draft.");
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
