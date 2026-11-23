import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";


export function publishedProjectLock(version, archives, lock) {
  for (const [component, bytes] of Object.entries(archives)) {
    const name = "@morkaai/" + component;
    const pkg = lock.packages["node_modules/" + name];
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    if (pkg.version !== version || pkg.integrity !== integrity) throw Error("Lock does not match the packed " + name);
    const field = component === "runtime" ? "dependencies" : "devDependencies";
    lock.packages[""][field][name] = version;
    pkg.resolved = "https://registry.npmjs.org/" + name + "/-/" + component + "-" + version + ".tgz";
  }
  if (lock.packages["node_modules/@morkaai/packager"].peerDependencies["@morkaai/runtime"] !== version) {
    throw Error("The packaged runtime peer dependency must match the release.");
  }
  return lock;
}

if (import.meta.main) {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  const template = JSON.parse(await readFile("packages/project-template/package.json", "utf8"));
  const work = await mkdtemp(join(tmpdir(), "morka-release-lock-"));
  try {
    const archives = {};
    for (const component of ["runtime", "packager"]) {
      const path = resolve("dist/archives/morka-" + component + ".tgz");
      archives[component] = await readFile(path);
      const field = component === "runtime" ? "dependencies" : "devDependencies";
      template[field]["@morkaai/" + component] = pathToFileURL(path).href;
    }
    await writeFile(join(work, "package.json"), JSON.stringify(template));
    await writeFile(join(work, "package-lock.json"), await readFile("packages/project-template/package-lock.json"));
    const { npmEntry } = await import("../../dist/project/toolchain.js");
    const npm = await npmEntry(process.execPath, process.env.npm_execpath);
    execFileSync(process.execPath, [npm, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: work, stdio: "inherit" });
    const lock = publishedProjectLock(version, archives, JSON.parse(await readFile(join(work, "package-lock.json"), "utf8")));
    await writeFile(process.argv[2], JSON.stringify(lock, null, 2) + "\n");
  } finally { await rm(work, { recursive: true, force: true }); }
}
