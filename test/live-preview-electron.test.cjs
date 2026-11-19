const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { LivePreview } = require('../dist/project/live-preview.js');
const { snapshot, applyFiles } = require('../dist/project/files.js');
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let css = 'h1 {color: blue}';
let brokenPreview = false;
let server, window;
let hostBridge;
const errors = [];
const html = `<!doctype html><link rel="stylesheet" href="/assets/styles.css"><style>body{height:3000px}#panel{height:100px;overflow:auto}#inside{height:1000px}</style>
<script src="/__morka/bridge.js"></script><h1>Title</h1><form><input id="draft" name="draft"><select id="choice"><option>a</option><option>b</option></select></form><div id="panel"><div id="inside">Panel</div></div><p id="filter"></p>
<script>
window.requestAnimationFrame=()=>0;
let filter = 'all';
function setFilter(value) {filter=value; document.querySelector('#filter').textContent=value;}
window.setFilter = setFilter;
window.morkaLifecycle = {ready: new Promise(resolve=>setTimeout(()=>{setFilter('all');resolve()},100)), capture: ()=>({filter}), restore: state=>setFilter(state.filter)};
window.generation = Math.random();
</script>`;
async function until(check) {
  const deadline = Date.now()+10000;
  while (!(await check())) {assert.ok(Date.now()<deadline,'Timed out waiting for preview state'); await delay(20);}
}
(async()=>{
  const workspace = process.env.MORKA_PREVIEW_TEST_DIR;
  const root = join(workspace, 'files');
  await mkdir(root);
  app.setPath('userData', join(workspace, 'profile'));
  await app.whenReady();
  hostBridge=await readFile(join(__dirname,'../dist/app-runtime/bridge.js'),'utf8');
  server=createServer(async(req,res)=>{
    if(req.url==='/__morka/bridge.js'){res.setHeader('content-type','text/javascript');res.end(hostBridge);}
    else if((req.url.startsWith('/styles.css') || req.url.startsWith('/assets/styles.css'))) {res.setHeader('content-type','text/css');res.end(css);}
    else if(req.url==='/write') {await delay(200); await writeFile(join(root,'saved.json'),'saved user data'); res.end('saved');}
    else {
      res.setHeader('content-type','text/html');
      if (brokenPreview) {res.statusCode=500;res.end('<h1>Broken preview</h1>');}
      else res.end(html);
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/`;
  window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  const contents=window.webContents;
  const send=contents.send.bind(contents);
  contents.send=(channel,value)=>{
    if(channel==='canvas:update') void contents.mainFrame.executeJavaScript(`document.querySelector('iframe').src=${JSON.stringify(value)}`);
    else send(channel,value);
  };
  const live=new LivePreview(contents,error=>errors.push(error),url);
  await writeFile(join(root,'shell.html'), `<iframe name="morka-preview" src="${url}"></iframe>`);
  await window.loadFile(join(root,'shell.html'));
  const frame=()=>contents.mainFrame.frames.find(f=>f.name==='morka-preview');
  await until(async()=>frame() && await frame().executeJavaScript('Boolean(window.__morkaLive && window.morkaLifecycle)'));
  const rendererSource=await readFile(join(__dirname,'../host/renderer/renderer.ts'),'utf8');
  const relayStart=rendererSource.indexOf('window.addEventListener("message", async (event) => {');
  const relayEnd=rendererSource.indexOf('\nfunction showPreview',relayStart);
  assert.ok(relayStart>=0&&relayEnd>relayStart);
  await contents.mainFrame.executeJavaScript('const preview=document.querySelector("iframe");window.lab={invokeAddon:async(url,request)=>({value:{action:request.action,input:request.input}})};'+rendererSource.slice(relayStart,relayEnd));
  const hostResult=await frame().executeJavaScript('window.morka.runAgentAction("echo",{value:"bridge works"})');
  assert.equal(hostResult.action,'echo');assert.equal(hostResult.input.value,'bridge works');

  await frame().executeJavaScript(`window.morkaLifecycle.ready.then(()=>{history.pushState({step:2},'', '/tasks?view=active#row-2'); setFilter('active'); const input=document.querySelector('#draft');input.value='unfinished draft';input.setSelectionRange(3,8);document.querySelector('#choice').value='b';window.scrollTo(0,500);document.querySelector('#panel').scrollTop=80;localStorage.setItem('user-data','keep');})`);
  const first=await frame().executeJavaScript('window.generation');
  css='h1 {color: orange}';
  await live.show(url,['styles.css']);
  assert.equal(await frame().executeJavaScript('getComputedStyle(document.querySelector("h1")).color'),'rgb(255, 165, 0)');
  assert.equal(await frame().executeJavaScript('window.generation'),first,'CSS must not recreate the document');
  assert.equal(await frame().executeJavaScript('new URL(document.querySelector("link").href).pathname'),'/assets/styles.css','CSS updates must preserve relative asset URL bases');
  assert.equal(await frame().executeJavaScript('document.querySelector("#draft").value'),'unfinished draft');
  assert.equal(await frame().executeJavaScript('document.querySelector("#filter").textContent'),'active');
  await frame().executeJavaScript(`const fileInput=document.createElement('input'); fileInput.type='file';fileInput.id='upload';document.body.append(fileInput);const transfer=new DataTransfer();transfer.items.add(new File(['draft'],'draft.txt'));fileInput.files=transfer.files;`);
  await live.show(url);
  assert.match(errors.pop(),/file selection/);
  assert.equal(await frame().executeJavaScript('window.generation'),first);
  await frame().executeJavaScript(`document.querySelector('#upload').remove()`);
  await frame().executeJavaScript(`void fetch('/write',{method:'POST'}).then(r=>r.text());`);
  await live.prepare();
  assert.equal(await readFile(join(root,'saved.json'),'utf8'),'saved user data','pending writes finish before restarting');
  await live.show(url);
  await until(async()=>await frame().executeJavaScript(`window.generation!==${first} && document.querySelector('#filter').textContent==='active'`));
  assert.equal(await frame().executeJavaScript('location.pathname+location.search+location.hash'),'/tasks?view=active#row-2');
  assert.equal(await frame().executeJavaScript('history.state.step'),2);
  assert.equal(await frame().executeJavaScript('document.querySelector("#draft").value'),'unfinished draft');
  assert.equal(await frame().executeJavaScript('document.querySelector("#draft").selectionStart'),3);
  assert.equal(await frame().executeJavaScript('document.querySelector("#choice").value'),'b');
  await until(async()=>await frame().executeJavaScript('document.querySelector("#panel").scrollTop===80'));
  assert.equal(await frame().executeJavaScript('localStorage.getItem("user-data")'),'keep');
  assert.deepEqual(errors,[]);
  await live.prepare();
  brokenPreview=true;
  await assert.rejects(live.show(url, undefined, {confirm:true}), /HTTP 500/);
  brokenPreview=false;
  await live.show(url, undefined, {confirm:true, recover:true});
  await live.completeUpdate();
  assert.equal(await frame().executeJavaScript('document.querySelector("#draft").value'),'unfinished draft');
  assert.equal(await frame().executeJavaScript('localStorage.getItem("user-data")'),'keep');
  assert.deepEqual(errors,[]);
  await writeFile(join(root,'todos.sqlite'),'original data');
  await writeFile(join(root,'todos.sqlite-wal'),'pending transaction');
  await writeFile(join(root,'source.js'),'source');
  const files=await snapshot(root);
  assert.equal(files.has('todos.sqlite'),false);
  assert.equal(files.has('todos.sqlite-wal'),false);
  await assert.rejects(applyFiles(root,new Map(),new Map([['todos.sqlite',Buffer.from('overwrite')]])),/Invalid project path/);
  assert.equal(await readFile(join(root,'todos.sqlite'),'utf8'),'original data');
  window.destroy();
  console.log('PASS: CSS preserves document and state; full code updates preserve route, history, draft, selection, filter, nested scrolling and localStorage; pending writes drain; database files are protected.');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
  if(window&&!window.isDestroyed())window.destroy();
  if(server)await new Promise(resolve=>server.close(resolve));
  app.exit(process.exitCode||0);
});
