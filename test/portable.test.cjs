const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { readFileSync, writeFileSync } = require("node:fs");
const { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { basename, dirname, join, win32 } = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");
const { runInNewContext } = require("node:vm");
const tar = require("tar");
const { ActionAccess } = require("../dist/agent-actions/access.js");
const { importProjectArchive } = require("../dist/instances/project-import.js");
const { materializeRepository, portableAppName, readRelease, repositoryProfileId } = require("../dist/instances/repository.js");
const { entryFile, snapshot } = require("../dist/project/files.js");
const { ManagedRuntime } = require("../dist/project/managed-runtime.js");
const { writableTree } = require("../dist/project/packages.js");
const { compileProject, jsonFile, starterManifest } = require("../dist/project/project.js");
const { npmEntry } = require("../dist/project/toolchain.js");

const run = promisify(execFile);
const root = join(__dirname, "..");
async function fixture(action) {
  const temp = await mkdtemp(join(tmpdir(), "morka-portable-"));
  try {
    await action(temp);
  } finally {
    await writableTree(temp);
    await rm(temp, { recursive: true, force: true });
  }
}

test("a generated portable checkout pins engine code without the creator's Node binary", () => fixture(async temp => {
  const spec = { version: 1, id: randomUUID(), name: "My Morka App", iconColor: 0, runtimeVersion: "0.3.0-beta.4", runtimeApi: 1 };
  const files = new Map([
    ["morka.project.json", Buffer.from(JSON.stringify({ version: 1, runtime: { type: "node" } }))],
    ["index.html", Buffer.from("<!doctype html><title>My Morka App</title>")],
  ]);
  const project = await materializeRepository(temp, spec, files, join(root, "dist", "npm"), Buffer.from("icon"));
  const kit = join(project, ".morka", "npm");
  assert.deepEqual(readRelease(join(project, ".morka", "release.json")), spec);
  for (const invalid of ["latest", "^0.3.0", "../0.3.0", "01.3.0", "0.3.0-beta.01"]) {
    const bad = join(temp, "invalid-release.json");
    await writeFile(bad, JSON.stringify({ ...spec, runtimeVersion: invalid }));
    assert.throws(() => readRelease(bad), /runtime version/i);
  }
  const invalidApi = join(temp, "invalid-api.json");
  await writeFile(invalidApi, JSON.stringify({ ...spec, runtimeApi: 0 }));
  assert.throws(() => readRelease(invalidApi), /runtime API/i);
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.deepEqual(manifest.scripts, { start: "morka run", build: "morka-pack local-build",
    "package:mac": "node .morka/npm/package-mac.cjs", "install:app": "node .morka/npm/install-app.cjs" });
  assert.match(await readFile(join(kit, "install-app.cjs"), "utf8"), /"--include=dev"/);
  assert.match(await readFile(join(project, ".gitignore"), "utf8"), /\*\.sqlite/);
  assert.throws(() => portableAppName("CON.txt"), /Windows/);
  assert.throws(() => portableAppName("hello?"), /Windows/);
  const template = require("../packages/project-template/package.json");
  assert.deepEqual(manifest.dependencies, template.dependencies);
  assert.deepEqual(manifest.devDependencies, template.devDependencies);
  assert.deepEqual((await readdir(kit)).sort(), ["install-app.cjs", "package-mac.cjs", "project-lock.json"]);
  const lock = JSON.parse(await readFile(join(project, "package-lock.json"), "utf8"));
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    const pkg = lock.packages["node_modules/" + name];
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.equal(pkg.version, version);
    assert.equal(new URL(pkg.resolved).origin, "https://registry.npmjs.org");
    assert.match(pkg.integrity, /^sha512-/);
  }
  const npm = await npmEntry(process.execPath, process.env.npm_execpath);
  const tar = createRequire(npm)("tar");
  const paths = [];
  const archive = join(root, "dist", "archives", "morka-runtime.tgz");
  await tar.t({ file: archive, onReadEntry: entry => paths.push(entry.path) });
  assert.ok(paths.includes("package/dist/electron/main.js"));
  assert.ok(paths.includes("package/bin/morka.cjs"));
  assert.ok(!paths.some(path => path.startsWith("package/dist/toolchain/")));
}));

