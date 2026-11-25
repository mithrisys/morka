const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtemp, mkdir, readFile, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { app } = require("electron");

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
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
