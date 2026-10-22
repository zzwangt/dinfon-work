import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { openDatabase } from './sqlite.mjs';
import { initializeAuthSchema } from './auth.mjs';
import { handleHttpApi, initializeLocalWorkspace } from './service.mjs';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_ROOT = resolve(PROJECT_ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
};
export function validateConfiguration(input) {
  const config = { HOST: '127.0.0.1', PORT: 3000, DB_PATH: './data/dinfon.sqlite', ...input };
  let origin;
  try { origin = new URL(config.SITE_ORIGIN); } catch { throw new Error('请先运行 npm run setup，配置平台访问网址。'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('SITE_ORIGIN 只能包含协议、域名和端口。');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (!(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))) throw new Error('正式访问网址必须使用 HTTPS；本机 localhost 可使用 HTTP。');
  config.SITE_ORIGIN = origin.origin;
  config.PORT = Number(config.PORT);
  if (!Number.isInteger(config.PORT) || config.PORT < 0 || config.PORT > 65535) throw new Error('PORT 配置无效。');
  config.TRUST_PROXY = config.TRUST_PROXY === true || config.TRUST_PROXY === 'true';
  config.DB_PATH = config.DB_PATH === ':memory:' ? ':memory:' : resolve(PROJECT_ROOT, config.DB_PATH);
  return config;
}
export async function loadConfiguration() {
  const filename = resolve(process.env.DINFON_CONFIG || resolve(PROJECT_ROOT, 'config/runtime.json'));
  let fromFile = {};
  try { fromFile = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取运行配置，请检查 config/runtime.json。'); }
  const overrides = Object.fromEntries(['SITE_ORIGIN', 'HOST', 'PORT', 'DB_PATH', 'INITIAL_ADMIN_LOGIN', 'INITIAL_ADMIN_PASSWORD_HASH', 'INITIAL_ADMIN_NAME', 'TRUST_PROXY', 'SEED_DEMO_DATA'].filter(key => process.env[key] != null).map(key => [key, process.env[key]]));
  return validateConfiguration({ ...fromFile, ...overrides });
}
export async function createAppServer(input) {
  const config = validateConfiguration(input);
  const DB = openDatabase(config.DB_PATH);
  const env = { ...config, DB };
  try {
    await initializeAuthSchema(DB);
    const initialization = await initializeLocalWorkspace(env);
    if (initialization.requiresMigration) throw new Error('检测到旧版数据库。请按 DEPLOYMENT.md 显式迁移管理员账号，现有数据未修改。');
  }
  catch (error) { DB.close(); throw error; }
  const publicPath = await realpath(PUBLIC_ROOT);
  const server = createServer(async (incoming, outgoing) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) outgoing.setHeader(name, value);
    if (config.SITE_ORIGIN.startsWith('https:')) outgoing.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const finish = (status, message) => { outgoing.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); outgoing.end(message); };
    try {
      const method = incoming.method || 'GET';
      // Never derive trusted origin or identity from Host/forwarded headers.
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) return finish(400, 'Invalid request');
      const url = new URL(incoming.url, config.SITE_ORIGIN);
      if (url.origin !== config.SITE_ORIGIN) return finish(400, 'Invalid request');
      if (url.pathname === '/healthz' && method === 'GET') return finish(200, 'ok');
      const expectedHost = new URL(config.SITE_ORIGIN).host;
      if (incoming.headers.host?.toLowerCase() !== expectedHost.toLowerCase()) return finish(421, '请使用已配置的平台网址访问');
      if (url.pathname.startsWith('/api/')) {
        const chunks = []; let bytes = 0;
        for await (const chunk of incoming) { bytes += chunk.length; if (bytes > 65536) return finish(413, '提交内容过长'); chunks.push(chunk); }
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value != null && !/^(?:oai-|cf-|x-forwarded-|x-real-ip|forwarded)/i.test(name)) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        let clientIp = incoming.socket.remoteAddress || 'unknown';
        const proxyIp = incoming.headers['x-real-ip'];
        if (config.TRUST_PROXY && typeof proxyIp === 'string' && isIP(proxyIp)) clientIp = proxyIp;
        const request = new Request(url, { method, headers, ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }) });
        const response = await handleHttpApi(request, { ...env, CLIENT_IP: clientIp });
        for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
        outgoing.statusCode = response.status;
        outgoing.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (!['GET', 'HEAD'].includes(method)) { outgoing.setHeader('Allow', 'GET, HEAD'); return finish(405, 'Method not allowed'); }
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return finish(400, 'Invalid path'); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(segment => segment.startsWith('.'))) return finish(404, 'Not found');
      const candidate = pathname === '/' ? resolve(publicPath, 'client/index.html') : resolve(publicPath, `.${pathname}`);
      if (!candidate.startsWith(publicPath + sep)) return finish(404, 'Not found');
      let filename;
      try { filename = await realpath(candidate); if (!filename.startsWith(publicPath + sep) || !(await stat(filename)).isFile()) return finish(404, 'Not found'); }
      catch { return finish(404, 'Not found'); }
      const contents = await readFile(filename);
      outgoing.setHeader('Content-Type', MIME[extname(filename)] || 'application/octet-stream');
      outgoing.setHeader('Cache-Control', extname(filename) === '.html' ? 'no-store' : 'no-cache');
      if (pathname === '/sw.js') outgoing.setHeader('Service-Worker-Allowed', '/');
      outgoing.setHeader('Content-Length', contents.length);
      outgoing.statusCode = 200;
      outgoing.end(method === 'HEAD' ? undefined : contents);
    } catch { if (!outgoing.headersSent) finish(500, '服务暂时不可用'); else outgoing.end(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on('close', () => DB.close());
  return { server, config, DB };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { server, config } = await createAppServer(await loadConfiguration());
    server.on('error', () => { console.error('无法启动服务，请检查端口是否被占用。'); process.exitCode = 1; });
    server.listen(config.PORT, config.HOST, () => console.log(`鼎峰协同已启动：${config.SITE_ORIGIN}`));
    const stop = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
