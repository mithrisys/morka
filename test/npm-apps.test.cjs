const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { AppProxy } = require('../dist/project/app-proxy.js');
const { AppPackages, writableTree } = require('../dist/project/packages.js');
const { ManagedRuntime } = require('../dist/project/managed-runtime.js');
const { readManifest, compileProject } = require('../dist/project/project.js');
const { bundledToolchain } = require('../dist/project/toolchain.js');
const { ChatSessions } = require('../dist/agents/sessions.js');
const { snapshot, digest } = require('../dist/project/files.js');

const bytes = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function appSource(extra = {}, pkg = {}) {
  return new Map(Object.entries({
    'morka.project.json': { version: 1, runtime: { type: 'node' } },
    'package.json': { name: 'isolated-app', version: '1.0.0', private: true, scripts: { start: 'node server.cjs' }, dependencies: { 'app-library': 'file:vendor/library' }, ...pkg },
    'vendor/library/package.json': { name: 'app-library', version: '1.0.0', main: 'index.cjs' },
    'vendor/library/index.cjs': "module.exports='first';",
    'server.cjs': `const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
      const value=require('app-library');
      http.createServer(async(q,s)=>{
        if(q.url==='/health'){s.end('ready');return;}
        if(q.url==='/slow-write'&&q.method==='POST'){await new Promise(r=>setTimeout(r,300));fs.writeFileSync(path.join(process.env.MORKA_DATA_DIR,'user.json'),'user write completed');s.end('saved');return;}
        if(q.url==='/env'){s.end(JSON.stringify({node:process.execPath,phase:process.env.MORKA_PHASE,active:global.morkaRuntime.isActive(),secret:process.env.MORKA_HOST_TEST_SECRET}));return;}
        if(q.url==='/styles.css'){s.end(fs.readFileSync(path.join(__dirname,'styles.css')));return;}
        s.end(value);
      }).listen(Number(process.env.PORT),process.env.HOST);`,
    'styles.css': 'h1{color:blue}', ...extra,
  }).map(([path,value])=>[path,bytes(value)]));
}
async function fixture(run) {
  const directory=await mkdtemp(join(tmpdir(),'morka-npm-apps-'));
  try { await run(directory); } finally { await writableTree(directory); await rm(directory,{recursive:true,force:true}); }
}
async function put(root,files) {
  for(const [path,data] of files){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),data);}
}

test('isolated npm resolves a lockfile, installs arbitrary local packages, builds and prunes dev dependencies',()=>fixture(async home=>{
  const source=appSource({
    'build.cjs': "require('node:fs').writeFileSync('built.txt',require('app-library')+require('build-tool'));",
    'vendor/build-tool/package.json': {name:'build-tool',version:'1.0.0',main:'index.cjs'},
    'vendor/build-tool/index.cjs': "module.exports=' built';",
  },{scripts:{start:'node server.cjs',build:'node build.cjs'},devDependencies:{'build-tool':'file:vendor/build-tool'}});
  const manager=new AppPackages(home);
  const artifact=await manager.prepare(source,{updateLock:true});
  assert.equal(await readFile(join(artifact.directory,'built.txt'),'utf8'),'first built');
  assert.ok(artifact.source.has('package-lock.json'));
  assert.equal((await readFile(join(artifact.directory,'node_modules/app-library/index.cjs'),'utf8')).trim(),"module.exports='first';");
  await assert.rejects(readFile(join(artifact.directory,'node_modules/build-tool/package.json')),/ENOENT/);
  const again=await manager.prepare(artifact.source,{offline:true});
  assert.equal(artifact.directory,again.directory);
  assert.equal((await snapshot(artifact.directory)).has('node_modules/app-library/index.cjs'),false);
}));

