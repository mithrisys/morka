/* Run with Electron against a built checkout. Each sample is a unique warm edit. */
const { app, BrowserWindow } = require('electron');
const { mkdtemp, mkdir, readFile, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ManagedRuntime } = require('../dist/project/managed-runtime.js');
const { writableTree } = require('../dist/project/packages.js');
const { snapshot, applyFiles } = require('../dist/project/files.js');
const { jsonFile, starterManifest } = require('../dist/project/project.js');
const { LivePreview } = require('../dist/project/live-preview.js');
const { ChatSessions } = require('../dist/agents/sessions.js');

async function benchmark() {
  const home = await mkdtemp(join(tmpdir(), 'morka-live-benchmark-'));
  app.setPath('userData', join(home, 'profile'));
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const root = join(home, 'source');
  const runtime = new ManagedRuntime(root, join(home, 'runtime'), join(home, 'data'), console.error);
  try {
    const files = await snapshot(join(__dirname, '../dist/app-runtime/starter'));
    files.set('morka.project.json', jsonFile(starterManifest));
    files.set('index.html', Buffer.from('<link rel="stylesheet" href="/styles.css"><p>Ready</p><script src="/main.js"></script>'));
    files.set('morka.preview.json', Buffer.from(JSON.stringify({steps:[{kind:'expect',selector:'p'}],watch:['main.js']})));
    await mkdir(root);
    await applyFiles(root, new Map(), files);
    const contents = window.webContents;
    const live = new LivePreview(contents, error => { throw Error(error); });
    contents.send = (channel, url) => {
      if (channel === 'canvas:update') void contents.executeJavaScript('document.querySelector("iframe").src=' + JSON.stringify(url));
    };
    await writeFile(join(home,'shell.html'), '<iframe name="morka-preview"></iframe>');
    await window.loadFile(join(home,'shell.html'));
    let visible, start;
    const callbacks = {
      beforeActivate: () => live.prepare(),
      activate: async (url, styles) => {
        await live.show(url, styles, { confirm: true });
        visible = performance.now();
        await live.completeUpdate();
      }
    };
    await runtime.update(files, starterManifest.runtime, callbacks);
    const connection = { prompt: async turn => {
      const [path, content] = JSON.parse(turn.text);
      await writeFile(join(turn.cwd, path), content);
      start = performance.now();
      return 'completed';
    }};
    const chats = await ChatSessions.open(join(home,'chats'),root,{get:()=>({info:{id:'mock',name:'Mock'},connection})});
    if (chats.setPreviewReviewer) chats.setPreviewReviewer(require('../dist/electron/scenario-review.js').reviewScenario);
    chats.setProjectPreparer((source,signal,onLog)=>runtime.prepare(source,{signal,onLog,updateLock:true}));
    chats.setProjectActivator((project,publish,signal)=>runtime.update(project.files,project.manifest.runtime,{...callbacks,publish},{signal}));
    const chat = await chats.create();
    const results = {};
    for (const path of ['styles.css','index.html','main.js']) {
      const samples = [];
      for (let i=0; i<31; i++) {
        const content = path === 'styles.css' ? 'p {margin: '+i+'px}' :
          path === 'main.js' ? 'document.querySelector("p").dataset.value="'+i+'";' :
          files.get(path).toString().replace('Ready','Sample '+i);
        await chats.send(chat.id,JSON.stringify([path,content]),undefined,()=>{},undefined,{providerId:'mock'});
        if (i) samples.push(visible-start);
      }
      samples.sort((a,b)=>a-b);
      results[path] = { samples:samples.length, p95Ms: Math.round(samples[28]), medianMs:Math.round(samples[14]) };
    }
    chats.close();
    console.log(JSON.stringify(results));
    if (process.env.MORKA_BENCHMARK_BASELINE) {
      const baseline = JSON.parse(await readFile(process.env.MORKA_BENCHMARK_BASELINE, 'utf8'));
      for (const [path, sample] of Object.entries(results)) {
        const reference = baseline[path]?.p95Ms;
        if (!Number.isFinite(reference) || sample.p95Ms > reference + Math.max(50, reference * .05)) {
          throw Error(path + ' exceeded the warm-edit budget: ' + sample.p95Ms + ' ms vs ' + reference + ' ms');
        }
      }
    }
  } finally {
    await runtime.stop();
    window.destroy();
    await writableTree(home);
    await rm(home,{recursive:true,force:true,maxRetries:5});
  }
}
app.on('window-all-closed',()=>{});
benchmark().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
