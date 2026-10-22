import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createAppServer, validateConfiguration } from '../server/standalone.mjs';
import { openDatabase } from '../server/sqlite.mjs';
import { hashPassword } from '../server/auth.mjs';

const ORIGIN = 'http://127.0.0.1:3000';
const PASSWORD = 'test-only-runtime-admin-pass';
let passwordHash;
async function fixture(t) {
  passwordHash ||= await hashPassword(PASSWORD);
  const folder = await mkdtemp(join(tmpdir(), 'dinfon-runtime-'));
  const config = { SITE_ORIGIN: ORIGIN, DB_PATH: join(folder, 'state.sqlite'), PORT: 0, INITIAL_ADMIN_LOGIN: 'admin', INITIAL_ADMIN_PASSWORD_HASH: passwordHash };
  const app = await createAppServer(config);
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await rm(folder, { recursive: true, force: true }); });
  const fetchApp = (path, options = {}) => new Promise((resolveResponse, reject) => {
    const req = httpRequest(url, { path, method: options.method || 'GET', headers: { Host: new URL(ORIGIN).host, ...options.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) for (const entry of Array.isArray(value) ? value : [value]) if (entry != null) headers.append(key, entry);
        resolveResponse(new Response(Buffer.concat(chunks), { status: res.statusCode, headers }));
      });
    });
    req.on('error', reject); if (options.body) req.write(options.body); req.end();
  });
  return { ...app, url, fetchApp };
}
test('standalone accepts only configured secure deployment origins', () => {
  for (const SITE_ORIGIN of ['http://company.example', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?next=evil', 'file:///tmp']) assert.throws(() => validateConfiguration({ SITE_ORIGIN }));
  assert.equal(validateConfiguration({ SITE_ORIGIN: 'https://work.example.com/' }).SITE_ORIGIN, 'https://work.example.com');
  assert.equal(validateConfiguration({ SITE_ORIGIN: ORIGIN }).TRUST_PROXY, false);
});
test('SQLite batches roll back earlier writes after a later constraint failure', async () => {
  const db = openDatabase(':memory:');
  try {
    await assert.rejects(db.batch([
      db.prepare('INSERT INTO workspace VALUES (?, ?, 1)').bind('same', '{}'),
      db.prepare('INSERT INTO workspace VALUES (?, ?, 1)').bind('same', '{}'),
    ]));
    assert.equal(await db.prepare('SELECT id FROM workspace').first(), null);
  } finally { db.close(); }
});
test('HTTP runtime serves PWA without authentication and protects all business API data', async t => {
  const { fetchApp, DB } = await fixture(t);
  const root = await fetchApp('/');
  assert.equal(root.status, 200);
  assert.match(await root.text(), /manifest.webmanifest/);
  assert.match(root.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(root.headers.get('Cache-Control'), 'no-store');
  const manifest = await fetchApp('/manifest.webmanifest');
  assert.match(manifest.headers.get('Content-Type'), /application\/manifest\+json/);
  assert.equal((await manifest.json()).display, 'standalone');
  const sw = await fetchApp('/sw.js');
  assert.equal(sw.headers.get('Service-Worker-Allowed'), '/');
  assert.equal(sw.headers.get('Cache-Control'), 'no-cache');
  const denied = await fetchApp('/api/session', { headers: { 'oai-authenticated-user-id': 'owner', 'oai-authenticated-user-email': 'owner@example.com', Authorization: 'Bearer admin', 'X-Real-IP': '1.2.3.4' } });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).state, undefined);
  const stored = JSON.parse((await DB.prepare('SELECT payload FROM workspace').first()).payload);
  assert.equal(stored.state.projects.length, 0);
  assert.equal(stored.state.users.length, 1);
  assert.ok(!JSON.stringify(stored).includes(PASSWORD));
});
test('real HTTP login, server session, CSRF rejection and logout work without third-party identity', async t => {
  const { fetchApp } = await fixture(t);
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  const login = await fetchApp('/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ login: 'admin', password: PASSWORD }) });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('Set-Cookie');
  assert.match(cookieHeader, /HttpOnly/); assert.match(cookieHeader, /SameSite=Lax/);
  const Cookie = cookieHeader.split(';')[0];
  const session = await fetchApp('/api/session', { headers: { Cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).account.login, 'admin');
  const crossOrigin = await fetchApp('/api/auth/logout', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example', Cookie }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  const logout = await fetchApp('/api/auth/logout', { method: 'POST', headers: { ...headers, Cookie }, body: '{}' });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await fetchApp('/api/session', { headers: { Cookie } })).status, 401);
});
test('runtime never serves secrets/source files or accepts a forged Host', async t => {
  const { fetchApp, url } = await fixture(t);
  for (const path of ['/config/runtime.json', '/server/auth.mjs', '/data/dinfon.sqlite', '/client/..%2f..%2fconfig/runtime.json', '/%2eenv', '/client/%00']) {
    assert.equal((await fetchApp(path)).status, 404, path);
  }
  assert.equal((await fetchApp('/', { headers: { Host: 'evil.example' } })).status, 421);
  const write = await fetchApp('/client/app.js', { method: 'POST', body: 'x' });
  assert.equal(write.status, 405);
  // Raw request form is checked before URL normalization can reinterpret it.
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(url, { path: '//evil.example/api/session', headers: { Host: '127.0.0.1:3000' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(response, 400);
});
