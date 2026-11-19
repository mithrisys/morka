const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { synchronizeDraft } = require('../dist/project/drafts.js');
const { snapshot, digest } = require('../dist/project/files.js');
const { ChatSessions } = require('../dist/agents/sessions.js');
const files = values => new Map(Object.entries(values).map(([path,text]) => [path,Buffer.from(text)]));
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(),'morka-draft-sync-'));
  try { await run(directory); } finally { await rm(directory,{recursive:true,force:true}); }
}
async function put(directory, entries) {
  await mkdir(directory,{recursive:true});
  for (const [name,data] of entries) await writeFile(join(directory,name),data);
}

test('matching source and draft reconcile stale metadata without discarding edits',()=>fixture(async workspace=>{
  const current=files({'main.js':'already updated'});
  await put(workspace,current);
  const result=await synchronizeDraft(workspace,current,{base:'old fingerprint'});
  assert.equal(result.base,digest(current));
}));

test('an unchanged draft follows source edits made outside the chat',()=>fixture(async workspace=>{
  const old=files({'main.js':'old'});
  await put(workspace,old);
  const current=files({'main.js':'new'});
  await synchronizeDraft(workspace,current,{base:digest(old)});
  assert.equal(await readFile(join(workspace,'main.js'),'utf8'),'new');
}));

test('unpublished draft edits survive when the live app has not changed',()=>fixture(async workspace=>{
  const current=files({'main.js':'published'});
  const pending=files({'main.js':'unfinished draft'});
  await put(workspace,pending);
  const result=await synchronizeDraft(workspace,current,{base:digest(current)});
  assert.equal(digest(result.draft),digest(pending));
  assert.equal(await readFile(join(workspace,'main.js'),'utf8'),'unfinished draft');
}));

test('source conflicts retain every pending edit and name the conflicting files',()=>fixture(async workspace=>{
  const old=files({'main.js':'base'});
  await put(workspace,files({'main.js':'unsaved draft','todos.sqlite':'private database'}));
  await assert.rejects(synchronizeDraft(workspace,files({'main.js':'external source change'}),
    {base:digest(old)}),/draft is preserved.*main\.js/);
  assert.equal(await readFile(join(workspace,'main.js'),'utf8'),'unsaved draft');
  assert.equal(await readFile(join(workspace,'todos.sqlite'),'utf8'),'private database');
}));

test('an empty new chat gets the current source',()=>fixture(async workspace=>{
  const current=files({'main.js':'current'});
  const result=await synchronizeDraft(workspace,current,{});
  assert.equal(digest(result.draft),digest(current));
}));

test('an invalid app action is repaired before its draft is published', () => fixture(async directory => {
  const root = join(directory, 'app');
  const original = files({
    'morka.project.json': JSON.stringify({version: 1, runtime: {type: 'node'},
      agentActions: {definitions: 'agents.json', skills: 'skills'}}),
    'agents.json': '[]',
  });
  await put(root, original);
  const definition = {id: 'summarize-text', skill: 'summarize-text',
    inputSchema: {type: 'object'}, outputSchema: {type: 'object'}};
  let attempts = 0;
  const registry = {get: () => ({info: {id: 'codex', name: 'Codex'}, connection: {
    async prompt(turn) {
      attempts++;
      if (attempts === 1) {
        const skill = join(turn.cwd, 'skills/summarize-text');
        await mkdir(skill, {recursive: true});
        await writeFile(join(skill, 'SKILL.md'), 'Summarize the supplied text in one sentence.');
        await writeFile(join(turn.cwd, 'agents.json'), JSON.stringify([definition]));
      } else {
        assert.match(turn.text, /Action "summarize-text": Set "session" to "ephemeral"/);
        assert.equal(await readFile(join(root, 'agents.json'), 'utf8'), '[]');
        await writeFile(join(turn.cwd, 'agents.json'), JSON.stringify([
          {...definition, session: 'ephemeral', instructions: 'Summarize the input.'},
        ]));
      }
      return 'completed';
    },
  }})};
  const sessions = await ChatSessions.open(join(directory, 'chats'), root, registry);
  const chat = await sessions.create();
  const result = await sessions.send(chat.id, 'Create a summarizer', undefined, () => {}, undefined, {providerId: 'codex'});
  assert.equal(attempts, 2);
  assert.ok(result.project.actions.has('summarize-text'));
  assert.equal(JSON.parse(await readFile(join(root, 'agents.json'), 'utf8'))[0].session, 'ephemeral');
}));

