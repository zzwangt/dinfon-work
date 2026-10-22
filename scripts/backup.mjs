import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, chmod, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfiguration, PROJECT_ROOT } from '../server/standalone.mjs';

let database;
try {
  const config = await loadConfiguration();
  await access(config.DB_PATH);
  const directory = resolve(PROJECT_ROOT, 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = resolve(directory, `dinfon-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  database = new DatabaseSync(config.DB_PATH, { readOnly: true });
  await backup(database, destination);
  await chmod(destination, 0o600);
  console.log(`完整数据库备份：${destination}\n包含账号密码哈希与会话，按公司敏感数据保管；不要发给员工。`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { database?.close(); }
