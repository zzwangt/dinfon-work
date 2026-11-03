import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,access,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {unpackUpgrade,stageUpgrade,applyStagedUpgrade,rollbackUpgrade,atomicJSON,readJSON} from '../server/upgrade.mjs';
import {createMaintenanceManager} from '../server/maintenance.mjs';
import {openDatabase} from '../server/sqlite.mjs';
import {runLauncher} from '../server/launcher.mjs';
import {recoverInterruptedUpgrade} from '../server/bootstrap.mjs';

const crc=bytes=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
function zip(entries){let offset=0;const local=[],central=[];for(const [name,value]of entries){const path=Buffer.from(`dinfon-independent-test-release/${name}`),bytes=Buffer.from(value),head=Buffer.alloc(30),dir=Buffer.alloc(46);head.writeUInt32LE(0x04034b50);head.writeUInt16LE(20,4);head.writeUInt16LE(0x800,6);head.writeUInt32LE(crc(bytes),14);head.writeUInt32LE(bytes.length,18);head.writeUInt32LE(bytes.length,22);head.writeUInt16LE(path.length,26);dir.writeUInt32LE(0x02014b50);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(0x800,8);dir.writeUInt32LE(crc(bytes),16);dir.writeUInt32LE(bytes.length,20);dir.writeUInt32LE(bytes.length,24);dir.writeUInt16LE(path.length,28);dir.writeUInt32LE(offset,42);local.push(head,path,bytes);central.push(dir,path);offset+=head.length+path.length+bytes.length;}const centralBytes=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.size,8);end.writeUInt16LE(entries.size,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,centralBytes,end]);}
function release(overrides={}){
  const entries=new Map(Object.entries({'package.json':JSON.stringify({name:'dinfon-independent',type:'module'}),'RELEASE.json':JSON.stringify({app:'dinfon-work',format:1,buildId:'release-2026-11-03',createdAt:'2026-11-03T09:00:00Z',minimumNode:24}),'server/standalone.mjs':'export const version="new";','server/launcher.mjs':'export const version="new";','server/bootstrap.mjs':'export const version="new";','server/maintenance.mjs':'export {};','server/upgrade.mjs':'export {};','server/auth.mjs':'export {};','server/service.mjs':'export {};','public/client/index.html':'<title>updated</title>','public/client/app.js':'export const version="new";','README.md':'new docs','.gitignore':'new ignores',...overrides}));
  entries.set('SHA256SUMS',[...entries].map(([name,bytes])=>`${createHash('sha256').update(bytes).digest('hex')}  ${name}`).join('\n')+'\n');return zip(entries);
}
async function directory(t){const root=await mkdtemp(resolve(tmpdir(),'dinfon-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const waitFor=async(fn)=>{for(let i=0;i<250;i++){if(await fn())return;await new Promise(done=>setTimeout(done,20));}throw new Error('Timed out waiting for upgrade');};

test('upgrade archives require platform manifest, valid hashes, safe paths and compatible source syntax',async t=>{
  const root=await directory(t);assert.equal(unpackUpgrade(release()).release.buildId,'release-2026-11-03');
  for(const name of ['../data/dinfon.sqlite','data/dinfon.sqlite','config/runtime.json','server/../data.sqlite'])assert.throws(()=>unpackUpgrade(release({[name]:'secret replacement'})),/路径|目录/);
  assert.throws(()=>unpackUpgrade(release({'RELEASE.json':'{}'})),/不适用/);
  const corrupt=release();corrupt[60]^=1;assert.throws(()=>unpackUpgrade(corrupt),/校验|不一致/);
  await assert.rejects(stageUpgrade(release({'public/client/app.js':'const = invalid'}),root),/程序检查未通过/);
});

test('staging and applying preserve runtime data/config and the stable recovery entry; rollback restores original code',async t=>{
  const root=await directory(t);await mkdir(resolve(root,'server'));await mkdir(resolve(root,'public/client'),{recursive:true});await mkdir(resolve(root,'config'));await mkdir(resolve(root,'data'));await mkdir(resolve(root,'.qa'));
  for(const [name,contents]of Object.entries({'server/bootstrap.mjs':'stable bootstrap','public/client/app.js':'old app','config/runtime.json':'kept configuration','data/dinfon.sqlite':'kept database','.qa/test.sqlite':'kept preview','.gitignore':'kept ignores'}))await writeFile(resolve(root,name),contents);
  const stageDirectory=resolve(root,'backups/.upgrades'),stage=await stageUpgrade(release(),stageDirectory);
  assert.equal(await readFile(resolve(root,'public/client/app.js'),'utf8'),'old app');
  await applyStagedUpgrade({root,stageDirectory,stageId:stage.id});
  assert.equal(await readFile(resolve(root,'public/client/app.js'),'utf8'),'export const version="new";');
  assert.equal(await readFile(resolve(root,'server/bootstrap.mjs'),'utf8'),'stable bootstrap');
  for(const [name,contents]of Object.entries({'config/runtime.json':'kept configuration','data/dinfon.sqlite':'kept database','.qa/test.sqlite':'kept preview','.gitignore':'kept ignores'}))assert.equal(await readFile(resolve(root,name),'utf8'),contents);
  await rollbackUpgrade({root,stageDirectory,stageId:stage.id});assert.equal(await readFile(resolve(root,'public/client/app.js'),'utf8'),'old app');await assert.rejects(access(resolve(root,'README.md')));
});

test('administrator prepares then applies with fresh authorization, a full backup and restart status rather than premature success',async t=>{
  const root=await directory(t);await mkdir(resolve(root,'server'));await mkdir(resolve(root,'public'));const config={DB_PATH:resolve(root,'data/dinfon.sqlite')},DB=openDatabase(config.DB_PATH);let job;
  await DB.prepare('INSERT INTO workspace VALUES(?,?,?)').bind('main','{"accounts":[{"id":"original-account"}],"projects":["p1"]}',8).run();
  const manager=await createMaintenanceManager({DB,config,root,autoStart:false,requestRestart:async value=>{job=value;}});t.after(async()=>{await manager.close();DB.close();});
  const prepare=async(extra={})=>{const form=new FormData();form.append('archive',new Blob([release()]),'release.zip');return manager.handle(new Request('http://localhost/api/maintenance/upgrade/prepare',{method:'POST',headers:{Origin:'http://localhost'},body:form}),{actor:{role:'admin'},...extra});};
  let authorizations=0;const denied=await prepare({authorize:async()=>({actor:{role:++authorizations<3?'admin':'member'}})});assert.equal(denied.status,403);assert.equal((await manager.status()).upgrade.staged,null);
  const prepared=await prepare();assert.equal(prepared.status,200);const {stage}=await prepared.json();assert.equal((await manager.status()).upgrade.status,'staged');
  assert.equal(manager.beginRequest(),true);
  const applying=manager.handle(new Request('http://localhost/api/maintenance/upgrade/apply',{method:'POST',headers:{Origin:'http://localhost','Content-Type':'application/json'},body:JSON.stringify({stageId:stage.id})}),{actor:{role:'admin'}});
  await waitFor(()=>manager.isUpgrading);assert.equal(manager.beginRequest(),false);manager.endRequest();const response=await applying;assert.equal(response.status,202);assert.equal((await manager.status()).upgrade.status,'applying');
  await waitFor(()=>job);assert.equal(job.stageId,stage.id);const copy=new DatabaseSync(job.backupPath,{readOnly:true});try{const row=copy.prepare('SELECT * FROM workspace').get();assert.equal(row.revision,8);assert.match(row.payload,/original-account/);}finally{copy.close();}
});

const alive=`process.send?.({type:'dinfon:ready'});process.on('message',message=>{if(message.type==='test-upgrade')process.send({type:'dinfon:upgrade',job:message.job});});`;
async function interruptedFixture(t){const root=await directory(t);await mkdir(resolve(root,'server'));await mkdir(resolve(root,'config'));await writeFile(resolve(root,'server/standalone.mjs'),alive);await writeFile(resolve(root,'config/runtime.json'),JSON.stringify({DB_PATH:'data/dinfon.sqlite'}));const config={DB_PATH:resolve(root,'data/dinfon.sqlite')},DB=openDatabase(config.DB_PATH);await DB.prepare('INSERT INTO workspace VALUES(?,?,?)').bind('main','original-account-and-project',9).run();const backupDirectory=resolve(root,'backups'),stageDirectory=resolve(backupDirectory,'.upgrades');await mkdir(stageDirectory,{recursive:true});const backupPath=resolve(backupDirectory,`dinfon-${randomUUID()}.sqlite`);await backup(DB.sqlite,backupPath);DB.close();return {root,config,stageDirectory,backupPath,statusPath:resolve(stageDirectory,'status.json')};}

test('launcher rejects a new entry that throws during import and restores previous code and database',async t=>{
  const f=await interruptedFixture(t),stage=await stageUpgrade(release({'server/standalone.mjs':`throw new Error('intentional isolated startup failure');`}),f.stageDirectory),job={root:f.root,stageDirectory:f.stageDirectory,stageId:stage.id,dbPath:f.config.DB_PATH,backupPath:f.backupPath,statusPath:f.statusPath};
  await atomicJSON(f.statusPath,{status:'applying',staged:stage});const launcher=await runLauncher({root:f.root,config:f.config});t.after(()=>launcher.close());
  launcher.child.send({type:'test-upgrade',job});await waitFor(async()=>((await readJSON(f.statusPath))?.lastResult?.stageId===stage.id&&!launcher.updating));
  const status=await readJSON(f.statusPath);assert.equal(status.status,'failed');assert.equal(status.lastResult.rolledBack,true);assert.equal(await readFile(resolve(f.root,'server/standalone.mjs'),'utf8'),alive);const db=new DatabaseSync(f.config.DB_PATH,{readOnly:true});try{assert.equal(db.prepare('SELECT revision FROM workspace').get().revision,9);}finally{db.close();}
});

test('stable bootstrap recovers an interrupted import failure before application modules are loaded',async t=>{
  const f=await interruptedFixture(t),stage=await stageUpgrade(release({'server/standalone.mjs':`import './missing-import.mjs';`}),f.stageDirectory),job={root:f.root,stageDirectory:f.stageDirectory,stageId:stage.id,dbPath:f.config.DB_PATH,backupPath:f.backupPath,statusPath:f.statusPath};
  await applyStagedUpgrade(job);await atomicJSON(resolve(f.stageDirectory,'active-job.json'),job);await atomicJSON(f.statusPath,{status:'applying',staged:stage});
  assert.equal(await recoverInterruptedUpgrade(f.root),true);assert.equal(await readFile(resolve(f.root,'server/standalone.mjs'),'utf8'),alive);assert.equal((await readJSON(f.statusPath)).lastResult.stageId,stage.id);
});

test('a committed upgrade with a leftover job never rolls back newly accepted project writes',async t=>{
  const f=await interruptedFixture(t),stage=await stageUpgrade(release(),f.stageDirectory),job={root:f.root,stageDirectory:f.stageDirectory,stageId:stage.id,dbPath:f.config.DB_PATH,backupPath:f.backupPath,statusPath:f.statusPath};
  await applyStagedUpgrade(job);await atomicJSON(resolve(f.stageDirectory,'active-job.json'),job);await atomicJSON(f.statusPath,{status:'succeeded',appliedStageId:stage.id,lastResult:{stageId:stage.id}});
  const live=new DatabaseSync(f.config.DB_PATH);live.prepare('UPDATE workspace SET payload=?,revision=10').run('newly-accepted-project-data');live.close();assert.equal(await recoverInterruptedUpgrade(f.root),false);
  const restored=new DatabaseSync(f.config.DB_PATH,{readOnly:true});try{assert.equal(restored.prepare('SELECT payload FROM workspace').get().payload,'newly-accepted-project-data');}finally{restored.close();}
  await assert.rejects(access(resolve(f.stageDirectory,'active-job.json')));assert.match(await readFile(resolve(f.root,'public/client/app.js'),'utf8'),/new/);
});