test("the npm entry point forwards the checkout and local Node to Electron without bundling", () => fixture(async temp => {
  const engine = join(temp, "engine");
  const bin = join(engine, "bin");
  const dist = join(engine, "dist");
  const checkout = join(temp, "check out");
  await mkdir(bin, { recursive: true });
  await mkdir(join(engine, "node_modules", "electron"), { recursive: true });
  await mkdir(join(dist, "project"), { recursive: true });
  await mkdir(join(dist, "instances"), { recursive: true });
  await mkdir(join(dist, "electron"), { recursive: true });
  await writeFile(join(dist, "electron", "main.js"), "");
  await mkdir(checkout);
  await cp(join(root, "packages", "runtime", "bin", "morka.cjs"), join(bin, "morka.cjs"));
  await cp(join(root, "dist", "project", "toolchain.js"), join(dist, "project", "toolchain.js"));
  await writeFile(join(dist, "instances", "repository.js"), `
    exports.repositoryFile = (root, dir) => require("node:path").join(root, ".morka", dir);
    exports.readRelease = () => ({ name: "Example", id: "fixture" });
  `);
  await writeFile(join(dist, "instances", "distribution.js"),
    "exports.prepareMacProjectExecutable = async executable => executable;");
  await writeFile(join(engine, "package.json"), '{"main":"electron-fixture.cjs"}');
  await writeFile(join(engine, "node_modules", "electron", "index.js"), "module.exports = process.execPath;");
  await writeFile(join(engine, "electron-fixture.cjs"),
    'console.log(JSON.stringify([process.env.MORKA_NPM_REPOSITORY, process.env.MORKA_LOCAL_NODE, process.env.MORKA_LOCAL_NPM]));');
  const { stdout } = await run(process.execPath, [join(bin, "morka.cjs"), "run", checkout], { cwd: temp, windowsHide: true });
  const [repository, node, npm] = JSON.parse(stdout);
  assert.equal(repository, checkout);
  assert.equal(dirname(node), dirname(require("node:fs").realpathSync(process.execPath)));
  assert.match(npm, /npm-cli\.js$/);
}));

test("the runtime registry keeps an in-place installation for each exact version", () => fixture(async temp => {
  const { writeDesktopRuntime, readDesktopRuntime, registerDesktopRuntime, findDesktopRuntime, requireCompatibleDesktopRuntime } =
    require("../dist/instances/desktop-runtimes.js");
  const library = join(temp, "Morka Apps");
  async function runtime(name, version) {
    const root = join(temp, name);
    const darwin = process.platform === "darwin";
    const contents = darwin ? join(root, "Contents") : root;
    const resources = join(contents, darwin ? "Resources" : "resources");
    const executable = join(contents, ...(darwin ? ["MacOS"] : []), "Morka");
    const toolchain = join(resources, "app", "dist", "toolchain");
    await mkdir(toolchain, { recursive: true });
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, "runtime");
    await writeFile(join(resources, "app", "package.json"), JSON.stringify({ version }));
    await writeFile(join(toolchain, "toolchain.json"), "{}");
    await writeDesktopRuntime(resources, version, "Morka");
    return readDesktopRuntime(resources);
  }
  const first = await runtime("Morka-old", "1.2.3");
  const second = await runtime("Morka-new", "2.0.0-beta.1");
  const duplicate = await runtime("Morka-copy", first.version);
  assert.deepEqual(await registerDesktopRuntime(library, first), first);
  assert.deepEqual(await registerDesktopRuntime(library, second), second);
  assert.deepEqual(await registerDesktopRuntime(library, duplicate), first);
  assert.deepEqual(await findDesktopRuntime(library, first.version), first);
  assert.deepEqual(await findDesktopRuntime(library, second.version), second);
  assert.deepEqual(await requireCompatibleDesktopRuntime(library, { runtimeVersion: first.version }), second);
  await assert.rejects(requireCompatibleDesktopRuntime(library, { runtimeApi: 2 }), /compatible Morka runtime/);
  assert.deepEqual((await readdir(join(library, "runtimes", `${process.platform}-${process.arch}`))).sort(),
    ["1.2.3.json", "2.0.0-beta.1.json"]);
  assert.equal(await readFile(first.executable, "utf8"), "runtime");
  await rm(first.executable);
  assert.equal(await findDesktopRuntime(library, first.version), undefined);
  assert.deepEqual(await registerDesktopRuntime(library, duplicate), duplicate);
  assert.deepEqual(await findDesktopRuntime(library, first.version), duplicate);
}));

