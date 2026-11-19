import { chmod, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { npmEntry } from "./toolchain";

// Bundle the build's actual Node/npm pair, independently of Electron's Node ABI.
// Releases never resolve `node` or `npm` from the end user's PATH.
export async function bundleToolchain(destination: string) {
  const node = await realpath(process.execPath);
  const windows = process.platform === "win32";
  const prefix = windows ? dirname(node) : dirname(dirname(node));
  const npm = process.env.MORKA_NPM_DIR
    ? await realpath(process.env.MORKA_NPM_DIR)
    : dirname(dirname(await npmEntry(node, process.env.npm_execpath)));
  const metadata = JSON.parse(await readFile(join(npm, "package.json"), "utf8"));
  await mkdir(join(destination, "bin"), { recursive: true });
  await cp(node, join(destination, "bin", windows ? "node.exe" : "node"));
  const relativeDateTranslations = join(npm, "node_modules", "tiny-relative-date", "translations");
  await cp(npm, join(destination, "npm"), {
    recursive: true,
    dereference: true,
    filter: path => dirname(path) !== relativeDateTranslations || /^en(?:-short)?\.js$/.test(basename(path)),
  });
  if (!windows) await cp(join(prefix, "include", "node"), join(destination, "include", "node"), { recursive: true, dereference: true });
  for (const [name, entry] of [["npm", "npm-cli.js"], ["npx", "npx-cli.js"]]) {
    if (windows) {
      await writeFile(join(destination, "bin", name + ".cmd"), '@"%~dp0node.exe" "%~dp0..\\npm\\bin\\' + entry + '" %*\r\n');
      continue;
    }
    const path = join(destination, "bin", name);
    await writeFile(path, '#!/bin/sh\nnode_dir="$(dirname "$0")"\nexec "$node_dir/node" "$node_dir/../npm/bin/' + entry + '" "$@"\n');
    await chmod(path, 0o755);
  }
  const license = await realpath(join(prefix, "LICENSE")).catch(() =>
    realpath(join(prefix, "share", "doc", "node", "LICENSE")));
  await cp(license, join(destination, "NODE-LICENSE"));
  await writeFile(join(destination, "toolchain.json"), JSON.stringify({
    version: 1, node: process.version, npm: metadata.version, platform: process.platform, arch: process.arch,
    abi: process.versions.modules,
  }, null, 2) + "\n");
}