test('package lifecycle scripts cannot read or overwrite user data outside their preparation stage',()=>fixture(async home=>{
  const secret=join(home,'user-data.txt');await writeFile(secret,'preserve user data');
  const installer=`const fs=require('node:fs');let blocked=0;try{fs.readFileSync(${JSON.stringify(secret)})}catch{blocked++}try{fs.writeFileSync(${JSON.stringify(secret)},'overwrite')}catch{blocked++}fs.writeFileSync('isolation.txt',String(blocked));`;
  const source=appSource({'install.cjs':installer},{scripts:{start:'node server.cjs',postinstall:'node install.cjs'}});
  const artifact=await new AppPackages(join(home,'runtime')).prepare(source,{updateLock:true});
  assert.equal(await readFile(join(artifact.directory,'isolation.txt'),'utf8'),'2');
  assert.equal(await readFile(secret,'utf8'),'preserve user data');
}));

test('native Node-API packages build against bundled headers and run under bundled Node',()=>fixture(async home=>{
  const native=`#include <node_api.h>\nstatic napi_value init(napi_env env,napi_value exports){napi_value n;napi_create_int32(env,42,&n);napi_set_named_property(env,exports,"answer",n);return exports;}\nNAPI_MODULE(NODE_GYP_MODULE_NAME,init)\n`;
  const source=appSource({
    'vendor/library/package.json':{name:'app-library',version:'1.0.0',main:'index.cjs',scripts:{install:'node install.cjs'}},
    'vendor/library/index.cjs':"module.exports=require('./addon.node').answer;",
    'vendor/library/addon.c':native,
    'vendor/library/install.cjs':`require('node:child_process').execFileSync('/usr/bin/clang',['-bundle','-undefined','dynamic_lookup','-DNODE_GYP_MODULE_NAME=morka_test','-I'+process.env.npm_package_config_node_gyp_nodedir+'/include/node','addon.c','-o','addon.node'],{stdio:'inherit'});`,
    'build.cjs':"require('node:fs').writeFileSync('answer.txt',String(require('app-library')))",
  },{scripts:{start:'node server.cjs',build:'node build.cjs'}});
  const artifact=await new AppPackages(home).prepare(source,{updateLock:true});
  assert.equal(await readFile(join(artifact.directory,'answer.txt'),'utf8'),'42');
  const result=spawnSync(artifact.toolchain.node,['-e',"console.log(require('app-library'))"],{cwd:artifact.directory,encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'42');
}));

test('a stale lockfile fails frozen preparation and can be repaired in a draft',()=>fixture(async home=>{
  const manager=new AppPackages(home);
  const original=await manager.prepare(appSource(),{updateLock:true});
  const changed=new Map(original.source);
  changed.set('package.json',bytes({...JSON.parse(changed.get('package.json')),dependencies:{'another-package':'file:vendor/another'}}));
  changed.set('vendor/another/package.json',bytes({name:'another-package',version:'1.0.0',main:'index.cjs'}));
  changed.set('vendor/another/index.cjs',bytes("module.exports='new';"));
  await assert.rejects(manager.prepare(changed),/npm ci.*failed/s);
  const fixed=await manager.prepare(changed,{updateLock:true});
  assert.ok(JSON.parse(fixed.source.get('package-lock.json')).packages['node_modules/another-package']);
}));

test('managed releases retain the stable origin, drain writes, preserve data and keep the prior app on candidate failure',()=>fixture(async home=>{
  process.env.MORKA_HOST_TEST_SECRET='must not enter app';
  const errors=[];const runtime=new ManagedRuntime(home,join(home,'runtime'),join(home,'data'),error=>errors.push(error));
  const activations=[];let before=0;
  const callbacks={beforeActivate:async()=>{before++},activate:async(url,styles)=>{activations.push({url,styles});if(styles)await(await fetch(url+'styles.css')).text();}};
  try{
    const initial=(await runtime.prepare(appSource(),{updateLock:true})).source;
    const spec=readManifest(initial).runtime;
    await runtime.update(initial,spec,callbacks);
    const url=runtime.url;
    assert.equal(await(await fetch(url)).text(),'first');
    const env=await(await fetch(url+'env')).json();
    assert.ok(env.node.endsWith('/toolchain/bin/node'));assert.equal(env.secret,undefined);assert.equal(env.active,true);
    const css=new Map(initial);css.set('styles.css',bytes('h1{color:orange}'));
    const firstRecord=JSON.parse(await readFile(join(home,'runtime/active.json'),'utf8'));
    await runtime.update(css,spec,callbacks);
    assert.equal(before,1,'CSS must not recreate the page or pause user work');
    assert.equal(JSON.parse(await readFile(join(home,'runtime/active.json'),'utf8')).processDirectory,firstRecord.processDirectory);
    assert.equal(await(await fetch(url+'styles.css')).text(),'h1{color:orange}');
    const pending=fetch(url+'slow-write',{method:'POST'}).then(response=>response.text());
    await delay(30);
    const next=new Map(css);next.set('vendor/library/index.cjs',bytes("module.exports='second';"));
    await runtime.update(next,spec,callbacks);
    assert.equal(await pending,'saved');
    assert.equal(await readFile(join(home,'data/user.json'),'utf8'),'user write completed');
    assert.equal(runtime.url,url);assert.equal(await(await fetch(url)).text(),'second');
    const active=await readFile(join(home,'runtime/active.json'),'utf8');
    const bad=new Map(next);bad.set('server.cjs',bytes("throw Error('candidate startup failure');"));
    await assert.rejects(runtime.update(bad,spec,callbacks),/candidate app exited/);
    assert.equal(await(await fetch(url)).text(),'second');
    assert.equal(await readFile(join(home,'runtime/active.json'),'utf8'),active);
    assert.deepEqual(errors,[]);
  }finally{delete process.env.MORKA_HOST_TEST_SECRET;await runtime.stop();}
}));

test('packaged prepared releases import and start without installing or fetching packages',()=>fixture(async home=>{
  const builder=new AppPackages(join(home,'build'));
  const artifact=await builder.prepare(appSource(),{updateLock:true});
  const packaged=join(home,'packaged');
  await cp(dirname(artifact.directory),packaged,{recursive:true,verbatimSymlinks:true});
  const runtime=new ManagedRuntime(home,join(home,'fresh-runtime'),join(home,'user-data'),()=>{});
  try{
    const imported=await runtime.packages.importPrepared(packaged,artifact.source);
    assert.ok(imported);
    const tools=require('../dist/project/toolchain.js');const install=tools.packageProcess;
    tools.packageProcess=async()=>{throw Error('An offline startup must not install anything');};
    try{await runtime.update(artifact.source,readManifest(artifact.source).runtime,{beforeActivate:async()=>{},activate:async()=>{}});}
    finally{tools.packageProcess=install;}
    assert.equal(await(await fetch(runtime.url)).text(),'first');
    assert.equal((await readdir(join(home,'fresh-runtime'))).includes('cache'),false);
  }finally{await runtime.stop();}
}));

test('the same origin is reused after closing and reopening an app',()=>fixture(async home=>{
  let runtime=new ManagedRuntime(home,join(home,'runtime'),join(home,'data'),()=>{});
  const callbacks={beforeActivate:async()=>{},activate:async()=>{}};
  const source=(await runtime.prepare(appSource(),{updateLock:true})).source;
  let url;
  try{
    await runtime.update(source,readManifest(source).runtime,callbacks);url=runtime.url;
    await runtime.stop();
    runtime=new ManagedRuntime(home,join(home,'runtime'),join(home,'data'),()=>{});
    await runtime.update(source,readManifest(source).runtime,callbacks);
    assert.equal(runtime.url,url);
  }finally{await runtime.stop();}
}));

test('cancelled dependency work leaves no half-installed release',()=>fixture(async home=>{
  const source=appSource({'wait.cjs':"setTimeout(()=>{},30000)"},{scripts:{start:'node server.cjs',postinstall:'node wait.cjs'}});
  const manager=new AppPackages(home);const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(Error('cancelled by test')),250);
  try{await assert.rejects(manager.prepare(source,{updateLock:true,signal:controller.signal}),/cancelled/);}
  finally{clearTimeout(timer);}
  assert.deepEqual(await readdir(join(home,'releases')),[]);
}));

