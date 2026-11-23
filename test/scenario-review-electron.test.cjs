const assert = require('node:assert/strict');
const {app} = require('electron');
const {mkdir,writeFile,readFile,access} = require('node:fs/promises');
const {join} = require('node:path');
const {reviewScenario} = require('../dist/electron/scenario-review.js');
async function main() {
  app.on('window-all-closed',()=>{});
  app.setPath('userData',join(process.env.MORKA_PREVIEW_TEST_DIR,'scenario-profile'));
  await app.whenReady();
  const dir=join(process.env.MORKA_PREVIEW_TEST_DIR,'scenario');
  await mkdir(dir);
  await writeFile(join(dir,'index.html'), `<script src="/__morka/bridge.js"></script>
    <label>Note<input id="note"></label><button onclick="save()">Extract</button><p id="result"></p>
    <script>async function save(){
      const response=await fetch('/api/settings').then(r=>r.json());
      result.textContent=note.value+' '+(await window.morka.runAgentAction('extract',{})).task+' '+response.owner;
    }</script>`);
  const scenario={steps:[{kind:'fill',selector:'#note',value:'Review'},{kind:'click',selector:'button'},
    {kind:'expect',selector:'#result',text:'Review contract Ana'}],actions:{extract:{task:'contract'}},
    responses:{'GET /api/settings':{owner:'Ana'}}};
  let paths;
  await reviewScenario(dir,scenario,new AbortController().signal,async images=>{
    assert.equal(images.length,4);
    paths=images.map(image=>image.path);
    for(const path of paths) assert.equal((await readFile(path)).subarray(1,4).toString(),'PNG');
  });
  for (const path of paths) await assert.rejects(access(path),/ENOENT/);
  await assert.rejects(reviewScenario(dir,{steps:[{kind:'expect',selector:'.missing'}]},new AbortController().signal),/step 1/);
  console.log('PASS: both viewports, synthetic API and AI, image delivery, actionable failure and cleanup');
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
