import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { applyFiles, info, type Files } from "../project/files";
import { jsonFile } from "../project/project";

export const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const repositoryConfig = [".morka", "release.json"];
export const repositoryKit = [".morka", "npm"];
export const releaseFile = "morka-release.json";
export const releaseProject = "morka-project";
export const bundledKit = "morka-npm";
export const preparedRelease = "morka-app-release";
export const appIcon = "AppIcon.icns";

export function appsDirectory(appData: string) {
  return join(appData, "Morka Apps");
}

export function repositoryFile(repository: string, ...parts: string[]) {
  return join(repository, ".morka", ...parts);
}

export type AppRelease = {
  version: 1;
  id: string;
  name: string;
  iconColor: number;
  clonedFrom?: { id: string; revision: string };
};

export function checkoutKey(directory: string) {
  return createHash("sha256").update(process.platform === "win32" ? directory.toLowerCase() : directory).digest("hex");
}

export function repositoryProfileId(spec: AppRelease, repository: string) {
  return createHash("sha256").update(spec.id + ":" + checkoutKey(repository)).digest("hex").slice(0, 32);
}

export function appName(value: unknown) {
  const name = typeof value === "string" ? value.trim().normalize("NFC") : "";
  if (!name || name.length > 72 || name.startsWith(".") || /[/:\\\p{Cc}]/u.test(name) || /\.app$/i.test(name)) {
    throw new Error("Enter an app name of up to 72 characters. Leave out slashes, colons, and the .app extension.");
  }
  return name;
}