test('dependency and build failures return to the agent before source activation, keeping chat and data intact',()=>fixture(async home=>{
  const root=join(home,'app'),directory=join(home,'chats');
  const source=appSource();await put(root,source);
  const manager=new AppPackages(join(home,'runtime'));
  let prompts=0;
  const registry={get:()=>({info:{id:'codex',name:'Codex'},connection:{prompt:async turn=>{
    prompts++;
    if(prompts===1){
      const pkg=JSON.parse(await readFile(join(turn.cwd,'package.json'),'utf8'));pkg.scripts.build='node missing-build.cjs';
      await writeFile(join(turn.cwd,'package.json'),JSON.stringify(pkg));
    }else{
      assert.match(turn.text,/failed dependency installation or its build/);
      await writeFile(join(turn.cwd,'missing-build.cjs'),"require('node:fs').writeFileSync('result.txt','fixed')");
    }
    return 'completed';
  }}})};
  const sessions=await ChatSessions.open(directory,root,registry);
  sessions.setProjectPreparer((files,signal,onLog)=>manager.prepare(files,{signal,updateLock:true,onLog}));
  const chat=await sessions.create();
  try{
    const events=[];
    const result=await sessions.send(chat.id,'Add a build',undefined,event=>events.push(event.message),undefined,{providerId:'codex'});
    assert.equal(prompts,2);assert.ok(result.project);assert.ok(result.project.files.has('package-lock.json'));
    assert.ok(events.some(({ activity })=>activity?.kind==='command' && activity.status==='failed'));
    assert.equal(events.at(-1).activity.title,'npm dependencies and build verified');
    assert.equal((await sessions.select(chat.id)).find(({ activity })=>activity?.kind==='run').activity.title,'npm dependencies and build verified');
    assert.equal((await snapshot(root)).has('missing-build.cjs'),true);
    assert.equal(result.project.files.has('node_modules/app-library/package.json'),false);
  }finally{sessions.close();}
}));

