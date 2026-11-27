const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const { mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app } = require("electron");
const { desktopUpdateClient, DesktopUpdates, verifyWindowsUpdate } = require("../dist/electron/desktop-updates.js");

async function testDownload(workspace, format, arch, filename) {
  const version = "999.0.0";
  const asset = `morka-${version}-${filename}`;
  const bytes = Buffer.from("fixture update package");
  const sha512 = createHash("sha512").update(bytes).digest("base64");
  const metadata = JSON.stringify({ version, supportedRuntimeApis: [1], files: [
    { url: "unexpected-package.exe", size: bytes.length, sha512 }, { url: asset, size: bytes.length, sha512 },
  ] });
  let corrupt = true;
  const requested = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path.endsWith(".yml")) { response.end(metadata); return; }
    requested.push(path);
    if (path === `/${asset}`) { response.end(corrupt ? "corrupt update package" : bytes); return; }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = desktopUpdateClient(format);
  try {
    client.logger = null;
    client.forceDevUpdateConfig = true;
    Object.defineProperty(client.app, "baseCachePath", { value: workspace });
    const configuration = join(workspace, `${format}-provider.yml`);
    await writeFile(configuration, JSON.stringify({ provider: "generic", url: `http://127.0.0.1:${server.address().port}`,
      updaterCacheDirName: `updater-${format}` }));
    client.updateConfigPath = configuration;
    const updates = new DesktopUpdates(client, "1.0.0", [1], () => {}, { arch, format });
    await updates.check();
    assert.deepEqual(updates.state, { status: "available", version });
    assert.deepEqual(requested, []);
    await updates.download();
    assert.equal(updates.state.status, "available");
    assert.match(updates.state.detail, /sha512|checksum/i);
    corrupt = false;
    await updates.download();
    assert.deepEqual(updates.state, { status: "ready", version });
    assert.deepEqual(requested, [`/${asset}`, `/${asset}`]);
    if (format === "nsis" && process.platform === "win32") {
      const path = join(workspace, `updater-${format}`, "pending", asset);
      assert.deepEqual(await readFile(path), bytes);
      await assert.rejects(verifyWindowsUpdate(path, "CN=Morka Test"), /signature could not be verified/);
    }
    console.log(`PASS: ${format} waits for approval, selects the expected asset, and rejects a corrupt download.`);
  } finally {
    client.closeServerIfExists?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), "morka-update-download-"));
  try {
    const profile = join(work, "profile");
    await mkdir(profile);
    app.setPath("userData", profile);
    await app.whenReady();
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    if (process.platform === "darwin") await testDownload(work, "zip", "arm64", "macOS-arm64.zip");
    await testDownload(work, "nsis", arch, `Windows-${arch}-Setup.exe`);
    for (const [format, extension] of [["deb", "deb"], ["rpm", "rpm"], ["tar", "tar.gz"]]) {
      await testDownload(work, format, arch, `Linux-${arch}.${extension}`);
    }
  } finally { await rm(work, { recursive: true, force: true, maxRetries: 5 }); }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