test('a failed activation leaves the edit in the same draft and a later chat can publish its repair', () => fixture(async directory => {
  const root = join(directory, 'app');
  const chats = join(directory, 'chats');
  await put(root, files({
    'morka.project.json': JSON.stringify({ version: 1, runtime: { type: 'node' } }),
    'index.html': '<h1>Working</h1>',
    'todos.sqlite': 'live records',
  }));
  const registry = { get: () => ({
    info: { id: 'codex', name: 'Codex' },
    connection: { async prompt(turn) {
      if (turn.text === 'Make the edit') await writeFile(join(turn.cwd, 'index.html'), '<h1>Failed preview</h1>');
      else {
        assert.equal(await readFile(join(turn.cwd, 'index.html'), 'utf8'), '<h1>Failed preview</h1>');
        assert.ok(turn.history.some(message => message.activity?.status === 'failed'));
        assert.match(turn.project.activationFailure, /preview broke/);
        await writeFile(join(turn.cwd, 'index.html'), '<h1>Repaired</h1>');
      }
      return 'completed';
    } },
  }) };
  let sessions = await ChatSessions.open(chats, root, registry);
  const chat = await sessions.create();
  sessions.setProjectActivator(async () => { throw new Error('The preview broke'); });
  const send = text => sessions.send(chat.id, text, undefined, () => {}, undefined, { providerId: 'codex' });
  await assert.rejects(send('Make the edit'), /preview broke/);
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), '<h1>Working</h1>');
  const draft = join(chats, 'project-workspaces', chat.id);
  assert.equal(await readFile(join(draft, 'index.html'), 'utf8'), '<h1>Failed preview</h1>');
  await assert.rejects(readFile(join(draft, 'todos.sqlite')), /ENOENT/);
  sessions.close();

  sessions = await ChatSessions.open(chats, root, registry);
  sessions.setProjectActivator(async (project, publish) => {
    assert.equal(project.files.get('index.html').toString(), '<h1>Repaired</h1>');
    await publish();
  });
  await send('Repair the edit');
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), '<h1>Repaired</h1>');
  assert.equal(await readFile(join(root, 'todos.sqlite'), 'utf8'), 'live records');
  sessions.close();
}));

test('a chat resumes after an external edit with its history, native session and user data intact',()=>fixture(async directory=>{
  const root=join(directory,'app');
  const chats=join(directory,'chats');
  const workspace=join(chats,'project-workspaces','existing-chat');
  const original=files({
    'morka.project.json':JSON.stringify({version:1,runtime:{type:'node'}}),
    'index.html':'<h1>Example</h1>','main.js':'const filter = "all";',
  });
  await put(workspace,original);
  const live=new Map(original);
  live.set('main.js',Buffer.from('const filter = "all"; window.morkaLifecycle = {};'));
  live.set('todos.sqlite',Buffer.from('current user records'));
  await put(root,live);
  const originalMessage={id:'previous-message',role:'user',text:'Existing conversation'};
  const index={selected:'existing-chat',chats:[{id:'existing-chat',title:'Source changes',base:digest(original),
    messages:[originalMessage],native:{codex:{id:'original-native-session',cursor:1}}}]};
  await writeFile(join(chats,'chats.json'),JSON.stringify(index));
  let prompts=0;
  const registry={get:()=>({info:{id:'codex',name:'Codex'},connection:{async prompt(turn){
    prompts++;
    assert.equal(turn.sessionId,'original-native-session');
    assert.ok(turn.history.some(message=>message.id==='previous-message'));
    assert.equal(turn.project.paths.includes('todos.sqlite'),false);
    assert.match(await readFile(join(turn.cwd,'main.js'),'utf8'),/morkaLifecycle/);
    return 'completed';
  }}})};
  const sessions=await ChatSessions.open(chats,root,registry);
  await sessions.send('existing-chat','Continue editing',undefined,()=>{},undefined,{providerId:'codex'});
  await sessions.send('existing-chat','Continue again',undefined,()=>{},undefined,{providerId:'codex'});
  assert.equal(prompts,2);
  const saved=JSON.parse(await readFile(join(chats,'chats.json'),'utf8'));
  assert.equal(saved.selected,'existing-chat');
  assert.equal(saved.chats[0].base,digest(await snapshot(root)));
  assert.ok(saved.chats[0].messages.some(message=>message.id==='previous-message'));
  assert.equal(saved.chats[0].native.codex.id,'original-native-session');
  assert.equal(await readFile(join(root,'todos.sqlite'),'utf8'),'current user records');
  sessions.close();
}));