test('a failed preview keeps the working release across restart and never replaces live SQLite data',()=>fixture(async home=>{
  const root=join(home,'app'), runtimeHome=join(home,'runtime'), data=join(home,'data');
  await mkdir(data);
  const dbFile=join(data,'todos.sqlite');
  const database=new DatabaseSync(dbFile);
  database.exec("CREATE TABLE todos (title TEXT); INSERT INTO todos VALUES ('Keep my task');");
  database.close();
  const callbacks={beforeActivate:async()=>{},activate:async()=>{}};
  let runtime=new ManagedRuntime(root,runtimeHome,data,assert.fail);
  try{
    const good=(await runtime.prepare(appSource(),{updateLock:true})).source;
    await put(root,good);
    await runtime.update(good,readManifest(good).runtime,callbacks);
    const url=runtime.url;
    const original=await runtime.recover();
    const bad=new Map(good);
    bad.set('vendor/library/index.cjs',bytes("module.exports='broken UI';"));
    bad.set('migrate.cjs',bytes("require('node:fs').writeFileSync(require('node:path').join(process.env.MORKA_DATA_DIR,'todos.sqlite'),'overwrite');"));
    bad.set('morka.project.json',bytes({version:1,runtime:{type:'node',migration:{id:'preview-failed',script:'migrate',compatibility:'backward-compatible'}}}));
    const pkg=JSON.parse(bad.get('package.json'));
    pkg.scripts.migrate='node migrate.cjs';
    bad.set('package.json',bytes(pkg));
    let restored=false, published=false;
    await assert.rejects(runtime.update(bad,readManifest(bad).runtime,{
      ...callbacks,
      activate:async candidate=>{
        assert.equal(await (await fetch(candidate)).text(),'broken UI');
        assert.equal((await fetch(candidate+'slow-write',{method:'POST'})).status,503);
        throw new Error('preview refused the update');
      },
      rollback:async()=>{
        assert.equal(await (await fetch(url)).text(),'first');
        restored=true;
      },
      publish:async()=>{published=true;return async()=>{};},
    }),/preview refused the update/);
    assert.equal(restored,true);
    assert.equal(published,false);
    assert.equal((await runtime.recover()).key,original.key);
    await runtime.stop();

    // A stale or manually damaged checkout must not be used to reconstruct the
    // working release. The persisted artifact is sufficient to reopen the app.
    await writeFile(join(root,'morka.project.json'),'invalid source');
    runtime=new ManagedRuntime(root,runtimeHome,data,assert.fail);
    const saved=await runtime.recover();
    assert.equal(saved.key,original.key);
    await runtime.update(saved.source,readManifest(saved.source).runtime,callbacks,{prepared:saved});
    assert.equal(runtime.url,url);
    assert.equal(await (await fetch(url)).text(),'first');
    await assert.rejects(readFile(join(data,'user.json')),/ENOENT/);
    const reopened=new DatabaseSync(dbFile,{readOnly:true});
    try { assert.equal(reopened.prepare('SELECT title FROM todos').get().title,'Keep my task'); }
    finally { reopened.close(); }
    assert.equal(await readFile(join(root,'morka.project.json'),'utf8'),'invalid source');
  }finally{await runtime.stop();}
}));

