import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const require = createRequire(import.meta.url);
const { npmEntry } = require(join(dist, "project", "toolchain.js"));
const npm = await npmEntry(process.execPath, process.env.npm_execpath);
const kit = join(dist, "npm");
const { version, dependencies, devDependencies, engines } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const rootLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const runtimeDependencies = { ...dependencies, electron: devDependencies.electron };
const stage = await mkdtemp(join(tmpdir(), "morka-npm-kit-"));
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const name = "morka-project";
const packages: Record<string, Record<string, unknown>> = {
  "": {
    name, version: "0.1.0", engines,
    dependencies: { "@morka/runtime": "file:.morka/npm/morka-runtime.tgz" },
    devDependencies: { "@morka/packager": "file:.morka/npm/morka-packager.tgz" },
  },
};

function includeDependency(dependency: string, from = "") {
  let parent = from;
  while (true) {
    const key = posix.join(parent, "node_modules", dependency);
    const locked = rootLock.packages[key];
    if (locked) {
      if (packages[key]) return;
      const { dev, devOptional, ...production } = locked;
      packages[key] = production;
      for (const child of Object.keys({ ...locked.dependencies, ...locked.optionalDependencies, ...locked.peerDependencies })) {
        includeDependency(child, key);
      }
      return;
    }
    if (!parent) throw new Error(`Missing ${dependency} in the Morka npm lockfile.`);
    const boundary = parent.lastIndexOf("/node_modules/");
    parent = boundary < 0 ? "" : parent.slice(0, boundary);
  }
}

try {
  await mkdir(kit);
  await cp(join(root, "packages", "runtime", "install-app.cjs"), join(kit, "install-app.cjs"));
  for (const component of ["runtime", "packager"]) {
    const directory = join(stage, component);
    const source = join(root, "packages", component);
    const manifest = await readFile(join(source, "package.json"), "utf8");
    const packageInfo = JSON.parse(manifest);
    if (packageInfo.name !== `@morka/${component}` || packageInfo.version !== version ||
        !isDeepStrictEqual(packageInfo.engines, engines) ||
        (component === "runtime" && !isDeepStrictEqual(packageInfo.dependencies, runtimeDependencies)) ||
        (component === "packager" && packageInfo.peerDependencies?.["@morka/runtime"] !== version)) {
      throw new Error(`Keep packages/${component}/package.json in sync with the root package.`);
    }
    await mkdir(directory);
    await cp(join(source, "bin"), join(directory, "bin"), { recursive: true });
    await writeFile(join(directory, "package.json"), manifest);
    if (component === "runtime") {
      await cp(dist, join(directory, "dist"), {
        recursive: true, filter: path => path !== kit && path !== join(dist, "toolchain"),
      });
    }
    const [packed] = JSON.parse(execFileSync(process.execPath, [npm,
      "pack", "--json", "--ignore-scripts", "--cache", join(stage, "cache"), "--pack-destination", kit],
      { cwd: directory, encoding: "utf8" }));
    const archive = `morka-${component}.tgz`;
    await rename(join(kit, packed.filename), join(kit, archive));
    packages[`node_modules/@morka/${component}`] = {
      name: packageInfo.name,
      version: packageInfo.version,
      engines: packageInfo.engines,
      bin: packageInfo.bin,
      dependencies: packageInfo.dependencies,
      peerDependencies: packageInfo.peerDependencies,
      resolved: `file:.morka/npm/${archive}`,
      integrity: packed.integrity,
      ...(component === "packager" ? { dev: true } : {}),
    };
  }
  for (const dependency of Object.keys(runtimeDependencies)) includeDependency(dependency);
  await writeFile(join(kit, "project-lock.json"), json({ name, version: "0.1.0", lockfileVersion: 3, requires: true, packages }));
} finally {
  await rm(stage, { recursive: true, force: true });
}
