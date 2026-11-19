import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const require = createRequire(import.meta.url);
const { npmEntry } = require(join(dist, "project", "toolchain.js"));
const npm = await npmEntry(process.execPath, process.env.npm_execpath);
const kit = join(dist, "npm");
const { version, dependencies, devDependencies, engines } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const archives = join(dist, "archives");
const runtimeDependencies = { ...dependencies, electron: devDependencies.electron };
const stage = await mkdtemp(join(tmpdir(), "morka-npm-kit-"));
try {
  await mkdir(kit);
  await mkdir(archives);
  await cp(join(root, "packages/project-template/package-lock.json"), join(kit, "project-lock.json"));
  await cp(join(root, "packages", "runtime", "install-app.cjs"), join(kit, "install-app.cjs"));
  for (const component of ["runtime", "packager"]) {
    const directory = join(stage, component);
    const source = join(root, "packages", component);
    const manifest = await readFile(join(source, "package.json"), "utf8");
    const packageInfo = JSON.parse(manifest);
    if (packageInfo.name !== `@morkaai/${component}` || packageInfo.version !== version ||
        !isDeepStrictEqual(packageInfo.engines, engines) ||
        (component === "runtime" && !isDeepStrictEqual(packageInfo.dependencies, runtimeDependencies)) ||
        (component === "packager" && packageInfo.peerDependencies?.["@morkaai/runtime"] !== version)) {
      throw new Error(`Keep packages/${component}/package.json in sync with the root package.`);
    }
    await mkdir(directory);
    await cp(join(source, "bin"), join(directory, "bin"), { recursive: true });
    await cp(join(root, "LICENSE"), join(directory, "LICENSE"));
    await cp(join(source, "README.md"), join(directory, "README.md"));
    await writeFile(join(directory, "package.json"), manifest);
    if (component === "runtime") {
      await cp(dist, join(directory, "dist"), {
        recursive: true, filter: path => path !== kit && path !== archives && path !== join(dist, "toolchain"),
      });
    }
    const [packed] = JSON.parse(execFileSync(process.execPath, [npm,
      "pack", "--json", "--ignore-scripts", "--cache", join(stage, "cache"), "--pack-destination", archives],
      { cwd: directory, encoding: "utf8" }));
    const archive = `morka-${component}.tgz`;
    await rename(join(archives, packed.filename), join(archives, archive));
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