test('a real registry tarball and installation-created assets survive offline import without overwriting app settings',()=>fixture(async home=>{
  const registryRoot=join(home,'registry');
  await put(join(registryRoot,'package'),new Map(Object.entries({
    'package.json':{name:'app-library',version:'1.2.3',main:'index.cjs',scripts:{postinstall:'node install.cjs'}},
    'index.cjs':"module.exports='downloaded npm module';",
    'install.cjs':"const fs=require('node:fs'),path=require('node:path'),root=path.join(process.env.HOME,'.cache');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'asset.txt'),'downloaded asset');fs.writeFileSync(path.join(root,'settings.txt'),'default settings');",
  }).map(([path,value])=>[path,bytes(value)])));
  const packed=spawnSync('/usr/bin/tar',['-czf',join(home,'module.tgz'),'-C',registryRoot,'package'],{encoding:'utf8'});
  assert.equal(packed.status,0,packed.stderr);
  const tarball=await readFile(join(home,'module.tgz'));
  let requests=0,registry;
  registry=createServer((req,res)=>{
    requests++;
    if(req.url==='/app-library'){
      const port=registry.address().port;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({name:'app-library','dist-tags':{latest:'1.2.3'},versions:{'1.2.3':{
        name:'app-library',version:'1.2.3',main:'index.cjs',scripts:{postinstall:'node install.cjs'},
        dist:{tarball:`http://127.0.0.1:${port}/module.tgz`,integrity:'sha512-'+createHash('sha512').update(tarball).digest('base64')},
      }}}));
    }else if(req.url==='/module.tgz'){res.setHeader('content-type','application/octet-stream');res.end(tarball);}
    else{res.writeHead(404);res.end('{}');}
  });
  await new Promise(resolve=>registry.listen(0,'127.0.0.1',resolve));
  let runtime;
  try{
    const source=appSource({'.npmrc':`registry=http://127.0.0.1:${registry.address().port}/\n`,
      'server.cjs':`const fs=require('node:fs'),path=require('node:path');require('node:http').createServer((q,s)=>{if(q.url==='/health')s.end('ok');else if(q.url==='/settings')s.end(fs.readFileSync(path.join(process.env.HOME,'.cache/settings.txt')));else s.end(require('app-library')+'; '+fs.readFileSync(path.join(process.env.HOME,'.cache/asset.txt')));}).listen(Number(process.env.PORT),process.env.HOST);`,
    },{dependencies:{'app-library':'1.2.3'}});
    const artifact=await new AppPackages(join(home,'build')).prepare(source,{updateLock:true});
    assert.ok(requests>=2,'npm must fetch registry metadata and a tarball');
    await new Promise(resolve=>registry.close(resolve));registry=undefined;
    const runtimeHome=join(home,'offline-runtime');
    await mkdir(join(runtimeHome,'process-home/.cache'),{recursive:true});
    await writeFile(join(runtimeHome,'process-home/.cache/settings.txt'),'user settings');
    runtime=new ManagedRuntime(home,runtimeHome,join(home,'data'),()=>{});
    await runtime.packages.importPrepared(dirname(artifact.directory),artifact.source);
    const tools=require('../dist/project/toolchain.js'),install=tools.packageProcess;
    tools.packageProcess=async()=>{throw Error('Offline startup attempted an install');};
    try{await runtime.update(artifact.source,readManifest(artifact.source).runtime,{beforeActivate:async()=>{},activate:async()=>{}});}
    finally{tools.packageProcess=install;}
    assert.equal(await(await fetch(runtime.url)).text(),'downloaded npm module; downloaded asset');
    assert.equal(await(await fetch(runtime.url+'settings')).text(),'user settings');
  }finally{await runtime?.stop();if(registry)await new Promise(resolve=>registry.close(resolve));}
}));

