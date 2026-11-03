import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfiguration, PROJECT_ROOT } from '../server/standalone.mjs';
import { openDatabase } from '../server/sqlite.mjs';
import { createMaintenanceManager } from '../server/maintenance.mjs';

let DB,manager;
try {
  const config=await loadConfiguration();await access(config.DB_PATH);
  DB=openDatabase(config.DB_PATH);
  manager=await createMaintenanceManager({DB,config,root:PROJECT_ROOT,autoStart:false});
  const result=await manager.snapshot('manual');
  console.log(`完整数据库备份：${resolve(manager.backupDirectory,`dinfon-${result.id}.sqlite`)}\n包含账号、项目与节点文件，请按公司敏感数据保管。`);
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await manager?.close();DB?.close();}
