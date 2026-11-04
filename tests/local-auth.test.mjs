import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/sqlite.mjs';
import { initializeAuthSchema, hashPassword, verifyPassword, digest } from '../server/auth.mjs';
import { handleApi, handleHttpApi, initializeLocalWorkspace, provisionInitialCredential, recoverLocalAdmin } from '../server/service.mjs';

const ORIGIN = 'https://company.example';
const OWNER_PASSWORD = 'Owner long passphrase 2026';
const TEMP_PASSWORD = 'Temporary employee password 2026';
const NEW_PASSWORD = 'My personal password phrase 2026';
const INITIAL_HASH = await hashPassword(OWNER_PASSWORD);

async function fixture(t, options = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await initializeAuthSchema(db);
  const env = { DB: db, SITE_ORIGIN: ORIGIN, CLIENT_IP: '192.0.2.20', INITIAL_ADMIN_LOGIN: 'owner', INITIAL_ADMIN_PASSWORD_HASH: INITIAL_HASH, SEED_DEMO_DATA: true, ...options };
  await initializeLocalWorkspace(env);
  const call = async (path, data, { cookie, method = data ? 'POST' : 'GET', headers = {}, ip } = {}) => {
    const allHeaders = { ...(data ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers };
    for (const key of Object.keys(allHeaders)) if (allHeaders[key] == null) delete allHeaders[key];
    const result = await handleHttpApi(new Request(`${ORIGIN}${path}`, { method, headers: allHeaders, ...(data ? { body: JSON.stringify(data) } : {}) }), ip ? { ...env, CLIENT_IP: ip } : env);
    return { status: result.status, headers: result.headers, cookie: result.headers.get('Set-Cookie')?.split(';')[0], data: await result.json() };
  };
  const stored = () => JSON.parse(db.sqlite.prepare('SELECT payload FROM workspace WHERE id = ?').get('main').payload);
  const signIn = async (login = 'owner', password = OWNER_PASSWORD) => {
    const result = await call('/api/auth/login', { login, password });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result;
  };
  const add = async (ownerCookie, login = 'engineer', existingUserId = 'u-engineer') => {
    const state = await call('/api/session', null, { cookie: ownerCookie });
    const result = await call('/api/accounts', { revision: state.data.revision, login, password: TEMP_PASSWORD, name: '工程师', role: 'member', existingUserId }, { cookie: ownerCookie });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.accounts.find((account) => account.login === login);
  };
  return { db, env, call, stored, signIn, add };
}

test('passwords use unique salted slow hashes, validate exact passwords and accept Unicode', async () => {
  const a = await hashPassword('中文长句密码可以使用也很容易记住');
  const b = await hashPassword('中文长句密码可以使用也很容易记住');
  assert.notEqual(a, b);
  assert(a.startsWith('$scrypt$32768$8$3$'));
  assert.equal(await verifyPassword('中文长句密码可以使用也很容易记住', a), true);
  assert.equal(await verifyPassword('wrong password', a), false);
  await assert.rejects(hashPassword('short'), { code: 'INVALID_PASSWORD' });
  await assert.rejects(hashPassword('x'.repeat(129)), { code: 'INVALID_PASSWORD' });
});

test('production initialization has no demonstration employees or projects and never reassigns admin from changed configuration', async (t) => {
  const f = await fixture(t, { SEED_DEMO_DATA: false });
  assert.equal(f.stored().state.users.length, 1);
  assert.equal(f.stored().state.projects.length, 0);
  assert.equal(f.stored().state.tasks.length, 0);
  const before = f.stored();
  assert.deepEqual(await initializeLocalWorkspace({ ...f.env, INITIAL_ADMIN_LOGIN: 'impostor', INITIAL_ADMIN_PASSWORD_HASH: undefined }), { initialized: false, requiresMigration: false });
  assert.deepEqual(f.stored(), before);
});

test('public HTTP ignores forged hosting identity, roles and bearer tokens; unknown accounts cannot self-register', async (t) => {
  const f = await fixture(t);
  const denied = await f.call('/api/session', null, { headers: { Authorization: 'Bearer fake', 'x-oai-user-id': 'owner', 'x-user-email': 'owner@example.com', 'x-user-role': 'admin' } });
  assert.equal(denied.status, 401);
  assert.equal((await f.call('/api/auth/register', { login: 'intruder', password: TEMP_PASSWORD, role: 'admin' })).status, 401);
  const unknown = await f.call('/api/auth/login', { login: 'unknown', password: OWNER_PASSWORD, localAccountId: f.stored().accounts[0].id, userId: 'u-admin', role: 'admin' });
  const wrong = await f.call('/api/auth/login', { login: 'owner', password: 'wrong' });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.data, wrong.data);
  assert.equal(f.stored().accounts.length, 1);
});

test('cookies are Secure HttpOnly SameSite, DB stores only token hashes, expiry and logout revoke access', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn('OWNER');
  const header = owner.headers.get('Set-Cookie');
  assert.match(header, /^__Host-dinfon_session=/);
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=43200']) assert(header.includes(part));
  const token = owner.cookie.split('=')[1];
  const row = f.db.sqlite.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(row.token_hash, digest(token));
  assert.equal(JSON.stringify(row).includes(token), false);
  assert.equal((await f.call('/api/session', null, { cookie: owner.cookie })).status, 200);
  assert.equal((await f.call('/api/session', null, { cookie: `${owner.cookie}; ${owner.cookie}` })).status, 401);
  f.db.sqlite.prepare('UPDATE auth_sessions SET expires_at = 1').run();
  assert.equal((await f.call('/api/session', null, { cookie: owner.cookie })).status, 401);
  const fresh = await f.signIn();
  const logout = await f.call('/api/auth/logout', {}, { cookie: fresh.cookie });
  assert.equal(logout.status, 200);
  assert(logout.headers.get('Set-Cookie').includes('Max-Age=0'));
  assert.equal((await f.call('/api/session', null, { cookie: fresh.cookie })).status, 401);
});

