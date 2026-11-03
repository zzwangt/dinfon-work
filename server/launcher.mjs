import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, basename } from 'node:path';
import { copyFile, rm, access } from 'node:fs/promises';
import { loadConfiguration } from './standalone.mjs';
import { applyStagedUpgrade, rollbackUpgrade, atomicJSON, readJSON } from './upgrade.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function runLauncher({root=ROOT,config}={}) {
  config ||= await loadConfiguration();
  const stageDirectory=resolve(config.BACKUP_DIR||resolve(root,'backups'),'.upgrades'),statusPath=resolve(stageDirectory,'status.json'),jobPath=resolve(stageDirectory,'active-job.json');
  let child=null,stopping=false,updating=false;
  const pause=ms=>new Promise(done=>setTimeout(done,ms));
  async function stopChild(){if(!child||child.exitCode!==null)return;const current=child;current.kill('SIGTERM');await new Promise(done=>{const timer=setTimeout(()=>{if(current.exitCode===null)current.kill('SIGKILL');},30000);current.once('exit',()=>{clearTimeout(timer);done();});});}
  const saveResult=async(value)=>atomicJSON(statusPath,{...await readJSON(statusPath,{}),...value});
  async function restoreDatabase(job){await access(job.backupPath);await rm(`${job.dbPath}-wal`,{force:true});await rm(`${job.dbPath}-shm`,{force:true});await copyFile(job.backupPath,job.dbPath);}
  function validJob(job){return job&&job.root===root&&job.stageDirectory===stageDirectory&&job.statusPath===statusPath&&job.dbPath===config.DB_PATH&&/^[0-9a-f-]{36}$/.test(job.stageId)&&dirname(job.backupPath)===resolve(config.BACKUP_DIR||resolve(root,'backups'))&&/^dinfon-[0-9a-f-]{36}\.sqlite$/.test(basename(job.backupPath));}
  async function startChild(){
    const current=fork(resolve(root,'server/standalone.mjs'),[],{cwd:root,env:{...process.env,DINFON_LAUNCHER:'1'},stdio:['inherit','inherit','inherit','ipc']});child=current;
    current.on('message',message=>{if(message?.type==='dinfon:upgrade'&&!updating&&!stopping&&validJob(message.job))upgrade(message.job).catch(error=>{console.error('升级恢复失败，请检查服务器备份。');stopping=true;stopChild().finally(()=>process.exitCode=1);});});
    return new Promise((done,reject)=>{
      let ready=false;const timer=setTimeout(()=>reject(new Error('新版服务启动超时')),30000);
      current.on('message',message=>{if(message?.type==='dinfon:ready'&&!ready){ready=true;clearTimeout(timer);done(current);}});
      current.once('error',error=>{clearTimeout(timer);reject(error);});
      current.once('exit',code=>{clearTimeout(timer);if(!ready)reject(new Error('服务未能正常启动'));else if(!updating&&!stopping){stopping=true;process.exitCode=code||1;}});
    });
  }
  async function upgrade(job){
    updating=true;let committed=false;
    await atomicJSON(jobPath,{...job,launcherPid:process.pid});await pause(350);await stopChild();
    try{
      const result=await applyStagedUpgrade(job);if(stopping)throw new Error('升级已中断');await startChild();if(stopping)throw new Error('升级已中断');
      await saveResult({status:'succeeded',appliedStageId:job.stageId,lastError:null,staged:null,lastResult:{stageId:job.stageId,buildId:result.stage.buildId,completedAt:new Date().toISOString(),rolledBack:false}});
      committed=true;
      // This durable commit is irreversible: after activation users may have
      // saved new data. Activation/cleanup failure must never restore the DB.
      try{await new Promise((done,reject)=>child.send({type:'dinfon:activate',stageId:job.stageId},error=>error?reject(error):done()));}
      catch{await stopChild();if(!stopping)await startChild();}
      await rm(jobPath,{force:true}).catch(()=>{});
    }catch(error){
      if(committed)throw error;
      await stopChild();await rollbackUpgrade(job);await restoreDatabase(job);
      await saveResult({status:'failed',lastError:'新版启动失败，已恢复原程序和升级前数据',staged:null,lastResult:{stageId:job.stageId,completedAt:new Date().toISOString(),rolledBack:true}});await rm(jobPath,{force:true});if(!stopping)await startChild();
    }finally{updating=false;}
  }

  const unfinished=await readJSON(jobPath);
  if(unfinished&&validJob(unfinished)&&(await readJSON(statusPath))?.status==='succeeded'&&(await readJSON(statusPath))?.appliedStageId===unfinished.stageId){await rm(jobPath,{force:true});}
  else if(unfinished&&validJob(unfinished)){
    await rollbackUpgrade(unfinished);await restoreDatabase(unfinished);await saveResult({status:'failed',lastError:'上次升级被中断，已恢复升级前版本和数据',staged:null,lastResult:{stageId:unfinished.stageId,completedAt:new Date().toISOString(),rolledBack:true}});await rm(jobPath,{force:true});
  }else if((await readJSON(statusPath))?.status==='applying')await saveResult({status:'failed',lastError:'上次升级未完成，程序尚未更新，请重新上传升级包',staged:null});
  const stop=()=>{if(stopping)return;stopping=true;stopChild().catch(()=>{});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{await startChild();}catch(error){await stopChild();process.off('SIGTERM',stop);process.off('SIGINT',stop);throw error;}
  return {get child(){return child;},get updating(){return updating;},close:async()=>{stopping=true;await stopChild();process.off('SIGTERM',stop);process.off('SIGINT',stop);}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await runLauncher();}catch(error){console.error(error.message);process.exitCode=1;}
}
