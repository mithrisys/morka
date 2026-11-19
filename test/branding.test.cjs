const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { test } = require('node:test');
const { appsDirectory } = require('../dist/instances/repository.js');
const { AppProxy } = require('../dist/project/app-proxy.js');
const { snapshot } = require('../dist/project/files.js');
const { compileProject } = require('../dist/project/project.js');
const { editableAppFiles, installedShadowDescription } = require('../dist/project/shadow-effects.js');

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'morka-branding-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('the Morka app profile retains its data and stable browser origin', () => fixture(async root => {
  const directory = appsDirectory(root);
  assert.equal(directory, join(root, 'Morka Apps'));
  const relativeOrigin = 'instances/test/runtime/test/origin.json';
  const originFile = join(directory, relativeOrigin);
  await mkdir(dirname(originFile), { recursive: true });
  await writeFile(join(directory, 'instances/test/chats.json'), 'saved chats');
  const original = new AppProxy(originFile, join(directory, 'origins'));
  let origin;
  try { origin = await original.start(); } finally { await original.close(); }

  assert.equal(await readFile(join(directory, 'instances/test/chats.json'), 'utf8'), 'saved chats');
  const updated = new AppProxy(originFile, join(directory, 'origins'));
  try {
    assert.equal(await updated.start(), origin);
    const ports = JSON.parse(await readFile(join(directory, 'origins/ports.json'), 'utf8'));
    assert.deepEqual(ports, { [createHash('sha256').update(originFile).digest('hex')]: Number(new URL(origin).port) });
  } finally { await updated.close(); }
}));

test('private data and installed Shadow records stay out of editable project files', () => fixture(async root => {
  await mkdir(join(root, '.morka-data'));
  await writeFile(join(root, '.morka-data/state.json'), 'private');
  const files = new Map([
    ['morka.project.json', Buffer.from(JSON.stringify({ version: 1, runtime: { type: 'node' } }))],
    ['index.html', Buffer.from('<h1>App</h1>')],
    ['.morka-shadows/example/package/manifest.json', Buffer.from('{"description":"Example"}')],
  ]);
  assert.equal((await snapshot(root)).size, 0);
  const project = await compileProject(files);
  assert.equal(project.manifest.runtime.type, "node");
  assert.equal(installedShadowDescription(files, 'example'), 'Example');
  assert.equal(editableAppFiles(files).size, 2);
}));