test('login, logout and password changes require same-origin JSON and cannot be CSRFed', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  for (const [path, data] of [['/api/auth/login', { login: 'owner', password: OWNER_PASSWORD }], ['/api/auth/logout', {}], ['/api/auth/password', { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD }]]) {
    for (const origin of [null, 'https://attacker.example', 'null']) {
      const result = await f.call(path, data, { cookie: owner.cookie, headers: { Origin: origin } });
      assert.equal(result.status, 403, path);
      assert.equal(result.data.code, 'ORIGIN_REJECTED');
    }
    assert.equal((await f.call(path, data, { cookie: owner.cookie, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  }
  assert.equal((await f.call('/api/session', null, { cookie: owner.cookie })).status, 200);
});

test('temporary employee passwords cannot read any business data or issue commands until changed; scope survives the change', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  await f.add(owner.cookie);
  const employee = await f.signIn('engineer', TEMP_PASSWORD);
  assert.equal(employee.data.mustChangePassword, true);
  assert.equal(employee.data.account.mustChangePassword, true);
  assert.equal('state' in employee.data, false);
  const locked = await f.call('/api/session', null, { cookie: employee.cookie });
  assert.equal('state' in locked.data, false);
  for (const [path, data] of [['/api/accounts', null], ['/api/command', { action: 'updateTask', revision: 1, payload: { id: 't-07', status: 'done' } }]]) {
    const result = await f.call(path, data, { cookie: employee.cookie });
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'PASSWORD_CHANGE_REQUIRED');
  }
  const wrong = await f.call('/api/auth/password', { currentPassword: 'wrong', newPassword: NEW_PASSWORD }, { cookie: employee.cookie });
  assert.equal(wrong.status, 400);
  const changed = await f.call('/api/auth/password', { currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD }, { cookie: employee.cookie });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.notEqual(changed.cookie, employee.cookie);
  assert.equal(changed.data.mustChangePassword, false);
  assert.deepEqual(changed.data.state.projects.map((project) => project.id).sort(), ['p-mower', 'p-pcb']);
  assert.equal(changed.data.account.login, 'engineer');
  assert.equal((await f.call('/api/session', null, { cookie: employee.cookie })).status, 401);
  assert.equal((await f.call('/api/accounts', null, { cookie: changed.cookie })).status, 403);
  const forged = await f.call('/api/command', { revision: changed.data.revision, actorId: 'u-admin', action: 'submitTask', payload: { id: 't-13', deliverable: 'forged' } }, { cookie: changed.cookie });
  assert.equal(forged.status, 404);
  assert.equal(JSON.stringify(changed.data).includes('password_hash'), false);
  assert.equal(JSON.stringify(changed.data).includes('$scrypt$'), false);
  assert.equal(JSON.stringify(f.stored()).includes(TEMP_PASSWORD), false);
});

test('resetting and disabling employees revoke every device; enabling does not revive an old cookie', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const account = await f.add(owner.cookie);
  const deviceA = await f.signIn('engineer', TEMP_PASSWORD);
  const deviceB = await f.signIn('engineer', TEMP_PASSWORD);
  const current = await f.call('/api/session', null, { cookie: owner.cookie });
  const reset = await f.call(`/api/accounts/${account.id}/password`, { password: NEW_PASSWORD, revision: current.data.revision }, { cookie: owner.cookie });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert(reset.data.accounts.find((entry) => entry.id === account.id).mustChangePassword);
  for (const device of [deviceA, deviceB]) assert.equal((await f.call('/api/session', null, { cookie: device.cookie })).status, 401);
  assert.equal((await f.call('/api/auth/login', { login: 'engineer', password: TEMP_PASSWORD })).status, 401);
  const fresh = await f.signIn('engineer', NEW_PASSWORD);
  assert.equal(fresh.data.mustChangePassword, true);
  const adminView = await f.call('/api/session', null, { cookie: owner.cookie });
  const disabled = await f.call(`/api/accounts/${account.id}`, { status: 'disabled', revision: adminView.data.revision }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(disabled.status, 200);
  assert.equal((await f.call('/api/session', null, { cookie: fresh.cookie })).status, 401);
  const disabledLogin = await f.call('/api/auth/login', { login: 'engineer', password: NEW_PASSWORD });
  assert.equal(disabledLogin.data.code, 'INVALID_CREDENTIALS');
  const enabled = await f.call(`/api/accounts/${account.id}`, { status: 'active', revision: disabled.data.revision }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(enabled.status, 200);
  assert.equal((await f.call('/api/session', null, { cookie: fresh.cookie })).status, 401);
  await f.signIn('engineer', NEW_PASSWORD);
});

test('concurrent account creation keeps workspace and credential rows consistent with CAS', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const results = await Promise.all(['worker-a', 'worker-b'].map((login) => f.call('/api/accounts', { revision: owner.data.revision, login, password: TEMP_PASSWORD, name: login, role: 'member' }, { cookie: owner.cookie })));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const stored = f.stored();
  assert.equal(stored.accounts.length, 2);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS count FROM auth_credentials').get().count, 2);
  assert.equal(stored.state.users.filter((user) => user.name.startsWith('worker-')).length, 1);
});

test('failed logins are persistently rate limited per username despite forged IP headers', async (t) => {
  const f = await fixture(t);
  // Seed persisted history to avoid spending 10 expensive hashes in a unit test.
  f.db.sqlite.prepare('INSERT INTO auth_rate_limits (bucket, attempts, window_end) VALUES (?, ?, ?)').run(digest('login:owner'), 10, Date.now() + 60_000);
  const limited = await f.call('/api/auth/login', { login: 'owner', password: OWNER_PASSWORD }, { headers: { 'x-forwarded-for': '198.51.100.44', 'x-real-ip': '198.51.100.44' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, 'AUTH_RATE_LIMITED');
  assert.equal(limited.headers.get('Retry-After'), '900');
  assert.equal(f.db.sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE bucket = ?').get(digest('login:owner')).attempts, 11);
  f.db.sqlite.prepare('UPDATE auth_rate_limits SET window_end = 1').run();
  await f.signIn();
});

test('recovery is an offline admin-only operation, invalidates all sessions and forces a new personal password', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  await f.add(owner.cookie);
  await assert.rejects(recoverLocalAdmin(f.env, { login: 'engineer', password: NEW_PASSWORD }), { code: 'ADMIN_REQUIRED' });
  await recoverLocalAdmin(f.env, { login: 'owner', password: NEW_PASSWORD });
  assert.equal((await f.call('/api/session', null, { cookie: owner.cookie })).status, 401);
  const recovered = await f.signIn('owner', NEW_PASSWORD);
  assert.equal(recovered.data.mustChangePassword, true);
  assert.equal('state' in recovered.data, false);
  assert.equal(JSON.stringify(f.stored()).includes(NEW_PASSWORD), false);
});

test('existing hosted workspace migration requires an explicitly selected active administrator and preserves business identities', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await initializeAuthSchema(db);
  const legacy = await handleApi(new Request(`${ORIGIN}/api/session`), { DB: db, FIRST_ADMIN_EMAIL: 'owner@example.com' }, { userId: 'hosted-user', email: 'owner@example.com', displayName: '原管理员' });
  assert.equal(legacy.status, 200);
  const before = JSON.parse(db.sqlite.prepare('SELECT payload FROM workspace').get().payload);
  const env = { DB: db, SITE_ORIGIN: ORIGIN, INITIAL_ADMIN_LOGIN: 'company-owner', INITIAL_ADMIN_PASSWORD_HASH: INITIAL_HASH };
  assert.deepEqual(await initializeLocalWorkspace(env), { initialized: false, requiresMigration: true });
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM auth_credentials').get().count, 0);
  await assert.rejects(provisionInitialCredential(env, { accountId: 'unknown' }), { code: 'ADMIN_REQUIRED' });
  await provisionInitialCredential(env, { accountId: before.accounts[0].id });
  const after = JSON.parse(db.sqlite.prepare('SELECT payload FROM workspace').get().payload);
  assert.equal(after.accounts[0].id, before.accounts[0].id);
  assert.equal(after.accounts[0].userId, before.accounts[0].userId);
  assert.deepEqual(after.state.projects, before.state.projects);
  await assert.rejects(provisionInitialCredential(env, { accountId: before.accounts[0].id }), { code: 'ALREADY_INITIALIZED' });
});

test('administrator can assign a new employee to existing projects; removing membership revokes project reads and writes', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const created = await f.call('/api/accounts', { revision: owner.data.revision, login: 'new-worker', password: TEMP_PASSWORD, name: '新员工', role: 'member', projectIds: ['p-pcb'] }, { cookie: owner.cookie });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const account = created.data.accounts.find((entry) => entry.login === 'new-worker');
  const employee = await f.signIn('new-worker', TEMP_PASSWORD);
  const changed = await f.call('/api/auth/password', { currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD }, { cookie: employee.cookie });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data.state.projects.map((project) => project.id), ['p-pcb']);
  assert(changed.data.state.tasks.every((task) => task.projectId === 'p-pcb'));
  const before = f.stored();
  const adminView = await f.call('/api/session', null, { cookie: owner.cookie });
  const removed = await f.call(`/api/accounts/${account.id}`, { revision: adminView.data.revision, projectIds: [] }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal((await f.call('/api/session', null, { cookie: changed.cookie })).status, 401);
  const fresh = await f.signIn('new-worker', NEW_PASSWORD);
  assert.deepEqual(fresh.data.state.projects, []);
  assert.deepEqual(fresh.data.state.tasks, []);
  const forged = await f.call('/api/command', { revision: fresh.data.revision, action: 'requestMilestone', payload: { projectId: 'p-pcb', type: 'create', title: '越权大节点', dueDate: '2026-10-30T18:00' } }, { cookie: fresh.cookie });
  assert.equal(forged.status, 404);
  assert.deepEqual(f.stored().state.tasks, before.state.tasks);
});

test('administrator can add an existing employee to an existing project while retaining their other projects and task ownership', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const account = await f.add(owner.cookie);
  const employee = await f.signIn('engineer', TEMP_PASSWORD);
  const changed = await f.call('/api/auth/password', { currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD }, { cookie: employee.cookie });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data.state.projects.map((project) => project.id).sort(), ['p-mower', 'p-pcb']);
  const before = f.stored();
  const listed = await f.call('/api/accounts', null, { cookie: owner.cookie });
  const selected = [...listed.data.state.projects.filter((project) => project.memberIds.includes(account.userId)).map((project) => project.id), 'p-site'];
  const added = await f.call(`/api/accounts/${account.id}`, { revision: listed.data.revision, projectIds: selected }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const after = f.stored();
  assert.deepEqual(after.state.projects.filter((project) => project.memberIds.includes(account.userId)).map((project) => project.id).sort(), ['p-mower', 'p-pcb', 'p-site']);
  for (const project of before.state.projects.filter((project) => project.id !== 'p-site')) {
    assert.deepEqual(after.state.projects.find((entry) => entry.id === project.id), project);
  }
  assert.deepEqual(after.state.tasks, before.state.tasks);
  const newLogs = after.state.logs.filter((entry) => !before.state.logs.some((old) => old.id === entry.id));
  const membershipLogs = newLogs.filter((entry) => entry.projectId !== null);
  assert.equal(membershipLogs.length, 1);
  assert.equal(membershipLogs[0].projectId, 'p-site');
  assert.equal(membershipLogs[0].actorId, owner.data.actor.id);
  assert.match(membershipLogs[0].message, /工程师.*加入/);
  assert(newLogs.some((entry) => entry.projectId === null && /更新账号 工程师/.test(entry.message)));
  assert.equal((await f.call('/api/session', null, { cookie: changed.cookie })).status, 401);
  const fresh = await f.signIn('engineer', NEW_PASSWORD);
  assert.deepEqual(fresh.data.state.projects.map((project) => project.id).sort(), ['p-mower', 'p-pcb', 'p-site']);
  assert(fresh.data.state.tasks.every((task) => selected.includes(task.projectId)));
  assert(fresh.data.state.logs.some((entry) => entry.id === membershipLogs[0].id));
  assert.equal((await f.call('/api/accounts', null, { cookie: fresh.cookie })).status, 403);
  const current = await f.call('/api/accounts', null, { cookie: owner.cookie });
  const removed = await f.call(`/api/accounts/${account.id}`, { revision: current.data.revision, projectIds: ['p-mower', 'p-pcb'] }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert(removed.data.state.logs.some((entry) => entry.projectId === 'p-site' && /工程师.*移出/.test(entry.message)));
  assert.deepEqual(f.stored().state.tasks, before.state.tasks);
});

test('account refresh returns projects and revision from the same session snapshot and stale membership changes fail atomically', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const account = await f.add(owner.cookie);
  const initial = await f.call('/api/accounts', null, { cookie: owner.cookie });
  assert.equal(initial.status, 200);
  assert.equal(initial.data.actor.id, owner.data.actor.id);
  assert.equal(initial.data.account.id, owner.data.account.id);
  assert.equal(initial.data.capabilities.manageAccounts, true);
  assert.deepEqual(initial.data.users, initial.data.state.users);
  const submitted = await f.call('/api/command', {
    revision: initial.data.revision, action: 'createProject',
    payload: { name: '后创建的项目', ownerId: 'u-admin', memberIds: [], startDate: '2099-10-25T09:00', dueDate: '2099-10-30T18:00' },
  }, { cookie: owner.cookie });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  const created = await f.call('/api/command', {
    revision: submitted.data.revision, action: 'reviewProjectPlan',
    payload: {id: submitted.data.state.projectPlans[0].id, approve:true},
  }, { cookie: owner.cookie });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const project = created.data.state.projects.at(-1);
  assert.equal(initial.data.state.projects.some((entry) => entry.id === project.id), false);
  const before = f.stored();
  const credentialBefore = f.db.sqlite.prepare('SELECT version FROM auth_credentials WHERE account_id = ?').get(account.id).version;
  const stale = await f.call(`/api/accounts/${account.id}`, { revision: initial.data.revision, projectIds: ['p-mower', 'p-pcb', project.id] }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(stale.status, 409);
  assert.deepEqual(f.stored(), before);
  assert.equal(f.db.sqlite.prepare('SELECT version FROM auth_credentials WHERE account_id = ?').get(account.id).version, credentialBefore);
  const refreshed = await f.call('/api/accounts', null, { cookie: owner.cookie });
  const session = await f.call('/api/session', null, { cookie: owner.cookie });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.revision, created.data.revision);
  assert.equal(refreshed.data.revision, session.data.revision);
  assert.deepEqual(refreshed.data.state, session.data.state);
  assert.deepEqual(refreshed.data.actor, session.data.actor);
  assert.deepEqual(refreshed.data.account, session.data.account);
  assert.deepEqual(refreshed.data.users, refreshed.data.state.users);
  assert(refreshed.data.state.projects.some((entry) => entry.id === project.id));
  assert(refreshed.data.accounts.some((entry) => entry.id === account.id));
  const selected = refreshed.data.state.projects.filter((entry) => entry.memberIds.includes(account.userId)).map((entry) => entry.id);
  const added = await f.call(`/api/accounts/${account.id}`, { revision: refreshed.data.revision, projectIds: [...selected, project.id] }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  assert.equal(added.data.revision, refreshed.data.revision + 1);
  assert(added.data.state.projects.find((entry) => entry.id === project.id).memberIds.includes(account.userId));
});

test('malformed project assignments, owner access removal and employee self-assignment fail atomically', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const account = await f.add(owner.cookie);
  const current = await f.call('/api/session', null, { cookie: owner.cookie });
  const before = f.stored();
  for (const projectIds of [null, 'p-pcb', ['unknown'], ['p-pcb', 'p-pcb'], [42]]) {
    const result = await f.call(`/api/accounts/${account.id}`, { revision: current.data.revision, projectIds }, { cookie: owner.cookie, method: 'PATCH' });
    assert.equal(result.status, 400);
    assert.deepEqual(f.stored(), before);
  }
  const employee = await f.signIn('engineer', TEMP_PASSWORD);
  const changed = await f.call('/api/auth/password', { currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD }, { cookie: employee.cookie });
  const self = await f.call(`/api/accounts/${account.id}`, { revision: changed.data.revision, projectIds: ['p-toolbox'] }, { cookie: changed.cookie, method: 'PATCH' });
  assert.equal(self.status, 403);
  const projects = f.stored().state.projects;
  const owned = projects.find((project) => project.ownerId !== 'u-admin');
  const targetUser = f.stored().state.users.find((user) => user.id === owned.ownerId);
  const latest = await f.call('/api/session', null, { cookie: owner.cookie });
  const badLink = await f.call('/api/accounts', { revision: latest.data.revision, login: 'project-owner', password: TEMP_PASSWORD, name: targetUser.name, role: 'member', existingUserId: targetUser.id, projectIds: [] }, { cookie: owner.cookie });
  assert.equal(badLink.status, 400);
  assert.equal(f.stored().accounts.length, 2);
});

