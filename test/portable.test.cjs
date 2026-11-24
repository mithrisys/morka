const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { readFileSync, writeFileSync } = require("node:fs");
const { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, win32 } = require("node:path");
const { test } = require("node:test");
const { promisify } = require("node:util");
const { runInNewContext } = require("node:vm");
const { ActionAccess } = require("../dist/agent-actions/access.js");
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
  const spec = { version: 1, id: randomUUID(), name: "My Morka App", iconColor: 0 };
  const files = new Map([
    ["morka.project.json", Buffer.from(JSON.stringify({ version: 1, runtime: { type: "node" } }))],
    ["index.html", Buffer.from("<!doctype html><title>My Morka App</title>")],
  ]);
  const project = await materializeRepository(temp, spec, files, join(root, "dist", "npm"), Buffer.from("icon"));
  const kit = join(project, ".morka", "npm");
  assert.deepEqual(readRelease(join(project, ".morka", "release.json")), spec);
  const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
  assert.deepEqual(manifest.scripts, { start: "morka run", build: "morka-pack local-build",
    "package:mac": "morka-pack package:mac", "install:app": "node .morka/npm/install-app.cjs" });
  assert.match(await readFile(join(kit, "install-app.cjs"), "utf8"), /"--include=dev"/);
  assert.match(await readFile(join(project, ".gitignore"), "utf8"), /\*\.sqlite/);
  assert.throws(() => portableAppName("CON.txt"), /Windows/);
  assert.throws(() => portableAppName("hello?"), /Windows/);
  const template = require("../packages/project-template/package.json");
  assert.deepEqual(manifest.dependencies, template.dependencies);
  assert.deepEqual(manifest.devDependencies, template.devDependencies);
  assert.deepEqual((await readdir(kit)).sort(), ["install-app.cjs", "project-lock.json"]);
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

test("a packaged Linux project opens with the desktop host covered by the installed sandbox profile", () => fixture(async temp => {
  const module = { exports: {} };
  const path = join(root, "dist/instances/desktop.js");
  const local = createRequire(path);
  const dataHome = join(temp, "XDG Data");
  const repository = join(temp, "Shared % Project");
  const executable = "/opt/Morka/morka";
  const spec = { version: 1, id: randomUUID(), name: "Shared Project", iconColor: 0 };
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
    electron: { app: { getPath: () => temp, getAppPath: () => "/opt/Morka/resources/app" } },
    "./macos": { projectIcon: () => ({ resize: () => ({ toPNG: () => Buffer.from("icon") }) }) },
    "./distribution": {},
    "original-fs": require("node:fs"),
  };
  runInNewContext(await readFile(path, "utf8"), {
    module, exports: module.exports, require: name => mocks[name] ?? local(name), Buffer,
    process: { platform: "linux", execPath: executable, env: { XDG_DATA_HOME: dataHome } }, console: { log() {} },
  });
  await module.exports.installPackagedLinuxProject(repository, spec);
  const desktop = await readFile(join(dataHome, "applications", `local.morka.project.${profile}.desktop`), "utf8");
  assert.match(desktop, /^Exec="\/opt\/Morka\/morka" "--morka-project=.*Shared %% Project"$/m);
  assert.deepEqual(launches, [{ command: executable, args: [`--morka-project=${repository}`], cwd: "/opt/Morka/resources/app" }]);
}));

test("the packaged Windows host installs a shared-folder project without a project Electron", () => fixture(async temp => {
  const module = { exports: {} };
  const path = join(root, "dist/instances/desktop.js");
  const local = createRequire(path);
  const executable = join(temp, "Program Files", "Morka.exe");
  const appPath = join(temp, "Program Files", "resources", "app");
  const repository = String.raw`\\Mac\Home\Downloads\Shared App`;
  const spec = { version: 1, id: randomUUID(), name: "Shared App", iconColor: 0 };
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
      app: { getPath: () => temp, getAppPath: () => appPath },
      shell: { writeShortcutLink(file, options) { writeFileSync(file, JSON.stringify(options)); return true; } },
    },
    "./macos": { projectIcon: () => ({ resize: () => ({ toPNG: () => Buffer.from("icon") }) }) },
    "./distribution": {},
    "original-fs": require("node:fs"),
  };
  runInNewContext(await readFile(path, "utf8"), {
    module, exports: module.exports, require: name => mocks[name] ?? local(name), Buffer,
    process: { platform: "win32", execPath: executable, env: {} },
    console: { log() {} },
  });
  await module.exports.installWindowsProject(repository, spec);
  const argument = `--morka-project=${repository}`;
  const shortcut = join(temp, "Microsoft", "Windows", "Start Menu", "Programs", "Morka", "Shared App.lnk");
  const link = JSON.parse(await readFile(shortcut, "utf8"));
  assert.equal(link.target, executable);
  assert.equal(link.args, `"${argument}"`);
  assert.equal(link.cwd, appPath);
  assert.deepEqual(launches, [{ command: executable, args: [argument], cwd: appPath }]);
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
  assert.equal(launches.length, 1);
  assert.equal(launches[0][0], "/usr/bin/open");
  assert.equal(launches[0][1][0], bundle);
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