test("runtime compatibility accepts a newer version and checks the project API separately", () => {
  const { runtimeCompatibility } = require("../dist/instances/runtime-compatibility.js");
  const project = { runtimeVersion: "0.3.0-beta.4", runtimeApi: 1 };
  const runtime = { version: "1.0.0", runtimeApi: 2, supportedRuntimeApis: [1, 2] };
  assert.equal(runtimeCompatibility(project, runtime), "compatible");
  assert.equal(runtimeCompatibility(project, { ...runtime, version: "0.3.0-beta.3" }), "update");
  assert.equal(runtimeCompatibility({ ...project, runtimeApi: 3 }, runtime), "update");
  assert.equal(runtimeCompatibility(project, { ...runtime, supportedRuntimeApis: [2] }), "upgrade");
  assert.equal(runtimeCompatibility({ runtimeVersion: "1.0.0-beta.10" }, { ...runtime, version: "1.0.0-beta.2" }), "update");
  assert.equal(runtimeCompatibility({ runtimeVersion: "1.0.0-beta.10" }, runtime), "compatible");
});

test("a runtime upgrade uses a draft and restores source and requirements after failed activation", () => fixture(async temp => {
  const { planRuntimeUpgrade, upgradeProjectRuntime } = require("../dist/instances/runtime-upgrades.js");
  const repository = join(temp, "Project");
  const projectDirectory = join(repository, "app");
  const metadata = join(repository, ".morka", "release.json");
  const data = join(temp, "runtime-data");
  const release = { version: 1, id: randomUUID(), name: "Project", iconColor: 0, runtimeApi: 1, runtimeVersion: "1.0.0" };
  const target = { version: "3.1.0", runtimeApi: 3, supportedRuntimeApis: [3] };
  const steps = [
    { from: 1, to: 2, minimumVersion: "2.0.0", instructions: "Change the startup script name.",
      replacements: [{ path: entryFile, before: '"old-start"', after: '"start"' }] },
    { from: 2, to: 3, minimumVersion: "3.0.0", instructions: "Adjust the existing server health response." },
  ];
  const plan = planRuntimeUpgrade(release, target, steps);
  assert.deepEqual(plan.steps, steps);
  assert.equal(plan.minimumVersion, "3.0.0");
  assert.equal(planRuntimeUpgrade(release, target, steps.slice(0, 1)), undefined);
  assert.equal(planRuntimeUpgrade(release, { ...target, supportedRuntimeApis: [1, 3] }, steps), undefined);
  const oldSource = JSON.stringify({ version: 1, runtime: { type: "node", script: "old-start" } });
  await Promise.all([mkdir(dirname(metadata), { recursive: true }), mkdir(projectDirectory, { recursive: true }), mkdir(data)]);
  await writeFile(metadata, JSON.stringify({ ...release, custom: "keep" }));
  await writeFile(join(projectDirectory, entryFile), oldSource);
  await writeFile(join(projectDirectory, "server.cjs"), "old health response");
  await writeFile(join(data, "saved.txt"), "user data");
  const draftDirectory = join(temp, "upgrade-draft");
  let agentCalls = 0;
  let failActivation = true;
  const options = { repository, projectDirectory, draftDirectory, release, plan, signal: new AbortController().signal,
    async agent() {
      agentCalls++;
      return { async prompt(turn) {
        assert.deepEqual(turn.skills, ["morka-runtime-migration"]);
        assert.match(turn.text, /adjust the existing server health response/i);
        assert.match(turn.text, /missing health fixture/);
        assert.equal(await readFile(join(projectDirectory, entryFile), "utf8"), oldSource);
        await writeFile(join(turn.cwd, "server.cjs"), "new health response");
        return "completed";
      } };
    },
    async prepare(files) {
      assert.equal(JSON.parse(files.get(entryFile)).runtime.script, "start");
      if (files.get("server.cjs").toString() === "old health response") throw new Error("missing health fixture");
      return { source: files };
    },
    async activate(_project, _artifact, publish) {
      assert.deepEqual(readRelease(metadata), release);
      const undo = await publish();
      assert.equal(readRelease(metadata).runtimeApi, 3);
      if (failActivation) {
        await undo();
        throw new Error("activation failed after publishing");
      }
    },
  };
  await assert.rejects(upgradeProjectRuntime(options), /activation failed after publishing/);
  assert.deepEqual(readRelease(metadata), release);
  assert.equal(await readFile(join(projectDirectory, entryFile), "utf8"), oldSource);
  assert.equal(await readFile(join(projectDirectory, "server.cjs"), "utf8"), "old health response");
  assert.equal(await readFile(join(draftDirectory, "app", "server.cjs"), "utf8"), "new health response");
  failActivation = false;
  const result = await upgradeProjectRuntime(options);
  assert.equal(result.runtimeVersion, "3.0.0");
  assert.equal(agentCalls, 1);
  assert.equal(JSON.parse(await readFile(metadata, "utf8")).custom, "keep");
  assert.equal(await readFile(join(projectDirectory, "server.cjs"), "utf8"), "new health response");
  assert.equal(await readFile(join(data, "saved.txt"), "utf8"), "user data");
}));

