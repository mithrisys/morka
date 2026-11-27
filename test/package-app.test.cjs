const assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,readFile,copyFile,cp,rm,realpath}=require('node:fs/promises');
const {join,dirname,resolve}=require('node:path');
const {tmpdir}=require('node:os');
const {randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {createRequire}=require('node:module');
const {AppPackages,writableTree}=require('../dist/project/packages.js');
const {buildMacBundle}=require('../dist/instances/distribution.js');
const {readDesktopRuntime,registerDesktopRuntime}=require('../dist/instances/desktop-runtimes.js');
const {snapshot}=require('../dist/project/files.js');

(async()=>{
  const root=resolve(__dirname,'..');
  const temporary=await mkdtemp(join(tmpdir(),'morka-packaged-npm-'));
  let runtime;
  try{
    const source=new Map(Object.entries({
      'morka.project.json':JSON.stringify({version:1,runtime:{type:'node'}}),
      'package.json':JSON.stringify({name:'packaged-native-app',version:'1.0.0',private:true,scripts:{start:'node server.cjs'},dependencies:{'native-answer':'file:vendor/native-answer'}}),
      'vendor/native-answer/package.json':JSON.stringify({name:'native-answer',version:'1.0.0',main:'index.cjs',scripts:{install:'node install.cjs'}}),
      'vendor/native-answer/index.cjs':"module.exports=require('./addon.node').answer;",
      'vendor/native-answer/addon.c':'#include <node_api.h>\nstatic napi_value init(napi_env env,napi_value exports){napi_value n;napi_create_int32(env,42,&n);napi_set_named_property(env,exports,"answer",n);return exports;}\nNAPI_MODULE(NODE_GYP_MODULE_NAME,init)\n',
      'vendor/native-answer/install.cjs':"require('node:child_process').execFileSync(process.env.CC||'/usr/bin/clang',['-bundle','-undefined','dynamic_lookup','-DNODE_GYP_MODULE_NAME=native_answer','-I'+process.env.npm_package_config_node_gyp_nodedir+'/include/node','addon.c','-o','addon.node'],{stdio:'inherit'});",
      'server.cjs':"const answer=require('native-answer');require('node:http').createServer((q,s)=>s.end(q.url==='/health'?'ready':JSON.stringify({answer,node:process.execPath}))).listen(Number(process.env.PORT),process.env.HOST);",
    }).map(([path,value])=>[path,Buffer.from(value)]));
    const packagesHome=join(temporary,'build-runtime');
    const artifact=await new AppPackages(packagesHome).prepare(source,{updateLock:true});
    const repository=join(temporary,'repository');
    await mkdir(join(repository,'.morka/icons'),{recursive:true});
    for(const [path,data] of artifact.source){await mkdir(dirname(join(repository,'app',path)),{recursive:true});await writeFile(join(repository,'app',path),data);}
    await copyFile(join(root,'dist/branding/Morka.icns'),join(repository,'.morka/icons/AppIcon.icns'));
    const kit=join(root,'dist/npm');
    const host=join(temporary,'Morka.app');
    await buildMacBundle(root,host,kit);
    const desktop=await readDesktopRuntime(join(host,'Contents/Resources'));
    const library=join(temporary,'Library','Application Support','Morka Apps');
    await registerDesktopRuntime(library,desktop);
    const spec={version:1,id:randomUUID(),name:'Morka npm packaging test',iconColor:0,runtimeVersion:desktop.version};
    await writeFile(join(repository,'package.json'),JSON.stringify({
      version:'1.0.0',scripts:{'package:mac':'node .morka/npm/package-mac.cjs'},
    }));
    await writeFile(join(repository,'.morka/release.json'),JSON.stringify(spec));
    await cp(kit,join(repository,'.morka/npm'),{recursive:true});
    const {npmEntry}=require('../dist/project/toolchain.js');
    const npm=await npmEntry(process.execPath,process.env.npm_execpath);
    const command=spawnSync(process.execPath,[npm,'run','package:mac'],{
      cwd:repository,encoding:'utf8',env:{...process.env,HOME:temporary},timeout:90_000,
    });
    assert.equal(command.status,0,command.error?.message ?? command.stderr);
    const bundle=join(repository,'dist',`${spec.name}.app`);
    const resources=join(bundle,'Contents/Resources');
    const toolkit=join(resources,'app/dist/toolchain');
    const executable=join(toolkit,'bin/node');
    assert.equal(await readFile(join(toolkit,'toolchain.json'),'utf8'),
      await readFile(join(desktop.appDirectory,'dist/toolchain/toolchain.json'),'utf8'));
    await assert.rejects(readFile(join(resources,'morka-runtime.json')),{code:'ENOENT'});
    await rm(host,{recursive:true,force:true});
    const packagedApp=join(resources,'morka-app-release/app');
    const native=spawnSync(executable,['-e',"console.log(require('native-answer'))"],{cwd:packagedApp,encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
    assert.equal(native.status,0,native.stderr);assert.equal(native.stdout.trim(),'42');
    const verify=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{encoding:'utf8'});
    assert.equal(verify.status,0,verify.stderr);
    const packagedRequire=createRequire(join(resources,'app/package.json'));
    const {readProjectCheckout}=packagedRequire('./dist/instances/project-import.js');
    assert.deepEqual((await readProjectCheckout(repository)).spec,spec);
    const {ManagedRuntime}=packagedRequire('./dist/project/managed-runtime.js');
    const {readManifest}=packagedRequire('./dist/project/project.js');
    const tools=packagedRequire('./dist/project/toolchain.js');
    const packagedSource=await snapshot(join(resources,'morka-project'));
    runtime=new ManagedRuntime(join(resources,'morka-project'),join(temporary,'recipient/runtime'),join(temporary,'recipient/data'),error=>{throw Error(error)},toolkit);
    await runtime.packages.importPrepared(join(resources,'morka-app-release'),packagedSource);
    const install=tools.packageProcess;
    tools.packageProcess=async()=>{throw Error('Packaged startup attempted a dependency installation');};
    try{await runtime.update(packagedSource,readManifest(packagedSource).runtime,{beforeActivate:async()=>{},activate:async()=>{}});}
    finally{tools.packageProcess=install;}
    const response=await(await fetch(runtime.url)).json();
    assert.equal(response.answer,42);assert.equal(response.node,await realpath(executable));
    assert.ok(await readFile(join(toolkit,'NODE-LICENSE')));
    console.log('PASS: signed .app includes Node/npm, source, production packages and native addon; its packaged runtime starts offline without installing dependencies or using system Node.');
  }finally{
    await runtime?.stop();
    await writableTree(temporary);
    await rm(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
