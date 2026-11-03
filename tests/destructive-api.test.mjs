import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/sqlite.mjs';
import { initializeAuthSchema, hashPassword, issueSession } from '../server/auth.mjs';
import { initializeFileSchema } from '../server/files.mjs';
import { initializeLocalWorkspace, handleHttpApi } from '../server/service.mjs';
const ORIGIN='https://deletion.example';
const HASH=await hashPassword('Isolated deletion permissions only');
async function fixture(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const env={DB:db,SITE_ORIGIN:ORIGIN,INITIAL_ADMIN_LOGIN:'owner',INITIAL_ADMIN_PASSWORD_HASH:HASH,SEED_DEMO_DATA:true};
  await initializeAuthSchema(db);await initializeLocalWorkspace(env);await initializeFileSchema(db);
  const stored=()=>JSON.parse(db.sqlite.prepare('SELECT payload FROM workspace').get().payload);
  const workspace=stored();workspace.state.users.find(u=>u.id==='u-engineer').role='admin';
  for(const id of ['u-engineer','u-manager']){workspace.accounts.push({id:'account-'+id,userId:id,login:id,status:'active'});db.sqlite.prepare('INSERT INTO auth_credentials VALUES(?,?,?,0,1,?)').run('account-'+id,id,HASH,new Date().toISOString());}
  db.sqlite.prepare('UPDATE workspace SET payload=?').run(JSON.stringify(workspace));
  const cookies={};for(const id of ['u-admin','u-engineer','u-manager']){const account=workspace.accounts.find(a=>a.userId===id),credential=db.sqlite.prepare('SELECT * FROM auth_credentials WHERE account_id=?').get(account.id);cookies[id]=(await issueSession(db,env,credential)).split(';')[0];}
  const call=async(path,data,actor='u-admin',method=data?'POST':'GET')=>{const response=await handleHttpApi(new Request(ORIGIN+path,{method,headers:{Cookie:cookies[actor],Origin:ORIGIN,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})}),env);return {status:response.status,data:await response.json()};};
  const command=(action,id,actor='u-admin',extra={})=>call('/api/command',{revision:db.sqlite.prepare('SELECT revision FROM workspace').get().revision,action,payload:{id,confirm:true},...extra},actor);
  const addFile=(id,projectId,type,entityId)=>db.sqlite.prepare('INSERT INTO project_files VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,type,entityId,id+'.txt',3,'text/plain','u-manager',new Date().toISOString(),'demo-hash',new Uint8Array([1,2,3]));
  addFile('child','p-mower','task','t-02');addFile('node','p-mower','milestone','m-mower-2');addFile('sibling','p-mower','milestone','m-mower-3');addFile('elsewhere','p-pcb','milestone','m-pcb-2');
  return {db,env,stored,call,command,addFile};
}

test('an ordinary administrator can delete a task and only its files; project owners cannot',async t=>{
  const f=await fixture(t),before=f.stored();
  assert.equal((await f.command('deleteTask','t-02','u-manager')).status,403);
  assert.deepEqual(f.stored(),before);
  const removed=await f.command('deleteTask','t-02','u-engineer');assert.equal(removed.status,200,JSON.stringify(removed.data));
  assert.ok(!f.stored().state.tasks.some(task=>task.id==='t-02'));
  assert.deepEqual(f.db.sqlite.prepare('SELECT id FROM project_files ORDER BY id').all().map(r=>r.id),['elsewhere','node','sibling']);
  assert.equal((await f.call('/api/files/child/download')).status,404);
});

test('milestone deletion atomically removes its tasks and their files, preserving sibling and other project files',async t=>{
  const f=await fixture(t),before=f.stored(),children=before.state.tasks.filter(task=>task.milestoneId==='m-mower-2').map(task=>task.id);
  assert.equal((await f.command('deleteMilestone','m-mower-2','u-manager')).status,403);
  const removed=await f.command('deleteMilestone','m-mower-2','u-engineer');assert.equal(removed.status,200,JSON.stringify(removed.data));
  assert.ok(!f.stored().state.milestones.some(node=>node.id==='m-mower-2'));
  assert.ok(f.stored().state.tasks.every(task=>!children.includes(task.id)));
  assert.deepEqual(f.db.sqlite.prepare('SELECT id FROM project_files ORDER BY id').all().map(r=>r.id),['elsewhere','sibling']);
});

test('only the super administrator deletes entire projects; accounts and unrelated projects survive',async t=>{
  const f=await fixture(t),before=f.stored();
  for(const actor of ['u-engineer','u-manager'])assert.equal((await f.command('deleteProject','p-mower',actor)).status,403);
  assert.deepEqual(f.stored(),before);
  const removed=await f.command('deleteProject','p-mower');assert.equal(removed.status,200,JSON.stringify(removed.data));
  const after=f.stored();assert.deepEqual(after.accounts,before.accounts);assert.deepEqual(after.state.users,before.state.users);
  for(const name of ['projects','tasks','milestones','extensions','milestoneRequests'])assert.ok(after.state[name].every(item=>item.id!=='p-mower'&&item.projectId!=='p-mower'));
  assert.deepEqual(f.db.sqlite.prepare('SELECT id FROM project_files').all().map(r=>r.id),['elsewhere']);
});

test('deletion requires explicit confirmation and a current revision, including a CAS race',async t=>{
  const f=await fixture(t),before=f.stored(),files=f.db.sqlite.prepare('SELECT * FROM project_files ORDER BY id').all();
  assert.equal((await f.command('deleteTask','t-02','u-admin',{payload:{id:'t-02'}})).status,400);
  assert.equal((await f.command('deleteMilestone','m-mower-2','u-admin',{revision:0})).status,400);
  const batch=f.db.batch.bind(f.db);f.db.batch=async statements=>{f.db.batch=batch;f.db.sqlite.prepare('UPDATE workspace SET revision=revision+1').run();return batch(statements);};
  assert.equal((await f.command('deleteProject','p-mower')).status,409);
  assert.deepEqual(f.stored(),before);assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM project_files ORDER BY id').all(),files);
});

test('a file deletion error rolls the business deletion back with its audit and notifications',async t=>{
  const f=await fixture(t),before=f.stored();
  f.db.sqlite.exec("CREATE TRIGGER prevent_demo_delete BEFORE DELETE ON project_files BEGIN SELECT RAISE(ABORT,'isolated failure'); END;");
  assert.equal((await f.command('deleteProject','p-mower')).status,500);
  assert.deepEqual(f.stored(),before);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM project_files').get().n,4);
});