test("a compressed tar checkout can be imported and invalid imports leave no partial project", () => fixture(async temp => {
  const library = join(temp, "library");
  const spec = { version: 1, id: randomUUID(), name: "Tar Project", iconColor: 0 };
  const source = new Map([[entryFile, Buffer.from(jsonFile(starterManifest))]]);
  const repository = await materializeRepository(temp, spec, source, join(root, "dist", "npm"), Buffer.from("icon"));
  const archive = join(temp, "project.tar.gz");
  await tar.create({ cwd: repository, file: archive, gzip: true }, ["app", ".morka", "package.json", "package-lock.json"]);
  const imported = await importProjectArchive(library, archive);
  assert.notEqual(imported.repository, repository);
  assert.deepEqual(imported.spec, spec);
  assert.deepEqual(await importProjectArchive(library, archive), imported);
  const invalid = join(temp, "incomplete.tgz");
  await tar.create({ cwd: repository, file: invalid, gzip: true }, ["app"]);
  await assert.rejects(importProjectArchive(library, invalid), /one Morka project/);
  assert.equal((await readdir(join(library, "projects"))).length, 1);
}));

for (const platform of ["linux", "win32"]) {
  test(`${platform} installation registers a menu entry for the same project profile`, () => fixture(async temp => {
    const module = { exports: {} };
    const path = join(root, "dist/instances/desktop.js");
    const local = createRequire(path);
    const appData = join(temp, "App Data");
    const dataHome = join(temp, "XDG Data");
    const repository = join(temp, "Project % with spaces");
    const executable = join(repository, "electron");
    const spec = { version: 1, id: randomUUID(), name: "Example App", iconColor: 0 };
    const profile = repositoryProfileId(spec, repository);
    const configDir = join(appData, "Morka Apps", "desktop", profile);
    const mocks = {
      electron: {
        app: { getPath: key => key === "home" ? temp : appData },
        shell: {
          writeShortcutLink(file, options) { writeFileSync(file, JSON.stringify(options)); return true; },
          readShortcutLink(file) { return JSON.parse(readFileSync(file)); },
        },
      },
      "./macos": { projectIcon: () => ({ resize: () => ({ toPNG: () => Buffer.from("icon") }) }) },
      "./distribution": {},
      "original-fs": require("node:fs"),
    };
    runInNewContext(await readFile(path, "utf8"), {
      module, exports: module.exports, require: name => mocks[name] ?? local(name), Buffer,
      process: { platform, execPath: executable, versions: { electron: "test" },
        env: { XDG_DATA_HOME: dataHome, MORKA_LOCAL_NODE: process.execPath, MORKA_LOCAL_NPM: path } },
      console: { log() {} },
    });
    await module.exports.installDesktopApp(repository, spec, false);
    await module.exports.installDesktopApp(repository, spec, false);
    const config = JSON.parse(await readFile(join(configDir, "morka-launch.json"), "utf8"));
    assert.equal(config.repository, repository);
    assert.equal(config.profile, profile);
    const main = join(repository, "node_modules", "@morkaai", "runtime", "dist", "electron", "main.js");
    await mkdir(dirname(main), { recursive: true });
    await writeFile(main, "module.exports = true;");
    const bootstrap = join(configDir, "main.cjs");
    runInNewContext(await readFile(bootstrap, "utf8"), {
      __dirname: configDir, require: createRequire(bootstrap), process: { env: {} },
    });
    if (platform === "linux") {
      const desktop = await readFile(join(dataHome, "applications", `local.morka.project.${profile}.desktop`), "utf8");
      assert.match(desktop, /^Name=Example App$/m);
      assert.match(desktop, /^Exec=.*Project %% with spaces.*$/m);
      assert.match(desktop, /^Terminal=false$/m);
    } else {
      const shortcut = join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Morka", "Example App.lnk");
      const link = JSON.parse(await readFile(shortcut, "utf8"));
      assert.equal(link.target, executable);
      assert.equal(link.args, `"${configDir}"`);
      assert.equal(link.cwd, repository);
      await assert.rejects(module.exports.installDesktopApp(join(temp, "Other Project"), spec, false), /already exists/);
      assert.deepEqual(JSON.parse(await readFile(shortcut, "utf8")), link);
    }
  }));
}