test('role changes invalidate old cookies and new sessions immediately enforce the current role', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const account = await f.add(owner.cookie);
  const employee = await f.signIn('engineer', TEMP_PASSWORD);
  const changed = await f.call('/api/auth/password', { currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD }, { cookie: employee.cookie });
  const current = await f.call('/api/session', null, { cookie: owner.cookie });
  const promoted = await f.call(`/api/accounts/${account.id}`, { revision: current.data.revision, role: 'admin' }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(promoted.status, 200);
  assert.equal((await f.call('/api/session', null, { cookie: changed.cookie })).status, 401);
  const fresh = await f.signIn('engineer', NEW_PASSWORD);
  assert.equal(fresh.data.actor.role, 'admin');
  assert.equal(fresh.data.capabilities.manageAccounts, true);
  assert.equal((await f.call('/api/accounts', null, { cookie: fresh.cookie })).status, 200);
});

test('a password change that races an administrator reset cannot overwrite the newer password or mint a usable session', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const originalPrepare = f.db.prepare;
  let raced = false;
  f.db.prepare = (sql) => {
    if (!raced && sql.startsWith('UPDATE auth_credentials SET password_hash = ?, must_change = 0')) {
      raced = true;
      // Model the reset committing while the user's expensive password hash ran.
      f.db.sqlite.prepare('UPDATE auth_credentials SET must_change = 1, version = version + 1').run();
      f.db.sqlite.prepare('DELETE FROM auth_sessions').run();
    }
    return originalPrepare(sql);
  };
  const result = await f.call('/api/auth/password', { currentPassword: OWNER_PASSWORD, newPassword: NEW_PASSWORD }, { cookie: owner.cookie });
  assert(raced);
  assert.equal(result.status, 409);
  assert.equal(result.cookie, undefined);
  const row = f.db.sqlite.prepare('SELECT * FROM auth_credentials').get();
  assert.equal(row.password_hash, INITIAL_HASH);
  assert.equal(row.version, 2);
  assert.equal(row.must_change, 1);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS count FROM auth_sessions').get().count, 0);
});