test('private build configuration participates in release caching without being required on the recipient computer',()=>fixture(async home=>{
  const builderHome=join(home,'build'),profile=join(builderHome,'npm');await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'build.env'),'BUILD_VALUE=one');
  const manager=new AppPackages(builderHome);
  const source=appSource({'build.cjs':"require('node:fs').writeFileSync('built.txt',process.env.BUILD_VALUE)"},{scripts:{start:'node server.cjs',build:'node build.cjs'}});
  const first=await manager.prepare(source,{updateLock:true});
  assert.equal(await readFile(join(first.directory,'built.txt'),'utf8'),'one');
  await writeFile(join(profile,'build.env'),'BUILD_VALUE=two');
  const second=await manager.prepare(first.source);
  assert.notEqual(first.key,second.key);assert.equal(await readFile(join(second.directory,'built.txt'),'utf8'),'two');
  const receiver=new AppPackages(join(home,'recipient'));
  const imported=await receiver.importPrepared(dirname(second.directory),second.source);
  assert.equal(await readFile(join(imported.directory,'built.txt'),'utf8'),'two');
  const cached=await receiver.prepare(second.source,{offline:true});
  assert.equal(cached.key,imported.key);
  assert.equal((await readdir(join(home,'recipient'))).includes('cache'),false);
}));

test('compatible migrations have stable IDs, run once and do not restore older user data',()=>fixture(async home=>{
  const runtime=new ManagedRuntime(home,join(home,'runtime'),join(home,'data'),()=>{});
  const callbacks={beforeActivate:async()=>{},activate:async()=>{}};
  try{
    let source=appSource({'migrate.cjs':"const fs=require('node:fs'),path=require('node:path');const p=path.join(process.env.MORKA_DATA_DIR,'migrations.txt');fs.appendFileSync(p,'once\\n');"},
      {scripts:{start:'node server.cjs',migrate:'node migrate.cjs'}});
    source.set('morka.project.json',bytes({version:1,runtime:{type:'node',migration:{id:'add-field-v1',script:'migrate',compatibility:'backward-compatible'}}}));
    source=(await runtime.prepare(source,{updateLock:true})).source;
    const spec=readManifest(source).runtime;
    await runtime.update(source,spec,callbacks);
    const next=new Map(source);next.set('vendor/library/index.cjs',bytes("module.exports='updated';"));
    await runtime.update(next,spec,callbacks);
    assert.equal(await readFile(join(home,'data/migrations.txt'),'utf8'),'once\n');
    assert.equal(await(await fetch(runtime.url)).text(),'updated');
    const bad=new Map(next);bad.set('migrate.cjs',bytes("throw Error('migration failure')"));
    bad.set('morka.project.json',bytes({version:1,runtime:{type:'node',migration:{id:'failed-v2',script:'migrate',compatibility:'backward-compatible'}}}));
    await assert.rejects(runtime.update(bad,readManifest(bad).runtime,callbacks),/migration failed/);
    assert.equal(await(await fetch(runtime.url)).text(),'updated');
    assert.equal(await readFile(join(home,'data/migrations.txt'),'utf8'),'once\n');
  }finally{await runtime.stop();}
}));

