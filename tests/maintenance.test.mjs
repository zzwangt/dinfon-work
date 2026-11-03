import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/sqlite.mjs';
import {createMaintenanceManager,scheduledBackupTime} from '../server/maintenance.mjs';

async function fixture(t,options={}) {
  const root=await mkdtemp(resolve(tmpdir(),'dinfon-maintenance-'));
  await mkdir(resolve(root,'server'));await mkdir(resolve(root,'public'));
  const config={DB_PATH:resolve(root,'data/dinfon.sqlite')},DB=openDatabase(config.DB_PATH);
  await DB.exec('CREATE TABLE auth_credentials (account_id TEXT PRIMARY KEY,password_hash TEXT);CREATE TABLE files (id TEXT PRIMARY KEY,bytes BLOB);');
  await DB.prepare('INSERT INTO workspace(id,payload,revision) VALUES(?,?,?)').bind('main',JSON.stringify({accounts:[{id:'account-1',userId:'worker'}],state:{projects:[{id:'project-1'}],tasks:[{id:'task-1',status:'doing'}]}}),7).run();
  await DB.prepare('INSERT INTO auth_credentials VALUES(?,?)').bind('account-1','retained-password-hash').run();
  await DB.prepare('INSERT INTO files VALUES(?,?)').bind('file-1',new Uint8Array([0,5,127,255])).run();
  const manager=await createMaintenanceManager({DB,config,root,autoStart:false,...options});
  t.after(async()=>{await manager.close();DB.close();await rm(root,{recursive:true,force:true});});
  const call=async(path,method='GET',body,actor={role:'superadmin'},extra={})=>manager.handle(new Request(`http://localhost/api/maintenance${path}`,{method,headers:{Origin:'http://localhost','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{actor,...extra});
  return {root,config,DB,manager,call};
}

test('automatic backups use Shanghai time and catch up once per day with bounded automatic retention',async t=>{
  let date=new Date('2026-11-03T17:00:00+08:00');
  const f=await fixture(t,{now:()=>date});
  assert.equal(scheduledBackupTime(date).toISOString(),'2026-11-02T18:00:00.000Z');
  await f.call('/settings','POST',{enabled:true,time:'02:00',retention:1});
  await f.manager.tick();let state=await f.manager.status();assert.equal(state.backups.length,1);assert.equal(state.backups[0].reason,'automatic');
  const first=state.backups[0].id;await f.manager.tick();assert.equal((await f.manager.status()).backups.length,1);
  const manual=await f.manager.snapshot('manual');
  date=new Date('2026-11-04T02:01:00+08:00');await f.manager.tick();state=await f.manager.status();
  assert.equal(state.backups.filter(item=>item.reason==='automatic').length,1);assert.ok(state.backups.some(item=>item.id===manual.id));assert.ok(!state.backups.some(item=>item.id===first));
  await assert.rejects(access(resolve(f.manager.backupDirectory,`dinfon-${first}.sqlite`)));
  assert.equal(state.nextBackup,'2026-11-04T18:00:00.000Z');
});

test('full backup restores account identity, credentials, project/task data and binary node files',async t=>{
  const f=await fixture(t),result=await f.call('/backup','POST',{});assert.equal(result.status,200);
  const {backup}=await result.json(),response=await f.call(`/backups/${backup.id}/download`);assert.equal(response.status,200);assert.match(response.headers.get('Content-Disposition'),/^attachment/);
  const restore=resolve(f.root,'restored.sqlite');await writeFile(restore,Buffer.from(await response.arrayBuffer()));
  const db=new DatabaseSync(restore,{readOnly:true});
  try{const row=db.prepare('SELECT * FROM workspace').get();assert.equal(row.revision,7);const data=JSON.parse(row.payload);assert.equal(data.accounts[0].id,'account-1');assert.equal(data.state.tasks[0].status,'doing');assert.equal(db.prepare('SELECT password_hash FROM auth_credentials').get().password_hash,'retained-password-hash');assert.deepEqual([...db.prepare('SELECT bytes FROM files').get().bytes],[0,5,127,255]);}finally{db.close();}
});

test('backup controls and downloads require administrator, same-origin writes and fresh authorization',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('','GET',undefined,{role:'member'})).status,403);
  assert.equal((await f.call('/backup','POST',{}, {role:'member'})).status,403);
  const wrong=await f.manager.handle(new Request('http://localhost/api/maintenance/backup',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json'},body:'{}'}),{actor:{role:'superadmin'}});assert.equal(wrong.status,403);
  let calls=0;const revoked=await f.call('/backup','POST',{}, {role:'superadmin'},{authorize:async()=>({actor:{role:++calls===1?'superadmin':'member'}})});assert.equal(revoked.status,403);assert.equal((await f.manager.status()).backups.length,0);
  assert.equal((await f.call('/settings','POST',{enabled:true,time:'99:12',retention:0})).status,400);
  assert.equal((await f.call('/settings','POST',{enabled:false,time:'01:30',retention:9})).status,200);
  await f.manager.tick();assert.equal((await f.manager.status()).backups.length,0);
  const row=await f.DB.prepare('SELECT payload FROM maintenance_settings WHERE id=1').first();assert.deepEqual(JSON.parse(row.payload),{enabled:false,time:'01:30',retention:9});
});

test('maintenance write operations are serialized and startup applying state keeps business writes closed',async t=>{
  const f=await fixture(t);let release;const gate=new Promise(done=>release=done);let calls=0;
  const pending=f.call('/settings','POST',{enabled:false,time:'02:00',retention:14},{role:'superadmin'},{authorize:async()=>{if(++calls===2)await gate;return {actor:{role:'superadmin'}};}});
  await new Promise(done=>setTimeout(done,10));assert.equal((await f.call('/backup','POST',{})).status,409);release();assert.equal((await pending).status,200);
  await writeFile(resolve(f.manager.stageDirectory,'status.json'),JSON.stringify({status:'applying',staged:{id:'pending'}}));
  const second=await createMaintenanceManager({DB:f.DB,config:f.config,root:f.root,autoStart:false});
  assert.equal(second.isUpgrading,true);assert.equal(second.beginRequest(),false);await second.close();
});