test('a login paused after reading credentials rejects a concurrent administrator recovery without returning business data', async (t) => {
  const f = await fixture(t);
  const originalPrepare = f.db.prepare;
  let captured;
  let resume;
  const didCapture = new Promise((resolve) => { captured = resolve; });
  const mayResume = new Promise((resolve) => { resume = resolve; });
  let intercepted = false;
  f.db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!intercepted && sql === 'SELECT * FROM auth_credentials WHERE login = ?') {
      intercepted = true;
      const first = statement.first.bind(statement);
      statement.first = async () => {
        const oldCredential = await first();
        captured();
        await mayResume;
        return oldCredential;
      };
    }
    return statement;
  };
  const pendingLogin = f.call('/api/auth/login', { login: 'owner', password: OWNER_PASSWORD });
  await didCapture;
  try { await recoverLocalAdmin(f.env, { login: 'owner', password: NEW_PASSWORD }); }
  finally { resume(); }
  const result = await pendingLogin;
  assert.equal(result.status, 401);
  assert.equal(result.cookie, undefined);
  assert.equal('state' in result.data, false);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS count FROM auth_sessions').get().count, 0);
  const fresh = await f.signIn('owner', NEW_PASSWORD);
  assert.equal(fresh.data.mustChangePassword, true);
  assert.equal('state' in fresh.data, false);
});