test('a shared origin registry reserves distinct ports for apps even while an app is closed',()=>fixture(async home=>{
  const registry=join(home,'origins');await mkdir(join(home,'first'));await mkdir(join(home,'second'));
  const first=new AppProxy(join(home,'first/origin.json'),registry);
  const second=new AppProxy(join(home,'second/origin.json'),registry);
  try{
    const url=await first.start();await first.close();
    const other=await second.start();assert.notEqual(url,other);
    const remembered=await first.start();assert.equal(remembered,url);
    const ports=Object.values(JSON.parse(await readFile(join(registry,'ports.json'),'utf8')));
    assert.equal(ports.length,2);assert.equal(new Set(ports).size,2);
  }finally{await first.close();await second.close();}
}));

test('private installation and build credentials are redacted before logs reach a chat',()=>fixture(async home=>{
  await mkdir(join(home,'npm'),{recursive:true});
  await writeFile(join(home,'npm/npm.env'),'NPM_TOKEN=private-install-token');
  await writeFile(join(home,'npm/build.env'),'BUILD_SECRET=private-build-secret');
  const source=appSource({
    'install.cjs':"process.stdout.write('token='+process.env.NPM_TOKEN);",
    'build.cjs':"process.stdout.write('secret='+process.env.BUILD_SECRET);",
  },{scripts:{start:'node server.cjs',postinstall:'node install.cjs',build:'node build.cjs'}});
  let logs='';
  await new AppPackages(home).prepare(source,{updateLock:true,onLog:text=>{logs+=text}});
  assert.ok(logs.includes('[redacted]'));assert.equal(logs.includes('private-install-token'),false);assert.equal(logs.includes('private-build-secret'),false);
}));

test('CSS served from a mounted public directory updates without restarting its server',()=>fixture(async home=>{
  const runtime=new ManagedRuntime(home,join(home,'runtime'),join(home,'data'),()=>{});
  let before=0;
  const callbacks={beforeActivate:async()=>{before++},activate:async(url,styles)=>{if(styles)await(await fetch(url+'assets/styles.css')).text();}};
  try{
    let source=appSource({'public/styles.css':'h1{color:blue}',
      'server.cjs':"const fs=require('node:fs');require('node:http').createServer((q,s)=>{if(q.url==='/health')s.end('ok');else{s.setHeader('content-type','text/css');s.end(fs.readFileSync('public/styles.css'))}}).listen(Number(process.env.PORT),process.env.HOST);"});
    source.delete('styles.css');
    source=(await runtime.prepare(source,{updateLock:true})).source;
    const spec=readManifest(source).runtime;
    await runtime.update(source,spec,callbacks);
    const initial=JSON.parse(await readFile(join(home,'runtime/active.json'),'utf8')).processDirectory;
    const next=new Map(source);next.set('public/styles.css',bytes('h1{color:orange}'));
    await runtime.update(next,spec,callbacks);
    assert.equal(before,1);
    assert.equal(JSON.parse(await readFile(join(home,'runtime/active.json'),'utf8')).processDirectory,initial);
    assert.equal(await(await fetch(runtime.url+'assets/styles.css')).text(),'h1{color:orange}');
    const third=new Map(next);third.set('public/styles.css',bytes('h1{color:green}'));
    await runtime.update(third,spec,callbacks);
    assert.equal(await(await fetch(runtime.url+'assets/styles.css')).text(),'h1{color:green}');
  }finally{await runtime.stop();}
}));