export function portableAppName(value: unknown) {
  const name = appName(value);
  if (/[<>"|?*]/.test(name) || name.endsWith(".") ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) {
    throw new Error("Choose an app name that can be used as a folder on Windows, macOS, and Linux.");
  }
  return name;
}

export function readRelease(path: string): AppRelease {
  const spec = JSON.parse(readFileSync(path, "utf8")) as AppRelease;
  if (spec?.version !== 1 || typeof spec.id !== "string" || !idPattern.test(spec.id) ||
      spec.name !== appName(spec.name) || !Number.isInteger(spec.iconColor) || spec.iconColor < 0 || spec.iconColor >= 8) {
    throw new Error("Invalid Morka release configuration.");
  }
  const { id, name, iconColor, clonedFrom } = spec;
  if (clonedFrom && (!idPattern.test(clonedFrom.id) || !/^[a-f0-9]{64}$/.test(clonedFrom.revision))) {
    throw new Error("Invalid Morka clone origin.");
  }
  portableAppName(name);
  return { version: 1, id, name, iconColor, ...(clonedFrom ? {
    clonedFrom: { id: clonedFrom.id, revision: clonedFrom.revision },
  } : {}) };
}

export async function repositoryProject(repository: string) {
  const project = join(await realpath(repository), "app");
  if (!(await info(project))?.isDirectory()) throw new Error("The repository needs a regular app/ directory.");
  return project;
}

export async function materializeRepository(parent: string, spec: AppRelease, files: Files, kit: string, icon: Buffer) {
  const directory = await realpath(parent);
  const destination = join(directory, spec.name);
  if (await info(destination)) throw new Error(`A folder named “${spec.name}” already exists at that location.`);
  const staged = await mkdtemp(join(directory, ".morka-project-"));
  try {
    await writeRepository(staged, spec, files, kit, icon);
    if (process.platform === "win32") {
      await rename(staged, destination);
      return destination;
    }
    await mkdir(destination, { mode: 0o700 });
    try {
      await rename(staged, destination);
    } catch (error) {
      await rmdir(destination).catch(console.error);
      throw error;
    }
    return destination;
  } finally {
    await rm(staged, { recursive: true, force: true }).catch(console.error);
  }
}

export async function writeRepositoryScaffold(directory: string, name: string, kit: string,
  scripts: Record<string, string>, readme: string, instructions: string) {
  const lock = JSON.parse(await readFile(join(kit, "project-lock.json"), "utf8"));
  const config = join(directory, ".morka");
  const git = join(directory, ".git");
  const packageJson = {
    name,
    version: lock.version,
    private: true,
    scripts,
    engines: { node: ">=24" },
    dependencies: lock.packages[""].dependencies,
    devDependencies: lock.packages[""].devDependencies,
  };
  lock.name = lock.packages[""].name = name;
  lock.packages[""].engines = packageJson.engines;
  await Promise.all([
    mkdir(config, { recursive: true }),
    mkdir(join(git, "objects", "info"), { recursive: true }),
    mkdir(join(git, "objects", "pack"), { recursive: true }),
    mkdir(join(git, "refs", "heads"), { recursive: true }),
    mkdir(join(git, "refs", "tags"), { recursive: true }),
  ]);
  await Promise.all([
    cp(kit, join(directory, ...repositoryKit), { recursive: true }),
    writeFile(join(directory, "package.json"), jsonFile(packageJson)),
    writeFile(join(directory, "package-lock.json"), jsonFile(lock)),
    writeFile(join(directory, ".gitignore"), "node_modules/\n/dist/\n/.morka/install.lock\n.DS_Store\n.env\n.env.*\n!.env.example\n.morka-data/\n*.sqlite\n*.sqlite-*\n*.sqlite3\n*.sqlite3-*\n*.db\n*.db-*\n"),
    writeFile(join(directory, ".gitattributes"), "* text=auto\n*.icns binary\n*.tgz binary\n"),
    writeFile(join(directory, "AGENTS.md"), instructions),
    writeFile(join(directory, "README.md"), readme),
    writeFile(join(git, "HEAD"), "ref: refs/heads/main\n"),
    writeFile(join(git, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n"),
  ]);
}

export function repositorySlug(name: string) {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function writeRepository(directory: string, spec: AppRelease, files: Files, kit: string, icon: Buffer) {
  const project = join(directory, "app");
  const config = join(directory, ".morka");
  const name = repositorySlug(spec.name) || `morka-app-${spec.id.slice(0, 8)}`;
  const scripts = { start: "morka run", build: "morka-pack local-build",
    "package:mac": "morka-pack package:mac", "install:app": "node .morka/npm/install-app.cjs" };
  const localInstructions = `## Run locally

Install Node.js 24 or newer with npm on macOS, Windows, or Linux.

\`\`\`sh
npm ci
npm start
\`\`\`

Run \`npm run install:app\` to install the project in your Applications or app menu.
This command installs missing npm dependencies. The installed app opens this
checkout and uses the same local app data and chats as \`npm start\`.

You can also open this folder in Morka. To create a local launch script, run
\`npm run build\` after installing the dependencies. The generated script lives
in \`dist/\` and opens this checkout. On macOS, run \`npm run package:mac\`
for a self-contained build.

Use the app package's test script for its fast behavior checks. Run \`/review\` in Morka chat to exercise its preview scenario with synthetic data.

If the project uses AI, open **AI setup** and sign in with your own supported
local CLI. Your account, chats and app data are stored outside the repository.

Commit the app source, lockfiles and .morka/ to share this repo. The root
package.json pins the published Morka runtime and packager versions.
`;
  await writeRepositoryScaffold(directory, name, kit, scripts, `# ${spec.name}

A desktop app built with Morka. The app source and dependencies live in \`app/\`.

${localInstructions}`, "# Editing the app\n\nRead app/morka.project.json first. App changes belong under app/. Leave root repository tooling, README, Git configuration, root npm metadata and .morka/ alone during app edits. App dependencies belong in app/package.json and app/package-lock.json; those app files are editable.\n");
  await mkdir(project);
  await mkdir(join(config, "icons"));
  await Promise.all([
    applyFiles(project, new Map(), files),
    writeFile(join(config, "release.json"), jsonFile(spec)),
    writeFile(join(config, "icons", appIcon), icon),
  ]);
}