test("a packaged Linux project follows the active desktop host without tying its menu entry to a version", () => fixture(async temp => {
  const module = { exports: {} };
  const path = join(root, "dist/instances/desktop.js");
  const local = createRequire(path);
  const dataHome = join(temp, "XDG Data");
  const repository = join(temp, "Shared % Project");
  const executable = "/opt/Morka-2.0.0/morka-2.0.0";
  const spec = { version: 1, id: randomUUID(), name: "Shared Project", iconColor: 0, runtimeVersion: "1.2.3" };
  const appDirectory = "/opt/Morka-2.0.0/resources/app";
  const active = join(temp, "active-executable");
  const profile = repositoryProfileId(spec, repository);
  const launches = [];
  const mocks = {
    "node:child_process": { spawn(command, args, options) {
      launches.push({ command, args: Array.from(args), cwd: options.cwd });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    } },
    electron: { app: { isPackaged: true, getPath: () => temp, getAppPath: () => "/opt/Morka-2.0.0/resources/app" } },
    "./macos": { projectIcon: () => ({ resize: () => ({ toPNG: () => Buffer.from("icon") }) }) },
    "./distribution": {},
    "./desktop-runtimes": {
      desktopProjectArgument: "--morka-project=", readDesktopRuntime: async () => ({ version: "2.0.0" }),
      registerDesktopRuntime: async () => {}, activeRuntimeFile: () => active,
      updateActiveDesktopRuntime: async () => ({ executable, appDirectory, version: "2.0.0" }),
    },
    "original-fs": require("node:fs"),
  };
  runInNewContext(await readFile(path, "utf8"), {
    module, exports: module.exports, require: name => mocks[name] ?? local(name), Buffer,
    process: { platform: "linux", execPath: "/opt/Morka-2.0.0/morka-2.0.0", resourcesPath: "/opt/Morka-2.0.0/resources",
      env: { XDG_DATA_HOME: dataHome } }, console: { log() {} },
  });
  assert.equal(await module.exports.openInstalledProject(repository, spec), false);
  await module.exports.installRepository(repository, spec);
  const desktop = await readFile(join(dataHome, "applications", `local.morka.project.${profile}.desktop`), "utf8");
  assert.match(desktop, /^Exec="\/bin\/sh" "-c" .*active-executable.* "--morka-project=.*Shared %% Project"$/m);
  assert.ok(!desktop.includes("/opt/Morka-"));
  assert.equal(await module.exports.openInstalledProject(repository, spec), true);
  const launch = { command: executable, args: [`--morka-project=${repository}`], cwd: appDirectory };
  assert.deepEqual(launches, [launch, launch]);
}));