test('credential changes between login revalidation and session insertion fail closed', async (t) => {
  const f = await fixture(t);
  const originalPrepare = f.db.prepare;
  let raced = false;
  f.db.prepare = (sql) => {
    if (!raced && sql.startsWith('INSERT INTO auth_sessions')) {
      raced = true;
      f.db.sqlite.prepare('UPDATE auth_credentials SET must_change = 1, version = version + 1').run();
    }
    return originalPrepare(sql);
  };
  const result = await f.call('/api/auth/login', { login: 'owner', password: OWNER_PASSWORD });
  assert(raced);
  assert.equal(result.status, 401);
  assert.equal(result.cookie, undefined);
  assert.equal('state' in result.data, false);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS count FROM auth_sessions').get().count, 0);
});

test('session insertion checks current workspace account status as well as credential version', async (t) => {
  const f = await fixture(t);
  const originalPrepare = f.db.prepare;
  let raced = false;
  f.db.prepare = (sql) => {
    if (!raced && sql.startsWith('INSERT INTO auth_sessions')) {
      raced = true;
      const workspace = f.stored();
      workspace.accounts[0].status = 'disabled';
      f.db.sqlite.prepare('UPDATE workspace SET payload = ? WHERE id = ?').run(JSON.stringify(workspace), 'main');
    }
    return originalPrepare(sql);
  };
  const result = await f.call('/api/auth/login', { login: 'owner', password: OWNER_PASSWORD });
  assert(raced);
  assert.equal(result.status, 401);
  assert.equal(result.cookie, undefined);
  assert.equal('state' in result.data, false);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS count FROM auth_sessions').get().count, 0);
});

