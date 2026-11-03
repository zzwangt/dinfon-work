import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/sqlite.mjs';
import { initializeAuthSchema, hashPassword, issueSession } from '../server/auth.mjs';
import { handleHttpApi, initializeLocalWorkspace } from '../server/service.mjs';

const ORIGIN = 'https://company.example';
const HASH = await hashPassword('Only an isolated maintenance test password');
const routes = [
  ['/api/maintenance', 'GET'],
  ['/api/maintenance/settings', 'PATCH'],
  ['/api/maintenance/backups', 'POST'],
  ['/api/maintenance/upgrade/prepare', 'POST'],
  ['/api/maintenance/upgrade/apply', 'POST'],
];
async function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await initializeAuthSchema(db);
  const calls = [];
  const env = {
    DB: db, SITE_ORIGIN: ORIGIN, INITIAL_ADMIN_LOGIN: 'owner', INITIAL_ADMIN_PASSWORD_HASH: HASH, SEED_DEMO_DATA: true,
    MAINTENANCE: { async handle(request, context) {
      calls.push({ path: new URL(request.url).pathname, method: request.method, actor: context.actor, account: context.account });
      return Response.json({ delegated: true, actorId: context.actor.id });
    } },
  };
  await initializeLocalWorkspace(env);
  const stored = () => JSON.parse(db.sqlite.prepare("SELECT payload FROM workspace WHERE id = 'main'").get().payload);
  const cookies = {};
  for (const userId of ['u-admin', 'u-engineer', 'u-manager']) {
    let account = stored().accounts.find(item => item.userId === userId);
    if (!account) {
      account = { id: `account-${userId}`, userId, login: `login-${userId}`, status: 'active' };
      const workspace = stored(); workspace.accounts.push(account);
      db.sqlite.prepare("UPDATE workspace SET payload = ?, revision = revision + 1 WHERE id = 'main'").run(JSON.stringify(workspace));
      db.sqlite.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?, 0, 1, ?)').run(account.id, account.login, HASH, new Date().toISOString());
    }
    const credential = db.sqlite.prepare('SELECT * FROM auth_credentials WHERE account_id = ?').get(account.id);
    cookies[userId] = (await issueSession(db, env, credential)).split(';')[0];
  }
  const call = async (path, method = 'GET', user = 'u-admin') => {
    const headers = { ...(user ? { Cookie: cookies[user] } : {}), Origin: ORIGIN, 'Content-Type': 'application/json', 'x-user-role': 'admin' };
    const request = new Request(ORIGIN + path, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify({ actorId: 'u-admin', role: 'admin' }) }) });
    const response = await handleHttpApi(request, env);
    return { status: response.status, data: await response.json() };
  };
  return { db, env, calls, stored, call };
}

test('maintenance never delegates anonymous users, employees, project managers or forced-password-change admins', async t => {
  const f = await fixture(t);
  for (const [path, method] of routes) {
    assert.equal((await f.call(path, method, null)).status, 401, path);
    for (const user of ['u-engineer', 'u-manager']) assert.equal((await f.call(path, method, user)).status, 403, `${path} ${user}`);
  }
  const admin = f.stored().accounts.find(account => account.userId === 'u-admin');
  f.db.sqlite.prepare('UPDATE auth_credentials SET must_change = 1 WHERE account_id = ?').run(admin.id);
  for (const [path, method] of routes) {
    const result = await f.call(path, method);
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'PASSWORD_CHANGE_REQUIRED');
  }
  assert.deepEqual(f.calls, []);
});

test('maintenance delegates a verified current administrator with server-derived identity', async t => {
  const f = await fixture(t);
  for (const [path, method] of routes) {
    const result = await f.call(path, method);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { delegated: true, actorId: 'u-admin' });
  }
  assert.equal(f.calls.length, routes.length);
  const admin = f.stored().accounts.find(account => account.userId === 'u-admin');
  for (const call of f.calls) {
    assert.equal(call.actor.role, 'admin');
    assert.equal(call.account.id, admin.id);
    assert.equal(Object.hasOwn(call, 'credential'), false);
  }
});

test('missing maintenance runtime fails clearly without bypassing administrator checks', async t => {
  const f = await fixture(t);
  delete f.env.MAINTENANCE;
  assert.equal((await f.call('/api/maintenance', 'GET', 'u-engineer')).status, 403);
  const missing = await f.call('/api/maintenance');
  assert.equal(missing.status, 503);
  assert.equal(missing.data.code, 'MAINTENANCE_UNAVAILABLE');
  assert.deepEqual(f.calls, []);
});