test("the packaged Windows host installs a shared-folder shortcut that follows the active runtime", () => fixture(async temp => {
  const module = { exports: {} };
  const path = join(root, "dist/instances/desktop.js");
  const local = createRequire(path);
  const executable = join(temp, "Morka-2.0.0", "Morka-2.0.0.exe");
  const appPath = join(temp, "Morka-2.0.0", "resources", "app");
  const active = join(temp, "active-executable");
  const repository = String.raw`\\Mac\Home\Downloads\Shared App`;
  const spec = { version: 1, id: randomUUID(), name: "Shared App", iconColor: 0, runtimeVersion: "1.2.3" };
  const launches = [];
  const mocks = {
    "node:child_process": { spawn(command, args, options) {
      launches.push({ command, args: Array.from(args), cwd: options.cwd });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    } },
    electron: {
      app: { isPackaged: true, getPath: () => temp, getAppPath: () => appPath },
      shell: {
        writeShortcutLink(file, options) { writeFileSync(file, JSON.stringify(options)); return true; },
        readShortcutLink(file) { return JSON.parse(readFileSync(file)); },
      },
    },
    "./macos": { projectIcon: () => ({ resize: () => ({ toPNG: () => Buffer.from("icon") }) }) },
    "./distribution": {},
    "./desktop-runtimes": {
      desktopProjectArgument: "--morka-project=", readDesktopRuntime: async () => ({ version: "2.0.0" }),
      registerDesktopRuntime: async () => {}, activeRuntimeFile: () => active,
      updateActiveDesktopRuntime: async () => ({ executable, appDirectory: appPath, version: "2.0.0" }),
    },
    "original-fs": require("node:fs"),
  };
  runInNewContext(await readFile(path, "utf8"), {
    module, exports: module.exports, require: name => mocks[name] ?? local(name), Buffer,
    process: { platform: "win32", execPath: executable, resourcesPath: join(temp, "resources"), env: {} }, Buffer,
    console: { log() {} },
  });
  assert.equal(await module.exports.openInstalledProject(repository, spec), false);
  await module.exports.installRepository(repository, spec);
  const argument = `--morka-project=${repository}`;
  const shortcut = join(temp, "Microsoft", "Windows", "Start Menu", "Programs", "Morka", "Shared App.lnk");
  const link = JSON.parse(await readFile(shortcut, "utf8"));
  assert.equal(basename(link.target), "powershell.exe");
  const script = Buffer.from(link.args.split(" ").at(-1), "base64").toString("utf16le");
  assert.ok(script.includes(active) && script.includes(argument));
  assert.ok(!script.includes(executable));
  assert.equal(link.cwd, join(temp, "Morka Apps", "desktop", repositoryProfileId(spec, repository)));
  assert.equal(await module.exports.openInstalledProject(repository, spec), true);
  const launch = { command: executable, args: [argument], cwd: appPath };
  assert.deepEqual(launches, [launch, launch]);
}));

