import { createInterface } from 'node:readline/promises';
import { loadConfiguration } from '../server/standalone.mjs';
import { openDatabase } from '../server/sqlite.mjs';
import { initializeAuthSchema, hashPassword, normalizeLogin } from '../server/auth.mjs';
import { provisionInitialCredential, recoverLocalAdmin } from '../server/service.mjs';
import { hiddenQuestion } from './terminal-input.mjs';

let DB;
try {
  const mode = process.argv[2];
  if (!['migrate', 'recover'].includes(mode)) throw new Error('用法：node scripts/manage-admin.mjs migrate 或 recover。仅服务器操作员在终端运行。');
  if (!process.stdin.isTTY) throw new Error('请在服务器终端交互执行。');
  const env = await loadConfiguration();
  DB = openDatabase(env.DB_PATH); env.DB = DB;
  await initializeAuthSchema(DB);
  const row = await DB.prepare('SELECT payload FROM workspace WHERE id = ?').bind('main').first();
  if (!row) throw new Error('没有现有平台数据；首次使用请运行 npm run setup。');
  const workspace = JSON.parse(row.payload);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let accountId, login;
  try {
    if (mode === 'migrate') {
      const admins = workspace.accounts.filter(a => a.status === 'active' && workspace.state.users.find(u => u.id === a.userId)?.role === 'admin');
      console.log('现有有效管理员（请选择要迁移的一位；不会改动项目、任务或审批记录）：');
      for (const account of admins) console.log(`${account.id}  ${workspace.state.users.find(u => u.id === account.userId)?.name || '管理员'}`);
      accountId = (await rl.question('选择管理员账号 ID：')).trim();
      if (!admins.some(a => a.id === accountId)) throw new Error('管理员账号 ID 无效。');
    }
    login = normalizeLogin(await rl.question(mode === 'migrate' ? '新的独立登录账号：' : '需要恢复的管理员登录账号：'));
  } finally { rl.close(); }
  let password = await hiddenQuestion('设置新密码（12–128 位，不回显）：');
  let confirmation = await hiddenQuestion('再次输入新密码：');
  if (password !== confirmation) throw new Error('两次密码不一致，未修改账号。');
  if (mode === 'migrate') await provisionInitialCredential({ ...env, INITIAL_ADMIN_LOGIN: login, INITIAL_ADMIN_PASSWORD_HASH: await hashPassword(password) }, { accountId });
  else await recoverLocalAdmin(env, { login, password });
  password = ''; confirmation = '';
  console.log(mode === 'migrate' ? '管理员已迁移，原有业务记录保留。其余旧账号请按部署文档逐一处理。' : '管理员密码已重置，旧登录已失效；首次登录后须再次修改密码。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { DB?.close(); }