test('account profiles are editable independently of authorization and are returned by account lists', async (t) => {
  const f = await fixture(t);
  const owner = await f.signIn();
  const account = await f.add(owner.cookie);
  const employee = await f.signIn('engineer', TEMP_PASSWORD);
  const changed = await f.call('/api/auth/password', { currentPassword: TEMP_PASSWORD, newPassword: NEW_PASSWORD }, { cookie: employee.cookie });
  const current = await f.call('/api/accounts', null, { cookie: owner.cookie });
  const before = f.stored();
  const edited = await f.call(`/api/accounts/${account.id}`, { revision: current.data.revision, title: ' 管理员 ', department: ' 人力资源 ' }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const profile = edited.data.accounts.find((entry) => entry.id === account.id);
  assert.equal(profile.title, '管理员');
  assert.equal(profile.department, '人力资源');
  assert.equal(profile.role, 'member');
  assert.equal('isSuperAdmin' in profile, false);
  assert.deepEqual(f.stored().state.tasks, before.state.tasks);
  assert.deepEqual(f.stored().state.projects, before.state.projects);
  const cleared = await f.call(`/api/accounts/${account.id}`, { revision: edited.data.revision, title: '', department: '' }, { cookie: owner.cookie, method: 'PATCH' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.accounts.find((entry) => entry.id === account.id).title, '');
  assert.equal(cleared.data.accounts.find((entry) => entry.id === account.id).department, '');
  const stable = f.stored();
  for (const invalid of [{ title: 12 }, { title: [] }, { title: '字'.repeat(61) }, { department: false }, { department: '字'.repeat(61) }]) {
    const result = await f.call(`/api/accounts/${account.id}`, { revision: cleared.data.revision, ...invalid }, { cookie: owner.cookie, method: 'PATCH' });
    assert.equal(result.status, 400);
    assert.deepEqual(f.stored(), stable);
  }
  assert.equal((await f.call('/api/session', null, { cookie: changed.cookie })).status, 200, 'profile-only edits must not terminate another account session');
  const forbidden = await f.call(`/api/accounts/${account.id}`, { revision: changed.data.revision, title: '管理员', role: 'admin' }, { cookie: changed.cookie, method: 'PATCH' });
  assert.equal(forbidden.status, 403);
  assert.equal(changed.data.actor.role, 'member');
});

async function addAdmin(f, owner, login='peer-admin') {
  const current=await f.call('/api/session',null,{cookie:owner.cookie});
  const created=await f.call('/api/accounts',{revision:current.data.revision,login,password:TEMP_PASSWORD,name:'另一管理员',role:'admin'},{cookie:owner.cookie});
  assert.equal(created.status,201,JSON.stringify(created.data));
  const temporary=await f.signIn(login,TEMP_PASSWORD);
  const changed=await f.call('/api/auth/password',{currentPassword:TEMP_PASSWORD,newPassword:NEW_PASSWORD},{cookie:temporary.cookie});
  assert.equal(changed.status,200,JSON.stringify(changed.data));
  return changed;
}

test('only the super administrator can manage administrator accounts; regular administrators manage employees',async(t)=>{
  const f=await fixture(t),owner=await f.signIn();
  assert.equal(owner.data.account.role,'superadmin');
  const peer=await addAdmin(f,owner),second=await addAdmin(f,owner,'second-admin');
  const employee=await f.add(owner.cookie);
  const current=await f.call('/api/accounts',null,{cookie:peer.cookie});
  const before=f.stored(),credentials=f.db.sqlite.prepare('SELECT * FROM auth_credentials ORDER BY account_id').all();
  for(const target of [owner.data.account,peer.data.account,second.data.account]){
    for(const change of [{title:'强改职位'},{department:'强改部门'},{status:'disabled'},{role:'member'},{projectIds:[]}]){
      const result=await f.call(`/api/accounts/${target.id}`,{revision:current.data.revision,...change},{cookie:peer.cookie,method:'PATCH'});
      assert.equal(result.status,403,JSON.stringify(result.data));
    }
    const deleted=await f.call(`/api/accounts/${target.id}`,{revision:current.data.revision},{cookie:peer.cookie,method:'DELETE'});
    assert.equal(deleted.status,target.id===peer.data.account.id?400:403);
    const reset=await f.call(`/api/accounts/${target.id}/password`,{revision:current.data.revision,password:TEMP_PASSWORD},{cookie:peer.cookie});
    assert.equal(reset.status,target.id===peer.data.account.id?400:403);
  }
  for(const role of ['admin','superadmin','manager']){
    const created=await f.call('/api/accounts',{revision:current.data.revision,login:'forged-'+role,password:TEMP_PASSWORD,name:'越权账号',role},{cookie:peer.cookie});
    assert.ok([400,403].includes(created.status));
    const elevated=await f.call(`/api/accounts/${employee.id}`,{revision:current.data.revision,role},{cookie:peer.cookie,method:'PATCH'});
    assert.ok([400,403].includes(elevated.status));
  }
  assert.deepEqual(f.stored(),before);assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM auth_credentials ORDER BY account_id').all(),credentials);
  const edited=await f.call(`/api/accounts/${employee.id}`,{revision:current.data.revision,title:'工程师',projectIds:['p-mower']},{cookie:peer.cookie,method:'PATCH'});assert.equal(edited.status,200);
  const reset=await f.call(`/api/accounts/${employee.id}/password`,{revision:edited.data.revision,password:TEMP_PASSWORD},{cookie:peer.cookie});assert.equal(reset.status,200);
  const removed=await f.call(`/api/accounts/${employee.id}`,{revision:reset.data.revision},{cookie:peer.cookie,method:'DELETE'});assert.equal(removed.status,200);
  const latest=await f.call('/api/session',null,{cookie:owner.cookie});
  const promoted=await f.call(`/api/accounts/${second.data.account.id}`,{revision:latest.data.revision,role:'member'},{cookie:owner.cookie,method:'PATCH'});assert.equal(promoted.status,200);
  assert.equal((await f.call('/api/session',null,{cookie:second.cookie})).status,401);
  for(const change of [{status:'disabled'},{role:'admin'},{role:'member'}]){
    const denied=await f.call(`/api/accounts/${owner.data.account.id}`,{revision:promoted.data.revision,...change},{cookie:owner.cookie,method:'PATCH'});assert.equal(denied.data.code,'SELF_LOCKOUT');
  }
});

test('deleting an account revokes every login and preserves all business history; reused login is a new identity',async(t)=>{
  const f=await fixture(t),owner=await f.signIn();
  const target=await f.add(owner.cookie);
  const temporary=await f.signIn('engineer',TEMP_PASSWORD);
  const employee=await f.call('/api/auth/password',{currentPassword:TEMP_PASSWORD,newPassword:NEW_PASSWORD},{cookie:temporary.cookie});
  const second=await f.signIn('engineer',NEW_PASSWORD);
  const listed=await f.call('/api/accounts',null,{cookie:owner.cookie});
  const before=f.stored();
  assert.ok(f.db.sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE account_id = ?').get(target.id).n>=2);
  const removed=await f.call(`/api/accounts/${target.id}`,{revision:listed.data.revision},{cookie:owner.cookie,method:'DELETE'});
  assert.equal(removed.status,200,JSON.stringify(removed.data));
  assert.equal(removed.data.revision,listed.data.revision+1);
  assert.equal(removed.data.accounts.some(a=>a.id===target.id),false);
  assert.equal(f.db.sqlite.prepare('SELECT * FROM auth_credentials WHERE account_id = ?').get(target.id),undefined);
  assert.equal(f.db.sqlite.prepare('SELECT * FROM auth_sessions WHERE account_id = ?').get(target.id),undefined);
  for(const cookie of [employee.cookie,second.cookie])assert.equal((await f.call('/api/session',null,{cookie})).status,401);
  assert.equal((await f.call('/api/auth/login',{login:'engineer',password:NEW_PASSWORD})).status,401);
  const after=f.stored();
  for(const key of ['users','projects','tasks','milestones','extensions','milestoneRequests'])assert.deepEqual(after.state[key],before.state[key],key);
  assert.deepEqual(after.state.logs.slice(1),before.state.logs);
  assert.match(after.state.logs[0].message,/删除账号/);
  const recreated=await f.call('/api/accounts',{revision:removed.data.revision,login:'engineer',password:TEMP_PASSWORD,name:'同名新员工',role:'member'},{cookie:owner.cookie});
  assert.equal(recreated.status,201,JSON.stringify(recreated.data));
  const replacement=recreated.data.accounts.find(a=>a.login==='engineer');
  assert.notEqual(replacement.id,target.id);assert.notEqual(replacement.userId,target.userId);
  assert.ok(recreated.data.state.projects.every(p=>p.ownerId!==replacement.userId&&!p.memberIds.includes(replacement.userId)));
  assert.ok(recreated.data.state.tasks.every(task=>task.ownerId!==replacement.userId));
});

test('account deletion rejects employees, self-lockout, unknown IDs, cross-origin writes and stale revisions',async(t)=>{
  const f=await fixture(t),owner=await f.signIn();
  const target=await f.add(owner.cookie);
  const temporary=await f.signIn('engineer',TEMP_PASSWORD);
  const employee=await f.call('/api/auth/password',{currentPassword:TEMP_PASSWORD,newPassword:NEW_PASSWORD},{cookie:temporary.cookie});
  const listed=await f.call('/api/accounts',null,{cookie:owner.cookie});
  const before=f.stored(),credentials=f.db.sqlite.prepare('SELECT * FROM auth_credentials ORDER BY account_id').all();
  const denied=await f.call(`/api/accounts/${owner.data.account.id}`,{revision:listed.data.revision},{cookie:employee.cookie,method:'DELETE'});
  assert.equal(denied.status,403);assert.equal(denied.data.code,'ADMIN_REQUIRED');
  const self=await f.call(`/api/accounts/${owner.data.account.id}`,{revision:listed.data.revision},{cookie:owner.cookie,method:'DELETE'});
  assert.equal(self.status,400);assert.equal(self.data.code,'SELF_LOCKOUT');
  assert.equal((await f.call('/api/accounts/missing',{revision:listed.data.revision},{cookie:owner.cookie,method:'DELETE'})).status,404);
  assert.equal((await f.call(`/api/accounts/${target.id}`,{revision:listed.data.revision-1},{cookie:owner.cookie,method:'DELETE'})).status,409);
  for(const Origin of [null,'https://attacker.example'])assert.equal((await f.call(`/api/accounts/${target.id}`,{revision:listed.data.revision},{cookie:owner.cookie,method:'DELETE',headers:{Origin}})).status,403);
  assert.deepEqual(f.stored(),before);assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM auth_credentials ORDER BY account_id').all(),credentials);
  assert.equal((await f.call('/api/session',null,{cookie:employee.cookie})).status,200);
});

test('the super administrator can delete an administrator but cannot delete itself',async(t)=>{
  const f=await fixture(t),owner=await f.signIn(),peer=await addAdmin(f,owner);
  const removed=await f.call(`/api/accounts/${peer.data.account.id}`,{revision:peer.data.revision},{cookie:owner.cookie,method:'DELETE'});
  assert.equal(removed.status,200);assert.equal((await f.call('/api/session',null,{cookie:peer.cookie})).status,401);
  assert.equal(removed.data.accounts.filter(a=>a.role==='superadmin').length,1);
  const self=await f.call(`/api/accounts/${owner.data.account.id}`,{revision:removed.data.revision},{cookie:owner.cookie,method:'DELETE'});
  assert.equal(self.data.code,'SELF_LOCKOUT');
});

test('deletion CAS race leaves credentials and all sessions intact when workspace changed',async(t)=>{
  const f=await fixture(t),owner=await f.signIn();
  const target=await f.add(owner.cookie);
  const employee=await f.signIn('engineer',TEMP_PASSWORD);
  const listed=await f.call('/api/accounts',null,{cookie:owner.cookie});
  const credential=f.db.sqlite.prepare('SELECT * FROM auth_credentials WHERE account_id = ?').get(target.id);
  const sessions=f.db.sqlite.prepare('SELECT * FROM auth_sessions WHERE account_id = ?').all(target.id);
  const original=f.db.batch.bind(f.db);
  f.db.batch=async statements=>{f.db.batch=original;f.db.sqlite.prepare('UPDATE workspace SET revision = revision + 1').run();return original(statements);};
  const removed=await f.call(`/api/accounts/${target.id}`,{revision:listed.data.revision},{cookie:owner.cookie,method:'DELETE'});
  assert.equal(removed.status,409);
  assert.equal(f.stored().accounts.some(a=>a.id===target.id),true);
  assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM auth_credentials WHERE account_id = ?').get(target.id),credential);
  assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM auth_sessions WHERE account_id = ?').all(target.id),sessions);
  assert.equal((await f.call('/api/session',null,{cookie:employee.cookie})).status,200);
});

test('explicit hosted-to-local migration binds the sole super administrator and preserves project records',async(t)=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const identity={userId:'hosted-owner',email:'owner@example.com',displayName:'原管理员'};
  const env={DB:db,SITE_ORIGIN:ORIGIN,FIRST_ADMIN_EMAIL:identity.email};
  const owner=await(await handleApi(new Request(`${ORIGIN}/api/session`),env,identity)).json();
  const createdResponse=await handleApi(new Request(`${ORIGIN}/api/accounts`,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({revision:owner.revision,email:'second@example.com',name:'迁移管理员',role:'admin'})}),env,identity);
  assert.equal(createdResponse.status,201);
  const list=(await createdResponse.json()).accounts;const target=list.find(a=>a.role==='superadmin');const ordinary=list.find(a=>a.email==='second@example.com');
  const before=JSON.parse(db.sqlite.prepare('SELECT payload FROM workspace').get().payload);
  await initializeAuthSchema(db);
  await assert.rejects(provisionInitialCredential({...env,INITIAL_ADMIN_LOGIN:'ordinary-admin',INITIAL_ADMIN_PASSWORD_HASH:INITIAL_HASH},{accountId:ordinary.id}),{code:'ADMIN_REQUIRED'});
  await provisionInitialCredential({...env,INITIAL_ADMIN_LOGIN:'selected-admin',INITIAL_ADMIN_PASSWORD_HASH:INITIAL_HASH},{accountId:target.id});
  const response=await handleHttpApi(new Request(`${ORIGIN}/api/auth/login`,{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({login:'selected-admin',password:OWNER_PASSWORD})}),env);
  assert.equal(response.status,200);
  const session=await response.json();assert.equal(session.account.role,'superadmin');assert.equal('isSuperAdmin' in session.account,false);assert.equal(session.capabilities.manageAccounts,true);
  const after=JSON.parse(db.sqlite.prepare('SELECT payload FROM workspace').get().payload);
  assert.deepEqual(after.state.projects,before.state.projects);assert.deepEqual(after.state.tasks,before.state.tasks);
});

test('legacy roles migrate once with credentials, sessions and project duties intact; the policy never re-elects',async t=>{
  const f=await fixture(t),owner=await f.signIn(),peer=await addAdmin(f,owner);
  const employee=await f.add(owner.cookie,'former-manager','u-manager');
  const legacy=f.stored();delete legacy.accountPolicyVersion;
  legacy.state.users.find(u=>u.id==='u-admin').role='admin';
  legacy.state.users.find(u=>u.id==='u-manager').role='manager';
  const beforeProjects=structuredClone(legacy.state.projects),beforeTasks=structuredClone(legacy.state.tasks);
  const credentials=f.db.sqlite.prepare('SELECT * FROM auth_credentials ORDER BY account_id').all();
  f.db.sqlite.prepare('UPDATE workspace SET payload = ?').run(JSON.stringify(legacy));
  await initializeLocalWorkspace(f.env);
  const migrated=f.stored();assert.equal(migrated.accountPolicyVersion,2);
  assert.equal(migrated.state.users.find(u=>u.id==='u-admin').role,'superadmin');
  assert.equal(migrated.state.users.find(u=>u.id==='u-manager').role,'member');
  assert.deepEqual(migrated.state.projects,beforeProjects);assert.deepEqual(migrated.state.tasks,beforeTasks);
  assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM auth_credentials ORDER BY account_id').all(),credentials);
  assert.equal((await f.call('/api/session',null,{cookie:owner.cookie})).data.account.role,'superadmin');
  const snapshot=f.stored();await initializeLocalWorkspace(f.env);assert.deepEqual(f.stored(),snapshot);
  snapshot.state.users.find(u=>u.id==='u-admin').role='member';
  f.db.sqlite.prepare('UPDATE workspace SET payload = ?').run(JSON.stringify(snapshot));
  await initializeLocalWorkspace(f.env);assert.ok(f.stored().state.users.every(u=>u.role!=='superadmin'));
  assert.equal((await f.call('/api/session',null,{cookie:peer.cookie})).data.account.role,'admin');
  await assert.rejects(recoverLocalAdmin(f.env,{login:'peer-admin',password:NEW_PASSWORD}),{code:'ADMIN_REQUIRED'});
});

test('retired manager and additional super administrator roles cannot be created or assigned',async t=>{
  const f=await fixture(t),owner=await f.signIn(),employee=await f.add(owner.cookie);
  const current=await f.call('/api/session',null,{cookie:owner.cookie});const before=f.stored();
  for(const role of ['manager','superadmin']){
    assert.equal((await f.call('/api/accounts',{revision:current.data.revision,login:'new-'+role,password:TEMP_PASSWORD,name:'不能新增',role},{cookie:owner.cookie})).status,400);
    assert.equal((await f.call(`/api/accounts/${employee.id}`,{revision:current.data.revision,role},{cookie:owner.cookie,method:'PATCH'})).status,400);
  }
  assert.deepEqual(f.stored(),before);
});