test("the packaged macOS host installs and opens a lightweight project launcher", () => fixture(async temp => {
  const module = { exports: {} };
  const path = join(root, "dist/instances/desktop.js");
  const local = createRequire(path);
  const host = join(temp, "Morka.app");
  const resourcesPath = join(host, "Contents", "Resources");
  const repository = join(temp, "Shared Project");
  const spec = { version: 1, id: randomUUID(), name: "Shared Project", iconColor: 0 };
  const bundle = join(temp, "Applications", `${spec.name}.app`);
  const launcher = join(resourcesPath, "app", "dist", "instances", "MorkaProject");
  const icon = join(repository, ".morka", "icons", "AppIcon.icns");
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(dirname(icon), { recursive: true });
  await writeFile(launcher, "launcher", { mode: 0o755 });
  await writeFile(join(host, "Contents", "Info.plist"), "plist");
  await writeFile(icon, "icon");
  const launches = [];
  const mocks = {
    electron: { app: { isPackaged: true, getPath: () => temp, getAppPath: () => join(resourcesPath, "app") } },
    "node:child_process": { execFile(file, args, callback) {
      if (file === "/usr/bin/open") launches.push([file, ...args]);
      callback(null, "");
    } },
    "../project/toolchain": { async bundledToolchain() { assert.fail("The desktop installer must use the shared host"); } },
    "./distribution": { async setBundleIdentity() {}, async signBundle() {} },
    "./macos": {},
    "original-fs": require("node:fs"),
  };
  runInNewContext(await readFile(path, "utf8"), {
    module, exports: module.exports, require: name => mocks[name] ?? local(name),
    process: { platform: "darwin", execPath: join(host, "Contents", "MacOS", "Morka"), resourcesPath, env: {} },
  });
  assert.equal(await module.exports.openInstalledProject(repository, spec), false);
  await module.exports.installRepository(repository, spec);
  assert.equal(await readFile(join(bundle, "Contents", "MacOS", "MorkaProject"), "utf8"), "launcher");
  assert.deepEqual((await readdir(join(bundle, "Contents"))).sort(), ["Info.plist", "MacOS", "Resources"]);
  assert.deepEqual(JSON.parse(await readFile(join(bundle, "Contents", "Resources", "morka-launch.json"), "utf8")), {
    host, repository, profile: repositoryProfileId(spec, repository),
  });
  assert.equal(await module.exports.openInstalledProject(repository, spec), true);
  assert.deepEqual(launches, [["/usr/bin/open", bundle], ["/usr/bin/open", bundle]]);
}));

test("opening an installed macOS project hands the bundle to Launch Services", () => fixture(async temp => {
  const module = { exports: {} };
  const path = join(root, "dist/instances/desktop.js");
  const local = createRequire(path);
  const repository = join(temp, "Project");
  const spec = { version: 1, id: randomUUID(), name: "Example App", iconColor: 0 };
  const bundle = join(temp, "Applications", "Example App.app");
  const resources = join(bundle, "Contents", "Resources", "app");
  const binary = join(bundle, "Contents", "MacOS");
  const config = { repository, profile: repositoryProfileId(spec, repository), node: process.execPath, npm: path,
    electron: "test", bundledNode: false };
  await mkdir(resources, { recursive: true });
  await mkdir(binary, { recursive: true });
  await writeFile(join(resources, "morka-launch.json"), JSON.stringify(config));
  await writeFile(join(resources, "main.cjs"), "");
  await writeFile(join(binary, "Electron"), "");
  const launches = [];
  const mocks = {
    electron: { app: { getPath: () => temp }, shell: {} },
    "node:child_process": {
      execFile(file, args, callback) { launches.push([file, args]); callback(null, ""); },
      spawn() { assert.fail("The installed bundle must not be spawned by the installer"); },
    },
    "original-fs": require("node:fs"),
    "./macos": {},
    "./distribution": {},
  };
  runInNewContext(await readFile(path, "utf8"), {
    module, exports: module.exports, require: name => mocks[name] ?? local(name),
    process: { platform: "darwin", execPath: join(binary, "Electron"), versions: { electron: "test" },
      env: { MORKA_LOCAL_NODE: config.node, MORKA_LOCAL_NPM: config.npm } },
    console: { log() {} },
  });
  await module.exports.installDesktopApp(repository, spec, true);
  assert.equal(await module.exports.openInstalledProject(repository, spec), false);
  const engine = join(repository, "node_modules", "@morkaai", "runtime", "dist", "electron");
  await mkdir(engine, { recursive: true });
  await writeFile(join(engine, "main.js"), "");
  assert.equal(await module.exports.openInstalledProject(repository, spec), true);
  assert.deepEqual(launches.map(([executable, [path]]) => [executable, path]),
    [["/usr/bin/open", bundle], ["/usr/bin/open", bundle]]);
}));

