import { backup } from 'node:sqlite';
import { mkdir, stat, readFile, rm, chmod, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_UPGRADE_BYTES, atomicJSON, readJSON, stageUpgrade } from './upgrade.mjs';

export { MAX_UPGRADE_BYTES };
const defaults={enabled:true,time:'02:00',retention:14};
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store, private','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const originCheck=request=>{if(request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('Sec-Fetch-Site')==='cross-site')fail(403,'ORIGIN_REJECTED','请求来源无效，请从平台页面重试');};
const validId=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/.test(value);
async function inputJSON(request){originCheck(request);if(!request.headers.get('Content-Type')?.startsWith('application/json'))fail(415,'JSON_REQUIRED','请求必须使用 JSON 格式');const raw=await request.text();if(Buffer.byteLength(raw)>65536)fail(413,'BODY_TOO_LARGE','提交内容过长');let value;try{value=JSON.parse(raw);}catch{fail(400,'INVALID_JSON','提交内容格式不正确');}if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'INVALID_INPUT','提交内容格式不正确');return value;}
export function scheduledBackupTime(now,time='02:00') {
  const local=new Date(now.getTime()+8*3600000),day=local.toISOString().slice(0,10);
  return new Date(`${day}T${time}:00+08:00`);
}
export async function createMaintenanceManager({DB,config,root,requestRestart,now=()=>new Date(),autoStart=true}) {
  const backupDirectory=resolve(config.BACKUP_DIR||resolve(root,'backups')),stageDirectory=resolve(backupDirectory,'.upgrades'),statusPath=resolve(stageDirectory,'status.json');
  const disk=config.DB_PATH!==':memory:'&&Boolean(DB.sqlite),restart=requestRestart||(process.env.DINFON_LAUNCHER==='1'&&process.send?async job=>new Promise((done,reject)=>process.send({type:'dinfon:upgrade',job},error=>error?reject(error):done())):null);
  let settings={...defaults},backupBusy=false,upgrading=false,requests=0,timer,closed=false,backupError=null,operationBusy=false;
  let upgradeState={status:'idle',lastError:null,staged:null},version='开发版';
  for(const sql of [
    'CREATE TABLE IF NOT EXISTS maintenance_settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS maintenance_backups (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, size INTEGER NOT NULL, reason TEXT NOT NULL)',
  ])await DB.prepare(sql).run();
  const saved=await DB.prepare('SELECT payload FROM maintenance_settings WHERE id = 1').first();
  if(saved){const data=JSON.parse(saved.payload);settings=validateSettings(data);}else await DB.prepare('INSERT INTO maintenance_settings (id,payload) VALUES (1,?)').bind(JSON.stringify(settings)).run();
  if(disk){await mkdir(backupDirectory,{recursive:true,mode:0o700});await mkdir(stageDirectory,{recursive:true,mode:0o700});upgradeState={...upgradeState,...await readJSON(statusPath,{})};}
  try{const release=JSON.parse(await readFile(resolve(root,'RELEASE.json'),'utf8'));version=release.buildId||release.version||version;}catch{}
  upgrading=upgradeState.status==='applying';
  const activate=async message=>{if(message?.type!=='dinfon:activate')return;const current=await readJSON(statusPath,{});if(current.status==='succeeded'&&current.appliedStageId===message.stageId){upgradeState=current;upgrading=false;}};
  if(process.env.DINFON_LAUNCHER==='1')process.on('message',activate);
  let writable=false;try{await access(resolve(root,'server'),constants.W_OK);await access(resolve(root,'public'),constants.W_OK);writable=true;}catch{}
  const supported=disk&&Boolean(restart)&&writable;
  function validateSettings(value){if(typeof value.enabled!=='boolean'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)||!Number.isInteger(value.retention)||value.retention<1||value.retention>90)fail(400,'INVALID_SETTINGS','请设置有效时间及 1–90 份自动备份保留数量');return {enabled:value.enabled,time:value.time,retention:value.retention};}
  const backupPath=id=>resolve(backupDirectory,`dinfon-${id}.sqlite`);
  async function backupList(){const result=await DB.prepare('SELECT id,created_at AS createdAt,size,reason FROM maintenance_backups ORDER BY created_at DESC').all();const list=[];for(const item of result.results||[]){try{if((await stat(backupPath(item.id))).isFile())list.push(item);}catch{}}return list;}
  async function persistUpgrade(value){upgradeState={...upgradeState,...value};if(disk)await atomicJSON(statusPath,upgradeState);}
  async function snapshot(reason='manual'){
    if(!disk)fail(503,'BACKUP_UNAVAILABLE','当前运行方式不支持持久备份');
    if(backupBusy)fail(409,'BACKUP_BUSY','已有备份正在进行');
    backupBusy=true;const id=randomUUID(),path=backupPath(id),createdAt=now().toISOString();
    try{await backup(DB.sqlite,path);await chmod(path,0o600);const size=(await stat(path)).size;await DB.prepare('INSERT INTO maintenance_backups (id,created_at,size,reason) VALUES (?,?,?,?)').bind(id,createdAt,size,reason).run();backupError=null;const list=await backupList(),old=list.filter(item=>item.reason==='automatic').slice(settings.retention);for(const item of old){await rm(backupPath(item.id),{force:true});await DB.prepare('DELETE FROM maintenance_backups WHERE id=?').bind(item.id).run();}return {id,createdAt,size,reason};}
    catch(error){backupError='备份失败，请检查服务器磁盘空间和目录权限';await rm(path,{force:true}).catch(()=>{});throw error;}
    finally{backupBusy=false;}
  }
  async function tick(){if(closed||upgrading||backupBusy||!disk||!settings.enabled)return;const due=scheduledBackupTime(now(),settings.time);if(now()<due)return;const list=await backupList(),last=list.find(item=>item.reason==='automatic');if(!last||Date.parse(last.createdAt)<due.getTime())await snapshot('automatic');}
  async function status(){if(disk)upgradeState={...upgradeState,...await readJSON(statusPath,{})};const backups=await backupList();let nextBackup=null;if(settings.enabled&&disk){let due=scheduledBackupTime(now(),settings.time);if(due<=now())due=new Date(due.getTime()+86400000);nextBackup=due.toISOString();}return {settings,lastBackup:backups[0]||null,backups,nextBackup,backupError,backupBusy,upgrade:{supported,currentVersion:version,...upgradeState,status:upgrading&&upgradeState.status==='succeeded'?'applying':upgradeState.status}};}
  async function waitIdle(){const end=Date.now()+30000;while(requests>0){if(Date.now()>end)fail(409,'REQUESTS_BUSY','仍有操作正在保存，请稍后升级');await new Promise(done=>setTimeout(done,25));}}
  async function handle(request,{actor,authorize}){
    let ownsOperation=false;
    const authorizeAdmin=async()=>{const current=authorize?await authorize():{actor};if(current.actor?.role!=='admin')fail(403,'ADMIN_REQUIRED','仅管理员可以管理备份与升级');};
    try{
      await authorizeAdmin();
      const path=new URL(request.url).pathname,method=request.method;
      if(path==='/api/maintenance'&&method==='GET')return json(await status());
      const download=/^\/api\/maintenance\/backups\/([0-9a-f-]{36})\/download$/.exec(path);
      if(download&&method==='GET'){const item=(await backupList()).find(item=>item.id===download[1]);if(!item)fail(404,'NOT_FOUND','备份不存在');return new Response(await readFile(backupPath(item.id)),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="dinfon-backup-${item.createdAt.replace(/[:.]/g,'-')}.sqlite"`,'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'}});}
      if(method!=='POST')fail(404,'NOT_FOUND','未找到此操作');
      if(upgrading||operationBusy)fail(409,'UPGRADE_BUSY','已有备份或升级操作正在进行，请稍后');
      operationBusy=true;ownsOperation=true;
      if(path==='/api/maintenance/settings'){const nextSettings=validateSettings(await inputJSON(request));await authorizeAdmin();settings=nextSettings;await DB.prepare('UPDATE maintenance_settings SET payload=? WHERE id=1').bind(JSON.stringify(settings)).run();return json(await status());}
      if(path==='/api/maintenance/backup'){await inputJSON(request);await authorizeAdmin();return json({backup:await snapshot('manual')});}
      if(path==='/api/maintenance/upgrade/prepare'){
        originCheck(request);if(!supported)fail(503,'UPGRADE_UNAVAILABLE','请使用启动器启动平台，并确保程序目录可写');
        if(!request.headers.get('Content-Type')?.startsWith('multipart/form-data'))fail(415,'FORM_REQUIRED','请选择 ZIP 升级包');
        if(Number(request.headers.get('Content-Length')||0)>MAX_UPGRADE_BYTES+65536)fail(413,'BODY_TOO_LARGE','升级包不能超过 50 MB');
        const form=await request.formData(),archive=form.get('archive');if(!archive||typeof archive.arrayBuffer!=='function'||archive.size>MAX_UPGRADE_BYTES)fail(400,'INVALID_ARCHIVE','请选择不超过 50 MB 的 ZIP 升级包');
        await authorizeAdmin();const stage=await stageUpgrade(await archive.arrayBuffer(),stageDirectory);try{await authorizeAdmin();}catch(error){await rm(resolve(stageDirectory,stage.id),{recursive:true,force:true});throw error;}await persistUpgrade({status:'staged',lastError:null,staged:stage});return json({stage});
      }
      if(path==='/api/maintenance/upgrade/apply'){
        const payload=await inputJSON(request);await authorizeAdmin();if(!supported)fail(503,'UPGRADE_UNAVAILABLE','当前启动方式不支持自动重启');
        if(!validId(payload.stageId)||upgradeState.staged?.id!==payload.stageId)fail(409,'STAGE_INVALID','升级包已过期，请重新上传');
        upgrading=true;
        try{await waitIdle();await authorizeAdmin();const saved=await snapshot('upgrade');await authorizeAdmin();await persistUpgrade({status:'applying',lastError:null,backupId:saved.id,startedAt:now().toISOString()});
          const job={root,stageDirectory,stageId:payload.stageId,dbPath:config.DB_PATH,backupPath:backupPath(saved.id),statusPath};
          setTimeout(()=>Promise.resolve(restart(job)).catch(async()=>{upgrading=false;await persistUpgrade({status:'failed',lastError:'无法重启服务，升级尚未应用'});}),300).unref?.();
          return json({ok:true,restarting:true,backup:saved},202);
        }catch(error){upgrading=false;await persistUpgrade({status:'failed',lastError:error.message});throw error;}
      }
      fail(404,'NOT_FOUND','未找到此操作');
    }catch(error){return json({error:error.status?error.message:'操作失败，请检查服务器状态',code:error.code||'MAINTENANCE_ERROR'},error.status||500);}
    finally{if(ownsOperation)operationBusy=false;}
  }
  if(autoStart&&disk){timer=setInterval(()=>tick().catch(()=>{}),60000);timer.unref();queueMicrotask(()=>tick().catch(()=>{}));}
  return {handle,status,snapshot,tick,get isUpgrading(){return upgrading;},beginRequest(){if(upgrading)return false;requests++;return true;},endRequest(){requests=Math.max(0,requests-1);},async close(){closed=true;clearInterval(timer);process.off('message',activate);while(backupBusy)await new Promise(done=>setTimeout(done,10));},backupDirectory,stageDirectory};
}
