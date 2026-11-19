const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtemp, mkdir, readFile, realpath, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
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

  const { installDesktopApp } = require("../dist/instances/desktop.js");
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
  await installDesktopApp(repository, spec, false);

  const bundle = join(temporary, "Applications", spec.name + ".app");
  const resources = join(bundle, "Contents/Resources/app");
  const launch = JSON.parse(await readFile(join(resources, "morka-launch.json"), "utf8"));
  assert.equal(launch.repository, repository);
  assert.equal(launch.profile, repositoryProfileId(spec, repository));
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  console.log("PASS: the macOS installer registers a signed launcher for the generated checkout.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