test("a source checkout starts its managed app using the local Node and npm", () => fixture(async temp => {
  const previousNode = process.env.MORKA_LOCAL_NODE;
  const previousNpm = process.env.MORKA_LOCAL_NPM;
  const source = await snapshot(join(root, "dist", "app-runtime", "starter"));
  source.set(entryFile, jsonFile(starterManifest));
  const app = await materializeRepository(temp, { version: 1, id: randomUUID(), name: "Run from Source", iconColor: 0 },
    source, join(root, "dist", "npm"), Buffer.from("icon"));
  const projectRoot = join(app, "app");
  const runtime = new ManagedRuntime(projectRoot, join(temp, "runtime"), join(temp, "data"), assert.fail);
  try {
    process.env.MORKA_LOCAL_NODE = process.execPath;
    process.env.MORKA_LOCAL_NPM = await npmEntry(process.execPath, process.env.npm_execpath);
    const project = await compileProject(await snapshot(projectRoot));
    const url = await runtime.update(project.files, project.manifest.runtime, {
      async beforeActivate() {},
      async activate() {},
    });
    const response = await fetch(new URL("/health", url));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ready");
    assert.equal((await runtime.prepare(project.files)).toolchain.system, true);
  } finally {
    await runtime.stop();
    if (previousNode === undefined) delete process.env.MORKA_LOCAL_NODE;
    else process.env.MORKA_LOCAL_NODE = previousNode;
    if (previousNpm === undefined) delete process.env.MORKA_LOCAL_NPM;
    else process.env.MORKA_LOCAL_NPM = previousNpm;
  }
}));

test("Windows agent discovery resolves npm shims to Node arguments without invoking cmd.exe", async () => {
  const windowsFiles = new Set([
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\User\\npm\\codex.cmd",
    "C:\\User\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    "C:\\User\\bin\\claude.exe",
  ]);
  const module = { exports: {} };
  runInNewContext(await readFile(join(root, "dist", "agents", "process.js"), "utf8"), {
    module, exports: module.exports,
    process: { platform: "win32", env: { Path: "C:\\User\\bin;C:\\Program Files\\nodejs", APPDATA: "C:\\User" } },
    require(name) {
      if (name === "node:path") return win32;
      if (name === "node:os") return { homedir: () => "C:\\User" };
      return { access: async file => assert.ok(windowsFiles.has(file)) };
    },
  });
  const codex = await module.exports.agentLaunch("codex", ["login", "status"]);
  assert.equal(codex.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(codex.args.join("|"), "C:\\User\\npm\\node_modules\\@openai\\codex\\bin\\codex.js|login|status");
  assert.equal(codex.env.Path, undefined);
  const claude = await module.exports.agentLaunch("claude", ["auth", "status", "--json"]);
  assert.equal(claude.command, "C:\\User\\bin\\claude.exe");
});

test("AI access is remembered per checkout and can be reset", () => fixture(async temp => {
  const action = { provider: "codex", chooseProvider: true };
  const access = new ActionAccess(join(temp, "first", "access.json"));
  const other = new ActionAccess(join(temp, "second", "access.json"));
  assert.equal(await access.choose(action, async choices => {
    assert.deepEqual(choices, ["codex", "claude"]);
    return "claude";
  }), "claude");
  assert.equal(await access.choose(action, () => assert.fail("Existing access should be remembered")), "claude");
  assert.deepEqual(await other.current(), []);
  await assert.rejects(other.choose(action, async () => undefined), /declined/);
  assert.equal(await access.choose({ provider: "codex", chooseProvider: false },
    async choices => choices[0]), "codex");
  assert.deepEqual((await access.current()).sort(), ["claude", "codex"]);
  await access.clear();
  assert.deepEqual(await access.current(), []);
}));
