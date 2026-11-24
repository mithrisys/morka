import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function releaseNotes(changelog, version) {
  const sections = changelog.replaceAll("\r\n", "\n").split(/^## /m).slice(1);
  const matches = sections.filter(section => {
    const heading = section.split("\n", 1)[0].match(/^(\S+) \(\d{4}-\d{2}-\d{2}\)$/);
    return heading?.[1] === version;
  });
  const body = matches[0]?.split("\n").slice(1).join("\n").trim();
  if (matches.length !== 1 || !body) throw new Error(`Expected one nonempty dated CHANGELOG entry for ${version}.`);
  return body + "\n";
}

export function desktopAssets(version) {
  const linux = arch => {
    const prefix = `morka-${version}-Linux-${arch}`;
    return { tar: `${prefix}.tar.gz`, deb: `${prefix}.deb`, rpm: `${prefix}.rpm` };
  };
  return {
    "darwin-arm64": { dmg: `morka-${version}-macOS-arm64.dmg` },
    "win32-x64": { nsis: `morka-${version}-Windows-x64-Setup.exe` },
    "win32-arm64": { nsis: `morka-${version}-Windows-arm64-Setup.exe` },
    "linux-x64": linux("x64"),
    "linux-arm64": linux("arm64"),
  };
}

export async function writeChecksums(directory, version) {
  const expected = Object.values(desktopAssets(version)).flatMap(Object.values).sort();
  const entries = (await readdir(directory)).filter(name => name !== "SHA256SUMS.txt").sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) throw new Error("Expected exactly the downloads for each supported desktop target and package format.");
  const lines = [];
  for (const name of expected) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
    lines.push(hash.digest("hex") + "  " + name);
  }
  await writeFile(join(directory, "SHA256SUMS.txt"), lines.join("\n") + "\n");
}

if (import.meta.main) {
  const { version } = JSON.parse(await readFile("package.json", "utf8"));
  await writeChecksums(process.argv[2], version);
  await writeFile(process.argv[3], releaseNotes(await readFile("CHANGELOG.md", "utf8"), version));
}
