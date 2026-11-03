// Stable recovery entry. Normal upgrades preserve this file; recovery only uses
// Node built-ins, so a broken new application cannot prevent rollback.
import {readFile,writeFile,copyFile,rm,mkdir,rename,lstat} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const readJSON=async(path,fallback=null)=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
const allowedRoots=new Set(['package.json','.dockerignore','Dockerfile','README.md','DEPLOYMENT.md','PRODUCT.md','DESIGN.md','启动平台.command','RELEASE.json']);
function codePath(root,name){if(typeof name!=='string'||/[\\\x00-\x1f:]/.test(name)||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'))throw new Error('升级恢复路径无效');const parts=name.split('/');if(!(parts.length===1?allowedRoots.has(name):['public','server','scripts','tests','drizzle','deploy'].includes(parts[0]))||name==='server/bootstrap.mjs')throw new Error('升级恢复包含受保护路径');return resolve(root,name);}
async function withoutLinks(root,name){let target=root;for(const part of name.split('/')){target=resolve(target,part);try{if((await lstat(target)).isSymbolicLink())throw new Error('升级恢复路径含符号链接');}catch(error){if(error.code!=='ENOENT')throw error;}}}
export async function recoverInterruptedUpgrade(root=ROOT){
  const configFile=resolve(process.env.DINFON_CONFIG||resolve(root,'config/runtime.json')),saved=await readJSON(configFile,{}),dbPath=resolve(root,process.env.DB_PATH||saved.DB_PATH||'data/dinfon.sqlite'),backupDirectory=resolve(root,process.env.BACKUP_DIR||saved.BACKUP_DIR||'backups'),stageDirectory=resolve(backupDirectory,'.upgrades'),jobPath=resolve(stageDirectory,'active-job.json'),statusPath=resolve(stageDirectory,'status.json');
  const job=await readJSON(jobPath);if(!job)return false;
  if(job.root!==root||job.stageDirectory!==stageDirectory||job.statusPath!==statusPath||job.dbPath!==dbPath||!/^[-0-9a-f]{36}$/.test(job.stageId)||dirname(job.backupPath)!==backupDirectory||!/^dinfon-[-0-9a-f]{36}\.sqlite$/.test(basename(job.backupPath)))throw new Error('升级恢复记录不匹配，请联系服务器管理员');
  if(Number.isInteger(job.launcherPid)&&job.launcherPid!==process.pid){try{process.kill(job.launcherPid,0);throw new Error('另一个平台进程正在升级，请等待其完成');}catch(error){if(error.code!=='ESRCH')throw error;}}
  const status=await readJSON(statusPath,{});
  if(status.status==='succeeded'&&status.appliedStageId===job.stageId){await rm(jobPath,{force:true});return false;}
  const stagePath=resolve(stageDirectory,job.stageId),originals=await readJSON(resolve(stagePath,'rollback.json'),[]);
  for(const entry of originals){const destination=codePath(root,entry.name);await withoutLinks(root,entry.name);if(entry.exists){await mkdir(dirname(destination),{recursive:true});await copyFile(resolve(stagePath,'rollback',entry.name),destination);}else await rm(destination,{force:true});}
  await rm(`${dbPath}-wal`,{force:true});await rm(`${dbPath}-shm`,{force:true});await copyFile(job.backupPath,dbPath);
  const next={...status,status:'failed',lastError:'上次升级被中断，已恢复升级前版本和数据',staged:null,lastResult:{stageId:job.stageId,completedAt:new Date().toISOString(),rolledBack:true}};
  const temp=`${statusPath}.recovery.tmp`;await writeFile(temp,JSON.stringify(next)+'\n',{mode:0o600});await rename(temp,statusPath);await rm(jobPath,{force:true});return true;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await recoverInterruptedUpgrade();const {runLauncher}=await import(pathToFileURL(resolve(ROOT,'server/launcher.mjs')));await runLauncher();}catch(error){console.error(error.message);process.exitCode=1;}
}
