import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/sqlite.mjs';
import { handleApi, handleHttpApi, initializeLocalWorkspace } from '../server/service.mjs';
import { initializeAuthSchema, hashPassword } from '../server/auth.mjs';
import { addDays } from '../public/client/domain.js';

const ORIGIN = 'https://notifications.example';
const ADMIN = { userId: 'auth-admin', email: 'admin@example.com', displayName: '管理员' };
const ENGINEER = { userId: 'auth-engineer', email: 'engineer@example.com', displayName: '工程师' };
const MANAGER = { userId: 'auth-manager', email: 'manager@example.com', displayName: '负责人' };
const OTHER = { userId: 'auth-other', email: 'other@example.com', displayName: '其他项目成员' };

async function fixture(t, filename = ':memory:') {
  let db = openDatabase(filename);
  t.after(() => db.close());
  const env = { DB: db, FIRST_ADMIN_EMAIL: ADMIN.email };
  const call = async (path, identity = ADMIN, data, method = data ? 'POST' : 'GET', headers = {}) => {
    const request = new Request(`${ORIGIN}${path}`, {
      method, headers: { ...(data ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...headers },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    const response = await handleApi(request, env, identity);
    return { status: response.status, data: await response.json() };
  };
  const session = async (identity = ADMIN) => {
    const result = await call('/api/session', identity);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const command = async (identity, action, payload) => {
    const current = await session(identity);
    const result = await call('/api/command', identity, { revision: current.revision, action, payload });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  const clear = async (identity = ADMIN) => {
    const current = await session(identity);
    const result = await call('/api/notifications/read', identity, { ids: current.notifications.map((entry) => entry.id) });
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.notifications, []);
  };
  const provision = async (identity, existingUserId, role) => {
    const current = await session();
    const result = await call('/api/accounts', ADMIN, { revision: current.revision, email: identity.email, name: identity.displayName, existingUserId, role });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    await session(identity);
    return result.data.accounts.find((entry) => entry.email === identity.email);
  };
  await session();
  const engineer = await provision(ENGINEER, 'u-engineer', 'member');
  await provision(MANAGER, 'u-manager', 'manager');
  const other = await provision(OTHER, 'u-ops', 'manager');
  for (const identity of [ADMIN, ENGINEER, MANAGER, OTHER]) await clear(identity);
  return {
    call, session, command, clear, engineer, other,
    get db() { return db; },
    stored: () => JSON.parse(db.sqlite.prepare('SELECT payload FROM workspace WHERE id = ?').get('main').payload),
    reopen() { db.close(); db = openDatabase(filename); env.DB = db; },
  };
}

test('task lifecycle notifies only relevant accounts, deduplicates roles and excludes its operator', async (t) => {
  const f = await fixture(t);
  await f.command(ENGINEER, 'updateTask', { id: 't-07', status: 'todo' });
  await f.command(ENGINEER, 'updateTask', { id: 't-07', status: 'doing' });
  assert.deepEqual((await f.session(ENGINEER)).notifications, []);
  const started = (await f.session(MANAGER)).notifications;
  assert.equal(started.filter((entry) => entry.action === 'updateTask').length, 2);
  assert.equal(started[0].title, '任务已开始：联调电机控制接口');
  await f.command(ENGINEER, 'submitTask', { id: 't-07', deliverable: '私密交付正文，不应复制到通知' });
  const reviewer = (await f.session(MANAGER)).notifications.filter((entry) => entry.action === 'submitTask');
  assert.equal(reviewer.length, 1, 'same reviewer and project owner receive one event');
  assert.deepEqual({ category: reviewer[0].category, projectId: reviewer[0].projectId, entityId: reviewer[0].entityId, target: reviewer[0].target },
    { category: 'tasks', projectId: 'p-pcb', entityId: 't-07', target: '#tasks' });
  assert.equal((await f.session()).notifications.filter((entry) => entry.action === 'submitTask').length, 1);
  assert.deepEqual((await f.session(OTHER)).notifications, []);
  assert.equal(JSON.stringify(reviewer).includes('私密交付正文'), false);
  assert.equal('accountId' in reviewer[0], false);

  await f.command(MANAGER, 'reviewTask', { id: 't-07', approve: false, comment: '私密退回意见' });
  let owner = (await f.session(ENGINEER)).notifications;
  assert.equal(owner.length, 1);
  assert.match(owner[0].title, /退回修改/);
  assert.equal(JSON.stringify(owner).includes('私密退回意见'), false);
  await f.clear(ENGINEER);
  await f.command(ENGINEER, 'submitTask', { id: 't-07', deliverable: '再次交付' });
  await f.command(MANAGER, 'reviewTask', { id: 't-07', approve: true });
  owner = (await f.session(ENGINEER)).notifications;
  assert.equal(owner.length, 1);
  assert.match(owner[0].title, /验收通过/);
  assert.equal((await f.session(ENGINEER)).state.tasks.find((task) => task.id === 't-07').status, 'done');
});

test('node requests and decisions notify admin/applicant and publish approved changes to current project members', async (t) => {
  const f = await fixture(t);
  const project = (await f.session()).state.projects.find((entry) => entry.id === 'p-pcb');
  const requested = await f.command(ENGINEER, 'requestMilestone', { projectId: project.id, kind: 'create', title: '通知验收节点', dueDate: project.dueDate, reason: '申请正文不复制到通知' });
  const request = requested.state.milestoneRequests[0];
  assert.deepEqual(requested.notifications, []);
  const pending = (await f.session()).notifications;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].category, 'approvals');
  assert.equal(pending[0].entityId, request.id);
  assert.equal(pending[0].target, '#approvals');
  assert.equal((await f.session(MANAGER)).notifications.length, 0, 'managers cannot approve milestone requests');
  assert.equal(JSON.stringify(pending).includes('申请正文'), false);
  await f.clear();
  const approved = await f.command(ADMIN, 'reviewMilestoneRequest', { id: request.id, approve: true, comment: '' });
  assert.deepEqual(approved.notifications, []);
  const applicant = (await f.session(ENGINEER)).notifications;
  assert.equal(applicant.length, 1, 'applicant does not get a second project copy');
  assert.equal(applicant[0].category, 'approvals');
  assert.match(applicant[0].title, /已批准/);
  assert.equal((await f.session(MANAGER)).notifications[0].category, 'projects');
  assert.deepEqual((await f.session(OTHER)).notifications, []);

  await f.clear(ENGINEER);
  const node = approved.state.milestones.find((entry) => entry.title === '通知验收节点');
  const taskState = await f.command(ADMIN, 'createTask', { projectId: project.id, milestoneId: node.id, ownerId: 'u-engineer', reviewerId: 'u-manager', title: '节点交付任务', dueDate: project.dueDate, acceptance: '成果完整' });
  const task = taskState.state.tasks.find((entry) => entry.title === '节点交付任务');
  assert.equal((await f.session(ENGINEER)).notifications[0].action, 'createTask');
  await f.command(ENGINEER, 'submitTask', { id: task.id, deliverable: '成果' });
  await f.command(MANAGER, 'reviewTask', { id: task.id, approve: true });
  await f.clear(ENGINEER);
  await f.command(MANAGER, 'completeMilestone', { id: node.id });
  const completed = (await f.session(ENGINEER)).notifications;
  assert.equal(completed.length, 1);
  assert.equal(completed[0].entityId, node.id);
  assert.equal(completed[0].target, '#projects/p-pcb');
  assert.match(completed[0].title, /大节点已完成/);
});

test('extension request/decision notifications preserve approval and project categories', async (t) => {
  const f = await fixture(t);
  const project = (await f.session()).state.projects.find((entry) => entry.id === 'p-mower');
  const requested = await f.command(MANAGER, 'requestExtension', { projectId: project.id, newDueDate: addDays(project.dueDate, 7), reason: '', plan: '安排后续验证', impact: '相关任务延续' });
  const request = requested.state.extensions[0];
  const pending = (await f.session()).notifications[0];
  assert.equal(pending.category, 'approvals');
  assert.equal(pending.entityId, request.id);
  await f.command(ADMIN, 'reviewExtension', { id: request.id, approve: true, comment: '' });
  const manager = (await f.session(MANAGER)).notifications;
  assert.equal(manager.length, 1);
  assert.equal(manager[0].category, 'approvals');
  assert.match(manager[0].title, /延期申请已批准/);
  const engineer = (await f.session(ENGINEER)).notifications;
  assert.equal(engineer.length, 1);
  assert.equal(engineer[0].category, 'projects');
  assert.match(engineer[0].title, /截止时间已调整/);
});

test('joining an existing project notifies the employee and removed membership hides all project notices', async (t) => {
  const f = await fixture(t);
  const current = await f.session();
  const original = current.state.projects.filter((project) => project.memberIds.includes('u-ops')).map((project) => project.id);
  const joined = await f.call(`/api/accounts/${f.other.id}`, ADMIN, { revision: current.revision, projectIds: [...original, 'p-pcb'] }, 'PATCH');
  assert.equal(joined.status, 200);
  const newcomer = (await f.session(OTHER)).notifications;
  assert.equal(newcomer.length, 1);
  assert.match(newcomer[0].title, /你已加入项目/);
  assert.equal(newcomer[0].projectId, 'p-pcb');
  assert.equal((await f.session(ENGINEER)).notifications[0].action, 'accountMemberships');
  const fresh = await f.session();
  const removed = await f.call(`/api/accounts/${f.other.id}`, ADMIN, { revision: fresh.revision, projectIds: original }, 'PATCH');
  assert.equal(removed.status, 200);
  assert.deepEqual((await f.session(OTHER)).notifications, []);
  const hidden = await f.call('/api/notifications/read', OTHER, { ids: [newcomer[0].id] });
  assert.equal(hidden.status, 200);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM notification_reads WHERE account_id = ? AND notification_id = ?').get(f.other.id, newcomer[0].id).count, 0);
});

test('read receipts are per-account, idempotent, survive reopening and do not change business revision', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dinfon-notifications-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(t, join(dir, 'test.sqlite'));
  await f.command(ENGINEER, 'submitTask', { id: 't-07', deliverable: '成果' });
  const admin = await f.session();
  const manager = await f.session(MANAGER);
  const ownId = admin.notifications[0].id;
  const otherId = manager.notifications[0].id;
  const acknowledged = await f.call('/api/notifications/read', ADMIN, { ids: [ownId, otherId, 'unknown-id'], revision: 1, accountId: f.other.id });
  assert.equal(acknowledged.status, 200);
  assert.deepEqual(acknowledged.data, { notifications: [] });
  assert.equal((await f.session()).revision, admin.revision);
  assert.equal((await f.session(MANAGER)).notifications[0].id, otherId);
  assert.equal((await f.call('/api/notifications/read', ADMIN, { ids: [ownId] })).status, 200);
  f.reopen();
  assert.deepEqual((await f.session()).notifications, []);
  assert.equal((await f.session(MANAGER)).notifications[0].id, otherId);
  assert.equal((await f.session()).revision, admin.revision);
});

test('read acknowledgement races safely with new events and rejected/CAS-losing commands emit nothing', async (t) => {
  const f = await fixture(t);
  await f.command(ENGINEER, 'updateTask', { id: 't-07', status: 'todo' });
  const current = await f.session();
  const ids = current.notifications.map((entry) => entry.id);
  const [read, write] = await Promise.all([
    f.call('/api/notifications/read', ADMIN, { ids, revision: current.revision }),
    f.call('/api/command', ENGINEER, { revision: current.revision, action: 'submitTask', payload: { id: 't-07', deliverable: '成果' } }),
  ]);
  assert.equal(read.status, 200);
  assert.equal(write.status, 200);
  const latest = await f.session();
  assert.equal(latest.revision, current.revision + 1);
  assert.equal(latest.notifications.length, 1);
  assert.equal(latest.notifications[0].action, 'submitTask');
  const events = f.stored().notifications.length;
  const stale = await f.call('/api/command', MANAGER, { revision: current.revision, action: 'reviewTask', payload: { id: 't-07', approve: true } });
  assert.equal(stale.status, 409);
  const denied = await f.call('/api/command', ENGINEER, { revision: latest.revision, action: 'reviewTask', payload: { id: 't-07', approve: true } });
  assert.equal(denied.status, 400);
  assert.equal(f.stored().notifications.length, events);
});

test('old workspaces do not replay historical logs and notification reads require same-origin valid requests', async (t) => {
  const f = await fixture(t);
  const stored = f.stored();
  delete stored.notifications;
  f.db.sqlite.prepare('UPDATE workspace SET payload = ? WHERE id = ?').run(JSON.stringify(stored), 'main');
  assert(stored.state.logs.length > 0);
  assert.deepEqual((await f.session()).notifications, []);
  assert.equal('notifications' in f.stored(), false, 'reading must not rewrite business state');
  assert.equal((await f.call('/api/notifications/read', null, { ids: [] })).status, 401);
  assert.equal((await f.call('/api/notifications/read', ADMIN, { ids: [] }, 'POST', { Origin: 'https://attacker.example' })).status, 403);
  for (const ids of [null, 'all', [null], [{}], [1], ['x'.repeat(101)], Array(1001).fill('id')]) {
    assert.equal((await f.call('/api/notifications/read', ADMIN, { ids })).status, 400);
  }
});

test('cookie-authenticated login/session/command return notices, while temporary passwords cannot read them', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await initializeAuthSchema(db);
  const password = 'Notification owner password 2026';
  const temp = 'Temporary notification password 2026';
  const env = { DB: db, SITE_ORIGIN: ORIGIN, INITIAL_ADMIN_LOGIN: 'owner', INITIAL_ADMIN_PASSWORD_HASH: await hashPassword(password), SEED_DEMO_DATA: true };
  await initializeLocalWorkspace(env);
  const call = async (path, data, cookie, method = data ? 'POST' : 'GET') => {
    const response = await handleHttpApi(new Request(`${ORIGIN}${path}`, { method, headers: { ...(data ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('Set-Cookie')?.split(';')[0] };
  };
  const owner = await call('/api/auth/login', { login: 'owner', password });
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.data.notifications, []);
  const added = await call('/api/accounts', { revision: owner.data.revision, login: 'employee', password: temp, name: '工程师', role: 'member', existingUserId: 'u-engineer' }, owner.cookie);
  assert.equal(added.status, 201);
  assert.deepEqual(added.data.notifications, []);
  const employee = await call('/api/auth/login', { login: 'employee', password: temp });
  assert.equal(employee.status, 200);
  assert.equal('notifications' in employee.data, false);
  assert.equal((await call('/api/notifications/read', { ids: [] }, employee.cookie)).status, 403);
  const changed = await call('/api/auth/password', { currentPassword: temp, newPassword: 'New personal notification password 2026' }, employee.cookie);
  assert.equal(changed.status, 200);
  assert.equal(changed.data.notifications.length, 2);
  const acknowledged = await call('/api/notifications/read', { ids: changed.data.notifications.map((entry) => entry.id), revision: 1 }, changed.cookie);
  assert.deepEqual(acknowledged.data.notifications, []);
  const before = await call('/api/session', null, changed.cookie);
  const submitted = await call('/api/command', { revision: before.data.revision, action: 'submitTask', payload: { id: 't-07', deliverable: 'cookie workflow' } }, changed.cookie);
  assert.equal(submitted.status, 200);
  assert.deepEqual(submitted.data.notifications, []);
  const final = await call('/api/session', null, owner.cookie);
  assert.equal(final.data.notifications.length, 1);
  assert.equal(final.data.notifications[0].action, 'submitTask');
});
