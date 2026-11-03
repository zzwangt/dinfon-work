import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { readFile, writeFile, mkdir, readdir, lstat, copyFile, rm, rename, access, chmod, stat } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

export const MAX_UPGRADE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 150 * 1024 * 1024;
const ROOT_FILES = new Set(['package.json','.gitignore','.dockerignore','Dockerfile','README.md','DEPLOYMENT.md','PRODUCT.md','DESIGN.md','启动平台.command','RELEASE.json']);
const CODE_DIRS = new Set(['public','server','scripts','tests','drizzle','deploy']);
const required = ['package.json','RELEASE.json','server/standalone.mjs','server/launcher.mjs','server/bootstrap.mjs','server/maintenance.mjs','server/upgrade.mjs','server/auth.mjs','server/service.mjs','public/client/index.html','public/client/app.js'];
const digest = value => createHash('sha256').update(value).digest('hex');
const bad = message => { throw Object.assign(new Error(message), { status:400,code:'INVALID_UPGRADE' }); };
const decode = bytes => { try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { bad('升级包文件名编码无效'); } };
function safeRelative(path) {
  if (!path || path.length > 240 || /[\\\x00-\x1f\x7f:]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part==='.' || part==='..')) bad('升级包包含不安全路径');
  const parts=path.split('/');
  if (!(parts.length===1 ? ROOT_FILES.has(path) || path==='SHA256SUMS' : CODE_DIRS.has(parts[0]))) bad('升级包包含程序目录之外的文件');
  if (parts.some(part=>part.startsWith('.') && !['.gitignore','.dockerignore'].includes(part))) bad('升级包包含隐藏文件');
  return path;
}
function crc32(bytes) { let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0; }
export function unpackUpgrade(input) {
  const data=Buffer.from(input); if(data.length>MAX_UPGRADE_BYTES || data.length<22)bad('升级包大小无效（最多 50 MB）');
  let end=-1;for(let n=data.length-22;n>=Math.max(0,data.length-65557);n--){if(data.readUInt32LE(n)===0x06054b50 && n+22+data.readUInt16LE(n+20)===data.length){end=n;break;}}
  if(end<0)bad('请选择完整的 ZIP 升级包');
  const count=data.readUInt16LE(end+10),dirSize=data.readUInt32LE(end+12),dirOffset=data.readUInt32LE(end+16);
  if(data.readUInt16LE(end+4)||data.readUInt16LE(end+6)||data.readUInt16LE(end+8)!==count||count===0xffff||count>1500||dirOffset+dirSize!==end)bad('不支持此 ZIP 格式');
  const entries=new Map(),seen=new Set();let offset=dirOffset,total=0,prefix;
  for(let index=0;index<count;index++) {
    if(offset+46>end || data.readUInt32LE(offset)!==0x02014b50)bad('升级包目录损坏');
    const flags=data.readUInt16LE(offset+8),method=data.readUInt16LE(offset+10),crc=data.readUInt32LE(offset+16),compressed=data.readUInt32LE(offset+20),size=data.readUInt32LE(offset+24),nameLength=data.readUInt16LE(offset+28),extraLength=data.readUInt16LE(offset+30),commentLength=data.readUInt16LE(offset+32),attrs=data.readUInt32LE(offset+38),local=data.readUInt32LE(offset+42);
    if(offset+46+nameLength+extraLength+commentLength>end || flags&1 || ![0,8].includes(method) || compressed===0xffffffff || size===0xffffffff || local===0xffffffff || ((attrs>>>16)&0xf000)===0xa000)bad('升级包包含不支持的文件');
    const rawName=decode(data.subarray(offset+46,offset+46+nameLength));offset+=46+nameLength+extraLength+commentLength;
    const directory=rawName.endsWith('/'),cleanName=directory?rawName.slice(0,-1):rawName;
    if(/[\\\x00-\x1f\x7f:]/.test(cleanName)||cleanName.startsWith('/')||cleanName.split('/').some(part=>!part||part==='.'||part==='..'))bad('升级包包含不安全路径');
    const slash=cleanName.indexOf('/'),top=slash<0?cleanName:cleanName.slice(0,slash);
    prefix ??= top;if(top!==prefix || !/^dinfon-independent-[A-Za-z0-9._-]+$/.test(top))bad('请选择本平台生成的独立部署包');
    if(directory)continue;
    if(slash<0)bad('升级包缺少根目录');
    const path=safeRelative(cleanName.slice(slash+1)),collision=path.toLowerCase();
    if(seen.has(collision))bad('升级包包含重复文件');seen.add(collision);
    total+=size;if(size>MAX_UPGRADE_BYTES||total>MAX_EXPANDED_BYTES)bad('升级包解压后过大');
    if(local+30>dirOffset||data.readUInt32LE(local)!==0x04034b50||data.readUInt16LE(local+6)!==flags||data.readUInt16LE(local+8)!==method)bad('升级包文件头损坏');
    const localNameLength=data.readUInt16LE(local+26),localExtraLength=data.readUInt16LE(local+28),start=local+30+localNameLength+localExtraLength;
    if(start+compressed>dirOffset || decode(data.subarray(local+30,local+30+localNameLength))!==rawName)bad('升级包文件路径不一致');
    let bytes;try{bytes=method===0?Buffer.from(data.subarray(start,start+compressed)):inflateRawSync(data.subarray(start,start+compressed),{maxOutputLength:Math.max(1,size)});}catch{bad('升级包文件无法解压');}
    if(bytes.length!==size||crc32(bytes)!==crc)bad('升级包文件校验失败');entries.set(path,bytes);
  }
  if(offset!==end)bad('升级包目录不完整');
  const checksum=entries.get('SHA256SUMS');if(!checksum)bad('升级包缺少完整性校验清单');
  const hashes=new Map();for(const line of decode(checksum).trim().split('\n')){const match=/^([0-9a-f]{64})  (.+)$/.exec(line);if(!match)bad('升级包校验清单无效');safeRelative(match[2]);if(hashes.has(match[2]))bad('升级包校验清单重复');hashes.set(match[2],match[1]);}
  if(hashes.size!==entries.size-1)bad('升级包文件清单不一致');
  for(const [path,bytes]of entries)if(path!=='SHA256SUMS'&&hashes.get(path)!==digest(bytes))bad('升级包内容被修改或不完整');
  for(const path of required)if(!entries.has(path))bad(`升级包缺少必要文件：${path}`);
  let release,pkg;try{release=JSON.parse(decode(entries.get('RELEASE.json')));pkg=JSON.parse(decode(entries.get('package.json')));}catch{bad('升级包版本信息无效');}
  if(release.app!=='dinfon-work'||release.format!==1||typeof release.buildId!=='string'||!/^[A-Za-z0-9._-]{6,100}$/.test(release.buildId)||!Number.isFinite(Date.parse(release.createdAt))||release.minimumNode>Number(process.versions.node.split('.')[0])||pkg.name!=='dinfon-independent'||pkg.type!=='module')bad('升级包不适用于当前平台或 Node 版本');
  return {entries,release,size:data.length,expandedSize:total};
}
export async function atomicJSON(path,value) { await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(temp,path); }
export async function readJSON(path,fallback=null) {try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}}
export async function stageUpgrade(input,directory) {
  const parsed=unpackUpgrade(input),id=randomUUID(),path=resolve(directory,id),source=resolve(path,'source');await mkdir(source,{recursive:true,mode:0o700});
  try {
    for(const [name,bytes]of parsed.entries){const destination=resolve(source,name);await mkdir(dirname(destination),{recursive:true,mode:0o700});await writeFile(destination,bytes,{mode:0o600});}
    for(const [name]of parsed.entries)if(name.endsWith('.mjs')||name==='public/client/app.js'||name==='public/client/domain.js') {const check=spawnSync(process.execPath,['--check',resolve(source,name)],{encoding:'utf8',timeout:15000});if(check.status!==0)bad(`升级包程序检查未通过：${name}`);}
    const stage={id,version:parsed.release.buildId,buildId:parsed.release.buildId,createdAt:parsed.release.createdAt,files:parsed.entries.size-1,size:parsed.size,preparedAt:new Date().toISOString()};
    await atomicJSON(resolve(path,'stage.json'),stage);return stage;
  }catch(error){await rm(path,{recursive:true,force:true});throw error;}
}
async function ensureNoLink(root,name) {
  const parts=name.split('/');let path=root;
  for(const part of parts){path=resolve(path,part);try{if((await lstat(path)).isSymbolicLink())bad('程序目录包含符号链接，不能自动升级');}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export async function applyStagedUpgrade({root,stageDirectory,stageId}) {
  if(!/^[0-9a-f-]{36}$/.test(stageId))bad('升级任务无效');
  const stagePath=resolve(stageDirectory,stageId),source=resolve(stagePath,'source'),stage=await readJSON(resolve(stagePath,'stage.json'));
  if(!stage || stage.id!==stageId)bad('升级包已失效，请重新上传');
  const manifest=(await readFile(resolve(source,'SHA256SUMS'),'utf8')).trim().split('\n'),files=[];
  for(const line of manifest){const match=/^([0-9a-f]{64})  (.+)$/.exec(line);if(!match)bad('升级包清单损坏');const name=safeRelative(match[2]),bytes=await readFile(resolve(source,name));if(digest(bytes)!==match[1])bad('已暂存的升级包被修改');await ensureNoLink(root,name);if(!['.gitignore','server/bootstrap.mjs'].includes(name))files.push(name);}
  const rollback=resolve(stagePath,'rollback');await mkdir(rollback,{recursive:true,mode:0o700});const originals=[];
  for(const name of files){const from=resolve(root,name);let exists=true;try{await access(from);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}originals.push({name,exists});if(exists){const dest=resolve(rollback,name);await mkdir(dirname(dest),{recursive:true});await copyFile(from,dest);}}
  await atomicJSON(resolve(stagePath,'rollback.json'),originals);
  try {for(const name of files){const dest=resolve(root,name);await mkdir(dirname(dest),{recursive:true});const temp=`${dest}.${randomUUID()}.upgrade`;await copyFile(resolve(source,name),temp);let mode=name==='启动平台.command'?0o700:0o600;try{mode=(await stat(dest)).mode&0o777;}catch{}await chmod(temp,mode);await rename(temp,dest);}return {stage,stagePath,files};}
  catch(error){await rollbackUpgrade({root,stageDirectory,stageId});throw error;}
}
export async function rollbackUpgrade({root,stageDirectory,stageId}) {
  const stagePath=resolve(stageDirectory,stageId),originals=await readJSON(resolve(stagePath,'rollback.json'),[]);
  for(const entry of originals){safeRelative(entry.name);const dest=resolve(root,entry.name);await ensureNoLink(root,entry.name);if(entry.exists){await mkdir(dirname(dest),{recursive:true});await copyFile(resolve(stagePath,'rollback',entry.name),dest);}else await rm(dest,{force:true});}
}
