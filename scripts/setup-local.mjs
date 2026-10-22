import { createInterface } from 'node:readline/promises';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, validatePassword, normalizeLogin } from '../server/auth.mjs';
import { validateConfiguration } from '../server/standalone.mjs';
import { hiddenQuestion } from './terminal-input.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configFile = resolve(root, 'config/runtime.json');
const docker = process.argv.includes('--docker');

try {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('请在本机终端交互运行；密码不通过命令行参数或聊天提供。');
  try { await access(configFile); throw new Error('已有 config/runtime.json，未覆盖配置。账号密码请在平台中修改；管理员恢复请参考 DEPLOYMENT.md。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('鼎峰协同 · 首次配置\n正式使用填写 HTTPS 域名；本机体验填写 http://127.0.0.1:3000。\n管理员密码仅写入加盐哈希；员工初始密码由管理员在平台中设置。\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let site, login, name;
  try {
    site = (await rl.question('访问网址 [http://127.0.0.1:3000]：')).trim() || 'http://127.0.0.1:3000';
    login = (await rl.question('管理员账号（3–64 位字母、数字、._@-）[admin]：')).trim().toLowerCase() || 'admin';
    name = (await rl.question('管理员姓名 [管理员]：')).trim() || '管理员';
  } finally { rl.close(); }
  login = normalizeLogin(login);
  if (name.length > 30) throw new Error('管理员姓名最多 30 字。');
  const origin = new URL(site);
  if (docker && (origin.protocol !== 'https:' || origin.port || ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('Docker 部署请填写正式 HTTPS 域名并使用默认 443 端口；本机体验不需要 --docker。');
  const port = origin.protocol === 'http:' ? Number(origin.port || 80) : 3000;
  const configuration = validateConfiguration({ SITE_ORIGIN: site, PORT: port, HOST: docker ? '0.0.0.0' : '127.0.0.1', DB_PATH: './data/dinfon.sqlite', INITIAL_ADMIN_LOGIN: login, INITIAL_ADMIN_NAME: name, TRUST_PROXY: docker });
  let password = await hiddenQuestion('设置初始密码（12–128 位，不回显）：');
  validatePassword(password);
  let confirmation = await hiddenQuestion('再次输入初始密码：');
  if (password !== confirmation) throw new Error('两次密码不一致，未保存配置。');
  const passwordHash = await hashPassword(password); password = ''; confirmation = '';
  await mkdir(resolve(root, 'config'), { recursive: true, mode: 0o700 });
  await mkdir(resolve(root, 'data'), { recursive: true, mode: 0o700 });
  // Keep paths portable between the setup directory and the Docker image.
  configuration.DB_PATH = './data/dinfon.sqlite';
  configuration.INITIAL_ADMIN_PASSWORD_HASH = passwordHash;
  await writeFile(configFile, JSON.stringify(configuration, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const deploymentEnv = [`SITE_DOMAIN=${origin.host}`, `DINFON_UID=${process.getuid?.() ?? 1000}`, `DINFON_GID=${process.getgid?.() ?? 1000}`].join('\n') + '\n';
  await writeFile(resolve(root, 'config/deploy.env'), deploymentEnv, { mode: 0o600, flag: 'wx' });
  console.log(`\n配置已保存。管理员账号：${login}\n运行 npm start，然后打开 ${configuration.SITE_ORIGIN}\n配置文件含认证哈希，请勿发送给员工或提交到代码仓库。`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
