import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApi } from '../server/service.mjs';
import { addDays } from '../public/client/domain.js';

const ORIGIN = 'https://management.example';
const ADMIN = { userId: 'auth-owner', email: 'owner@example.com', displayName: '平台负责人' };
const ENGINEER = { userId: 'auth-engineer', email: 'engineer@example.com', displayName: '工程师' };
const MANAGER = { userId: 'auth-manager', email: 'manager@example.com', displayName: '项目经理' };

function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../drizzle/0000_amusing_cerebro.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async first() { return statement.get(...params) || null; },
        async run() { const result = statement.run(...params); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
  };
}

function fixture(t, options = {}) {
  const db = database(t);
  const env = { DB: db, FIRST_ADMIN_EMAIL: ADMIN.email, ...options };
  const call = async (path, identity = ADMIN, data, method = data ? 'POST' : 'GET', extraHeaders = {}) => {
    const headers = { ...(data ? { 'Content-Type': 'application/json', Origin: ORIGIN } : {}), ...extraHeaders };
    for (const [key, value] of Object.entries(headers)) if (value == null) delete headers[key];
    const response = await handleApi(new Request(`${ORIGIN}${path}`, { method, headers, ...(data ? { body: JSON.stringify(data) } : {}) }), env, identity);
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const stored = () => {
    const row = db.sqlite.prepare('SELECT * FROM workspace WHERE id = ?').get('main');
    return row && { ...JSON.parse(row.payload), revision: row.revision };
  };
  return { call, stored, env, db };
}

async function provision(f, identity, userId, role = 'member') {
  const session = await f.call('/api/session');
  const created = await f.call('/api/accounts', ADMIN, { revision: session.data.revision, email: identity.email, name: identity.displayName, role, existingUserId: userId });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const signedIn = await f.call('/api/session', identity);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));
  return signedIn;
}

test('unauthenticated and unprovisioned callers cannot bootstrap or read company data', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call('/api/session', null)).status, 401);
  assert.equal((await f.call('/api/session', ENGINEER)).status, 403);
  assert.equal(f.stored(), undefined);
  const owner = await f.call('/api/session');
  assert.equal(owner.status, 200);
  assert.equal(owner.data.actor.id, 'u-admin');
  assert.equal(owner.data.actor.name, ADMIN.displayName);
  assert.equal(owner.data.account.role, 'superadmin');
  assert.equal(owner.data.state.projects.length, 4);
  assert.equal((await f.call('/api/session', ENGINEER)).data.code, 'ACCOUNT_NOT_PROVISIONED');
  assert.equal(owner.headers.get('Cache-Control'), 'no-store, private');
});

test('missing trusted owner configuration fails closed without first-user admin assignment', async (t) => {
  const f = fixture(t, { FIRST_ADMIN_EMAIL: undefined });
  const response = await f.call('/api/session');
  assert.equal(response.status, 503);
  assert.equal(response.data.code, 'SETUP_REQUIRED');
  assert.equal(f.stored(), undefined);
});

test('bootstrap never copies a hosting email fallback into shared business profiles', async (t) => {
  const f = fixture(t);
  const owner = await f.call('/api/session', { ...ADMIN, displayName: ADMIN.email });
  assert.equal(owner.status, 200);
  assert.equal(owner.data.actor.name, '管理员');
  assert.equal(JSON.stringify(owner.data.state).includes(ADMIN.email), false);
  const staff = await provision(f, ENGINEER, 'u-qa');
  assert.equal(staff.data.state.users.find((user) => user.id === 'u-admin').name, '管理员');
  assert.equal(JSON.stringify(staff.data.state).includes(ADMIN.email), false);
});

test('simultaneous owner bootstrap creates exactly one workspace and one admin binding', async (t) => {
  const f = fixture(t);
  const results = await Promise.all([f.call('/api/session'), f.call('/api/session')]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal(f.stored().accounts.length, 1);
  assert.equal(f.stored().accounts[0].authId, ADMIN.userId);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM workspace').get().count, 1);
});

test('staff sign-in binds a stable identity and returns only assigned projects without auth records', async (t) => {
  const f = fixture(t);
  const signedIn = await provision(f, ENGINEER, 'u-engineer');
  assert.equal(signedIn.data.actor.id, 'u-engineer');
  assert.equal(signedIn.data.capabilities.manageAllData, false);
  assert.equal(signedIn.data.capabilities.manageAccounts, false);
  assert.deepEqual(signedIn.data.state.projects.map((p) => p.id).sort(), ['p-mower', 'p-pcb']);
  assert(signedIn.data.state.tasks.every((task) => ['p-mower', 'p-pcb'].includes(task.projectId)));
  assert(signedIn.data.state.logs.every((log) => ['p-mower', 'p-pcb'].includes(log.projectId)));
  assert.equal(JSON.stringify(signedIn.data).includes('auth-engineer'), false);
  assert.equal(Object.hasOwn(signedIn.data.state, 'accounts'), false);
  assert.equal(f.stored().accounts.find((account) => account.userId === 'u-engineer').authId, ENGINEER.userId);
  const denied = await f.call('/api/accounts', ENGINEER);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'ADMIN_REQUIRED');
});

test('unbound staff must finish session binding before sending any commands', async (t) => {
  const f = fixture(t);
  const owner = await f.call('/api/session');
  const created = await f.call('/api/accounts', ADMIN, { revision: owner.data.revision, email: ENGINEER.email, name: ENGINEER.displayName, role: 'member', existingUserId: 'u-engineer' });
  const response = await f.call('/api/command', ENGINEER, { revision: created.data.revision, action: 'updateTask', payload: { id: 't-07', status: 'todo' } });
  assert.equal(response.status, 403);
  assert.equal(response.data.code, 'SESSION_REQUIRED');
  assert.equal(f.stored().accounts.find((a) => a.userId === 'u-engineer').authId, null);
});

test('an already bound email cannot be rebound to another authenticated subject', async (t) => {
  const f = fixture(t);
  await provision(f, ENGINEER, 'u-engineer');
  assert.equal((await f.call('/api/session', { ...ENGINEER, email: 'ENGINEER@EXAMPLE.COM' })).status, 200);
  const impostor = await f.call('/api/session', { ...ENGINEER, userId: 'auth-other' });
  assert.equal(impostor.status, 403);
  assert.equal(impostor.data.code, 'IDENTITY_MISMATCH');
  const changedEmail = await f.call('/api/session', { ...ENGINEER, email: 'someone-else@example.com' });
  assert.equal(changedEmail.status, 403);
  assert.equal(f.stored().accounts.find((a) => a.userId === 'u-engineer').authId, ENGINEER.userId);
});

test('forged actor and state in command bodies cannot elevate staff privileges', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const denied = await f.call('/api/command', ENGINEER, { revision: staff.data.revision, actorId: 'u-admin', action: 'reviewExtension', payload: { id: 'e-pending', approve: true, comment: 'forged', actorId: 'u-admin' }, state: { users: [{ id: 'u-engineer', role: 'admin' }] } });
  assert.equal(denied.status, 403);
  const own = await f.call('/api/command', ENGINEER, { revision: staff.data.revision, actorId: 'u-admin', action: 'updateTask', payload: { id: 't-07', status: 'todo', actorId: 'u-admin' } });
  assert.equal(own.status, 200);
  assert.equal(own.data.actor.role, 'member');
  assert.equal(f.stored().state.logs[0].actorId, 'u-engineer');
  assert.equal(own.data.state.projects.length, 2);
});

test('employee commands cannot target unrelated projects even with known task IDs', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const before = f.stored();
  const result = await f.call('/api/command', ENGINEER, { revision: staff.data.revision, action: 'submitTask', payload: { id: 't-13', deliverable: 'forged deliverable' } });
  assert.equal(result.status, 404);
  assert.deepEqual(f.stored(), before);
});

test('cross-origin or missing-origin writes fail without modifying data', async (t) => {
  const f = fixture(t);
  const owner = await f.call('/api/session');
  const command = { revision: owner.data.revision, action: 'updateTask', payload: { id: 't-07', status: 'todo' } };
  const before = f.stored();
  for (const origin of [null, 'https://attacker.example', 'null']) {
    const result = await f.call('/api/command', ADMIN, command, 'POST', { Origin: origin });
    assert.equal(result.status, 403);
    assert.equal(result.data.code, 'ORIGIN_REJECTED');
  }
  assert.deepEqual(f.stored(), before);
});

test('compare-and-swap permits one concurrent edit and preserves the other as a conflict', async (t) => {
  const f = fixture(t);
  const owner = await f.call('/api/session');
  const before = f.stored();
  const results = await Promise.all(['todo', 'doing'].map((status) => f.call('/api/command', ADMIN, {
    revision: owner.data.revision, action: 'updateTask', payload: { id: 't-07', status },
  })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(results.find((r) => r.status === 409).data.code, 'REVISION_CONFLICT');
  const after = f.stored();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.state.logs.length, before.state.logs.length + 1);
  const saved = results.find((r) => r.status === 200);
  assert.equal(after.state.tasks.find((task) => task.id === 't-07').status, saved.data.state.tasks.find((task) => task.id === 't-07').status);
});

test('disabled accounts immediately lose both reads and writes; reactivation retains identity binding', async (t) => {
  const f = fixture(t);
  await provision(f, ENGINEER, 'u-engineer');
  const accounts = await f.call('/api/accounts');
  const account = accounts.data.accounts.find((a) => a.userId === 'u-engineer');
  const disabled = await f.call(`/api/accounts/${account.id}`, ADMIN, { revision: accounts.data.revision, status: 'disabled' }, 'PATCH');
  assert.equal(disabled.status, 200);
  assert.equal((await f.call('/api/session', ENGINEER)).data.code, 'ACCOUNT_DISABLED');
  const command = await f.call('/api/command', ENGINEER, { revision: disabled.data.revision, action: 'updateTask', payload: { id: 't-07', status: 'todo' } });
  assert.equal(command.status, 403);
  const enabled = await f.call(`/api/accounts/${account.id}`, ADMIN, { revision: disabled.data.revision, status: 'active' }, 'PATCH');
  assert.equal(enabled.status, 200);
  assert.equal((await f.call('/api/session', ENGINEER)).status, 200);
  assert.equal(f.stored().accounts.find((a) => a.id === account.id).authId, ENGINEER.userId);
});

test('current admin cannot disable or demote their own account', async (t) => {
  const f = fixture(t);
  const owner = await f.call('/api/session');
  for (const change of [{ role: 'member' }, { status: 'disabled' }]) {
    const response = await f.call(`/api/accounts/${owner.data.account.id}`, ADMIN, { revision: owner.data.revision, ...change }, 'PATCH');
    assert.equal(response.status, 400);
    assert.equal(response.data.code, 'SELF_LOCKOUT');
  }
  assert.equal(f.stored().revision, owner.data.revision);
  assert.equal(f.stored().accounts[0].status, 'active');
  assert.equal(f.stored().state.users.find((u) => u.id === 'u-admin').role, 'superadmin');
});

test('hosted regular administrators cannot modify peers; the super administrator manages them', async (t) => {
  const f=fixture(t);
  await provision(f,ENGINEER,'u-engineer','admin');
  await provision(f,MANAGER,'u-manager','admin');
  const listed=await f.call('/api/accounts',ENGINEER);
  const peer=listed.data.accounts.find(a=>a.userId==='u-manager');
  const owner=listed.data.accounts.find(a=>a.userId==='u-admin');
  const before=f.stored();
  for(const target of [peer,owner]){
    assert.equal((await f.call(`/api/accounts/${target.id}`,ENGINEER,{revision:listed.data.revision,status:'disabled'},'PATCH')).status,403);
    assert.equal((await f.call(`/api/accounts/${target.id}`,ENGINEER,{revision:listed.data.revision},'DELETE')).status,403);
  }
  assert.equal((await f.call('/api/accounts',ENGINEER,{revision:listed.data.revision,email:'another-admin@example.com',name:'新管理员',role:'admin'})).status,403);
  assert.deepEqual(f.stored(),before);
  const removed=await f.call(`/api/accounts/${peer.id}`,ADMIN,{revision:listed.data.revision},'DELETE');
  assert.equal(removed.status,200);assert.equal((await f.call('/api/session',MANAGER)).status,403);
  for(const key of ['users','projects','tasks','milestones','extensions','milestoneRequests'])assert.deepEqual(f.stored().state[key],before.state[key]);
});

test('staff cannot provision accounts; duplicate email and duplicate business-user bindings are rejected', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const candidate = { revision: staff.data.revision, email: 'new@example.com', name: '新成员', role: 'admin' };
  assert.equal((await f.call('/api/accounts', ENGINEER, candidate)).status, 403);
  assert.equal((await f.call('/api/accounts', ADMIN, { ...candidate, email: 'ENGINEER@EXAMPLE.COM' })).status, 400);
  assert.equal((await f.call('/api/accounts', ADMIN, { ...candidate, existingUserId: 'u-engineer' })).status, 400);
  assert.equal(f.stored().accounts.length, 2);
  assert.equal(f.stored().revision, staff.data.revision);
});

test('admin account lists expose useful status without returning authentication subjects', async (t) => {
  const f = fixture(t);
  await provision(f, MANAGER, 'u-manager', 'member');
  const result = await f.call('/api/accounts');
  assert.equal(result.status, 200);
  assert.equal(result.data.accounts.length, 2);
  assert.equal(result.data.users.length, 6);
  assert.equal(JSON.stringify(result.data).includes('auth-manager'), false);
  assert.equal(JSON.stringify(result.data).includes('authId'), false);
  assert.equal(result.data.accounts.find((a) => a.userId === 'u-manager').linked, true);
});

test('business command endpoint cannot create users or replace the workspace', async (t) => {
  const f = fixture(t);
  const owner = await f.call('/api/session');
  const before = f.stored();
  for (const action of ['addUser', 'reset', 'importState']) {
    const response = await f.call('/api/command', ADMIN, { revision: owner.data.revision, action, payload: { name: 'Injected', role: 'admin' } });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(f.stored(), before);
});

test('extension approval persists adjusted dates and original baseline atomically', async (t) => {
  const f = fixture(t);
  const owner = await f.call('/api/session');
  const before = owner.data.state.projects.find((project) => project.id === 'p-pcb');
  const result = await f.call('/api/command', ADMIN, { revision: owner.data.revision, action: 'reviewExtension', payload: { id: 'e-pending', approve: true, comment: '按新计划完成' } });
  assert.equal(result.status, 200);
  const state = f.stored().state;
  const project = state.projects.find((p) => p.id === 'p-pcb');
  const extension = state.extensions.find((e) => e.id === 'e-pending');
  assert.equal(project.originalDueDate, before.originalDueDate);
  assert.equal(project.dueDate, extension.newDueDate);
  assert.equal(extension.status, 'approved');
  for (const change of extension.affectedTasks) assert.equal(state.tasks.find((task) => task.id === change.id).dueDate, change.newDueDate);
  for (const change of extension.affectedMilestones) assert.equal(state.milestones.find((m) => m.id === change.id).dueDate, change.newDueDate);
});

test('stale account changes and identity reassignment fail without partial updates', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const account = f.stored().accounts.find((a) => a.userId === 'u-engineer');
  const before = f.stored();
  const stale = await f.call(`/api/accounts/${account.id}`, ADMIN, { revision: staff.data.revision - 1, status: 'disabled' }, 'PATCH');
  assert.equal(stale.status, 409);
  const rebind = await f.call(`/api/accounts/${account.id}`, ADMIN, { revision: staff.data.revision, status: 'active', authId: 'other' }, 'PATCH');
  assert.equal(rebind.status, 400);
  assert.equal(rebind.data.code, 'IMMUTABLE_IDENTITY');
  assert.deepEqual(f.stored(), before);
});

function nodeProposal(session, extra = {}) {
  const project = session.state.projects.find((entry) => entry.id === 'p-pcb');
  return { projectId: project.id, kind: 'create', title: '补充接口验证', dueDate: project.dueDate, reason: '增加接口可靠性验证，保证交付前完成', ...extra };
}

test('staff node applications stay pending without changing live nodes until an admin approves', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const beforeNodes = structuredClone(f.stored().state.milestones);
  const response = await f.call('/api/command', ENGINEER, {
    revision: staff.data.revision, action: 'requestMilestone', actorId: 'u-admin',
    payload: { ...nodeProposal(staff.data), status: 'approved', applicantId: 'u-admin', reviewerId: 'u-admin' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const application = response.data.state.milestoneRequests[0];
  assert.equal(application.status, 'pending');
  assert.equal(application.applicantId, 'u-engineer');
  assert.equal(application.reviewerId, null);
  assert.equal(application.before, null);
  assert.deepEqual(f.stored().state.milestones, beforeNodes);
  const admin = await f.call('/api/session');
  assert.equal(admin.data.state.milestoneRequests.find((entry) => entry.id === application.id).status, 'pending');
  const approved = await f.call('/api/command', ADMIN, { revision: admin.data.revision, action: 'reviewMilestoneRequest', payload: { id: application.id, approve: true, comment: '验证范围明确，同意加入项目计划' } });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const saved = f.stored();
  assert.equal(saved.state.milestones.length, beforeNodes.length + 1);
  assert.equal(saved.state.milestoneRequests.find((entry) => entry.id === application.id).status, 'approved');
  assert.equal(saved.state.milestoneRequests.find((entry) => entry.id === application.id).reviewerId, 'u-admin');
  const newNode = saved.state.milestones.find((node) => !beforeNodes.some((old) => old.id === node.id));
  assert.equal(newNode.title, application.proposed.title);
  assert.equal(newNode.projectId, 'p-pcb');
  assert.equal(Object.hasOwn(newNode, 'weight'), false);
  assert.equal(Object.hasOwn(application.proposed, 'weight'), false);
  const refreshedStaff = await f.call('/api/session', ENGINEER);
  assert.ok(refreshedStaff.data.state.milestones.some((node) => node.id === newNode.id));
  assert.equal(refreshedStaff.data.state.milestoneRequests[0].status, 'approved');
});

test('node update requests preserve the original plan while pending or rejected', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const existing = staff.data.state.milestones.find((node) => node.id === 'm-pcb-2');
  const response = await f.call('/api/command', ENGINEER, {
    revision: staff.data.revision, action: 'requestMilestone',
    payload: nodeProposal(staff.data, { kind: 'update', milestoneId: existing.id, title: '样板联调与接口验证完成', dueDate: existing.dueDate }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const application = response.data.state.milestoneRequests[0];
  assert.deepEqual(application.before, { title: existing.title, dueDate: existing.dueDate, status: existing.status });
  assert.deepEqual(f.stored().state.milestones.find((node) => node.id === existing.id), existing);
  const rejected = await f.call('/api/command', ADMIN, { revision: response.data.revision, action: 'reviewMilestoneRequest', payload: { id: application.id, approve: false, comment: '先完成原有联调范围，本次调整退回' } });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(rejected.data.state.milestoneRequests.find((entry) => entry.id === application.id).status, 'rejected');
  assert.deepEqual(f.stored().state.milestones.find((node) => node.id === existing.id), existing);
});

test('nonmembers cannot request nodes and forged admin identity cannot approve a request', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const before = f.stored();
  const nonmember = await f.call('/api/command', ENGINEER, { revision: staff.data.revision, action: 'requestMilestone', actorId: 'u-admin', payload: nodeProposal(staff.data, { projectId: 'p-site' }) });
  assert.equal(nonmember.status, 404);
  assert.deepEqual(f.stored(), before);
  const requested = await f.call('/api/command', ENGINEER, { revision: staff.data.revision, action: 'requestMilestone', payload: nodeProposal(staff.data) });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));
  const pending = f.stored();
  const forged = await f.call('/api/command', ENGINEER, { revision: requested.data.revision, action: 'reviewMilestoneRequest', actorId: 'u-admin', payload: { id: requested.data.state.milestoneRequests[0].id, approve: true, comment: '伪造管理账号', actorId: 'u-admin', role: 'admin' } });
  assert.equal(forged.status, 403);
  assert.equal(forged.data.code, 'PROJECT_APPROVER_REQUIRED');
  assert.deepEqual(f.stored(), pending);
});

test('no role can bypass node approval through the former direct-create command', async (t) => {
  const f = fixture(t);
  await provision(f, ENGINEER, 'u-engineer');
  await provision(f, MANAGER, 'u-manager', 'member');
  const before = f.stored();
  for (const identity of [ADMIN, ENGINEER, MANAGER]) {
    const session = await f.call('/api/session', identity);
    const denied = await f.call('/api/command', identity, { revision: session.data.revision, action: 'createMilestone', payload: nodeProposal(session.data) });
    assert.equal(denied.status, 400);
    assert.equal(denied.data.code, 'INVALID_INPUT');
  }
  assert.deepEqual(f.stored(), before);
});

test('disabled employees cannot submit nodes and their pending requests cannot be approved', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const requested = await f.call('/api/command', ENGINEER, { revision: staff.data.revision, action: 'requestMilestone', payload: nodeProposal(staff.data) });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));
  const application = requested.data.state.milestoneRequests[0];
  const account = f.stored().accounts.find((entry) => entry.userId === 'u-engineer');
  const disabled = await f.call(`/api/accounts/${account.id}`, ADMIN, { revision: requested.data.revision, status: 'disabled' }, 'PATCH');
  assert.equal(disabled.status, 200);
  const before = f.stored();
  const deniedRequest = await f.call('/api/command', ENGINEER, { revision: disabled.data.revision, action: 'requestMilestone', payload: nodeProposal(staff.data) });
  assert.equal(deniedRequest.status, 403);
  assert.equal(deniedRequest.data.code, 'ACCOUNT_DISABLED');
  const deniedApproval = await f.call('/api/command', ADMIN, { revision: disabled.data.revision, action: 'reviewMilestoneRequest', payload: { id: application.id, approve: true, comment: '批准' } });
  assert.equal(deniedApproval.status, 400);
  assert.equal(deniedApproval.data.code, 'APPLICANT_DISABLED');
  assert.deepEqual(f.stored(), before);
  const rejected = await f.call('/api/command', ADMIN, { revision: disabled.data.revision, action: 'reviewMilestoneRequest', payload: { id: application.id, approve: false, comment: '申请人账号已停用，请由有效成员重新提交' } });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(rejected.data.state.milestoneRequests.find((entry) => entry.id === application.id).status, 'rejected');
});

test('concurrent node applications never silently overwrite each other', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const beforeNodes = structuredClone(f.stored().state.milestones);
  const results = await Promise.all(['接口验证甲', '接口验证乙'].map((title) => f.call('/api/command', ENGINEER, { revision: staff.data.revision, action: 'requestMilestone', payload: nodeProposal(staff.data, { title }) })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(f.stored().state.milestoneRequests.length, 1);
  assert.equal(f.stored().revision, staff.data.revision + 1);
  assert.deepEqual(f.stored().state.milestones, beforeNodes);
});

test('concurrent approvals create exactly one live node and one approved record', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const requested = await f.call('/api/command', ENGINEER, { revision: staff.data.revision, action: 'requestMilestone', payload: nodeProposal(staff.data) });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));
  const beforeNodes = f.stored().state.milestones.length;
  const data = { revision: requested.data.revision, action: 'reviewMilestoneRequest', payload: { id: requested.data.state.milestoneRequests[0].id, approve: true, comment: '加入正式计划' } };
  const results = await Promise.all([f.call('/api/command', ADMIN, data), f.call('/api/command', ADMIN, data)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(f.stored().state.milestones.length, beforeNodes + 1);
  assert.equal(f.stored().state.milestoneRequests.filter((entry) => entry.status === 'approved').length, 1);
});

test('existing v1 workspaces receive an empty request list without reset or read-time persistence', async (t) => {
  const f = fixture(t);
  await provision(f, ENGINEER, 'u-engineer');
  const legacy = f.stored();
  delete legacy.state.milestoneRequests;
  f.db.sqlite.prepare('UPDATE workspace SET payload = ? WHERE id = ?').run(JSON.stringify({ state: legacy.state, accounts: legacy.accounts, accountPolicyVersion: 2 }), 'main');
  const oldSnapshot = f.stored();
  const staff = await f.call('/api/session', ENGINEER);
  const owner = await f.call('/api/session');
  assert.equal(staff.status, 200);
  assert.equal(owner.status, 200);
  assert.deepEqual(staff.data.state.milestoneRequests, []);
  assert.deepEqual(owner.data.state.milestoneRequests, []);
  assert.deepEqual(f.stored(), oldSnapshot);
  const requested = await f.call('/api/command', ENGINEER, { revision: staff.data.revision, action: 'requestMilestone', payload: nodeProposal(staff.data) });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));
  const saved = f.stored();
  assert.equal(saved.state.milestoneRequests.length, 1);
  assert.deepEqual(saved.state.projects, legacy.state.projects);
  assert.deepEqual(saved.state.milestones, legacy.state.milestones);
  assert.deepEqual(saved.state.tasks, legacy.state.tasks);
  assert.deepEqual(saved.accounts, legacy.accounts);
});

test('legacy blocked tasks normalize on API reads without rewriting storage or exposing other projects', async (t) => {
  const f = fixture(t);
  await provision(f, ENGINEER, 'u-engineer');
  const legacy = f.stored();
  const own = legacy.state.tasks.find((task) => task.id === 't-03');
  own.status = 'blocked';
  own.blocker = '历史原因：等待物料';
  legacy.state.tasks.find((task) => task.id === 't-13').status = 'blocked';
  legacy.state.milestones[0].weight = 999;
  f.db.sqlite.prepare('UPDATE workspace SET payload = ? WHERE id = ?').run(JSON.stringify({ state: legacy.state, accounts: legacy.accounts, accountPolicyVersion: 2 }), 'main');
  const before = f.stored();
  const staff = await f.call('/api/session', ENGINEER);
  const admin = await f.call('/api/session');
  assert.equal(staff.status, 200);
  assert.equal(admin.status, 200);
  assert.equal(staff.data.state.tasks.find((task) => task.id === own.id).status, 'doing');
  assert.equal(staff.data.state.tasks.find((task) => task.id === own.id).blocker, own.blocker);
  assert.ok(!staff.data.state.tasks.some((task) => task.id === 't-13'));
  assert.ok(admin.data.state.tasks.every((task) => task.status !== 'blocked'));
  assert.deepEqual(admin.data.state.milestones, legacy.state.milestones);
  assert.deepEqual(admin.data.state.extensions, legacy.state.extensions);
  assert.deepEqual(f.stored(), before);
});

test('legacy blocked tasks submit normally and new blocked writes fail without persisting migration', async (t) => {
  const f = fixture(t);
  await provision(f, ENGINEER, 'u-engineer');
  const legacy = f.stored();
  const task = legacy.state.tasks.find((entry) => entry.id === 't-03');
  task.status = 'blocked';
  task.blocker = '历史原因：等待物料';
  f.db.sqlite.prepare('UPDATE workspace SET payload = ? WHERE id = ?').run(JSON.stringify({ state: legacy.state, accounts: legacy.accounts, accountPolicyVersion: 2 }), 'main');
  const before = f.stored();
  for (const payload of [{ status: 'blocked' }, { blocker: '新原因' }]) {
    const rejected = await f.call('/api/command', ENGINEER, { revision: before.revision, action: 'updateTask', payload: { id: task.id, ...payload } });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.code, 'COMMAND_REJECTED');
    assert.match(rejected.data.error, /受阻功能已移除/);
    assert.deepEqual(f.stored(), before);
  }
  const submitted = await f.call('/api/command', ENGINEER, { revision: before.revision, action: 'submitTask', payload: { id: task.id, deliverable: '物料已到，完成测试' } });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  const saved = f.stored();
  assert.equal(saved.state.tasks.find((entry) => entry.id === task.id).status, 'review');
  assert.equal(saved.state.tasks.find((entry) => entry.id === task.id).blocker, task.blocker);
  assert.deepEqual(saved.state.projects, legacy.state.projects);
  assert.deepEqual(saved.state.milestones, legacy.state.milestones);
  assert.deepEqual(saved.state.extensions, legacy.state.extensions);
  assert.equal(saved.revision, before.revision + 1);
});

test('legacy weighted node approval keeps audit fields without reactivating weights or overwriting data', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const target = staff.data.state.milestones.find((node) => node.id === 'm-pcb-2');
  const requested = await f.call('/api/command', ENGINEER, {
    revision: staff.data.revision, action: 'requestMilestone',
    payload: nodeProposal(staff.data, { kind: 'update', milestoneId: target.id, title: `${target.title}与复核`, dueDate: target.dueDate }),
  });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));
  const legacy = f.stored();
  const application = legacy.state.milestoneRequests[0];
  application.before.weight = 40;
  application.proposed.weight = 60;
  legacy.state.milestones.find((node) => node.id === target.id).weight = 90;
  f.db.sqlite.prepare('UPDATE workspace SET payload = ? WHERE id = ?').run(JSON.stringify({ state: legacy.state, accounts: legacy.accounts, accountPolicyVersion: 2 }), 'main');
  const approved = await f.call('/api/command', ADMIN, {
    revision: legacy.revision, action: 'reviewMilestoneRequest', payload: { id: application.id, approve: true, comment: '按调整后的验收范围执行' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const saved = f.stored();
  const actual = saved.state.milestones.find((node) => node.id === target.id);
  assert.equal(actual.title, application.proposed.title);
  assert.equal(actual.weight, 90);
  assert.equal(actual.originalDueDate, target.originalDueDate);
  assert.deepEqual(saved.state.milestoneRequests[0].before, application.before);
  assert.deepEqual(saved.state.milestoneRequests[0].proposed, application.proposed);
  assert.deepEqual(saved.state.tasks, legacy.state.tasks);
  assert.deepEqual(saved.state.extensions, legacy.state.extensions);
});

test('hour-level plans pass through server approval with exact times, scoped permissions and original dates', async (t) => {
  const f = fixture(t);
  await provision(f, MANAGER, 'u-manager');
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const submitted = await f.call('/api/command', ADMIN, {
    revision: staff.data.revision, action: 'createProject',
    payload: { name: '小时排期项目', ownerId: 'u-manager', memberIds: ['u-engineer'], startDate: '2099-10-25T09:00', dueDate: '2099-10-25T18:00' },
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  const created = await f.call('/api/command', MANAGER, {
    revision: submitted.data.revision, action: 'reviewProjectPlan',
    payload: {id: submitted.data.state.projectPlans[0].id, approve:true},
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const project = created.data.state.projects.at(-1);
  const requested = await f.call('/api/command', ENGINEER, {
    revision: created.data.revision, action: 'requestMilestone',
    payload: { projectId: project.id, kind: 'create', title: '下午交付', dueDate: '2099-10-25T17:00', reason: '明确交付时间' },
  });
  assert.equal(requested.status, 200, JSON.stringify(requested.data));
  assert.equal(requested.data.state.milestones.some((node) => node.projectId === project.id), false);
  const approved = await f.call('/api/command', ADMIN, {
    revision: requested.data.revision, action: 'reviewMilestoneRequest', payload: { id: requested.data.state.milestoneRequests[0].id, approve: true, comment: '按小时交付' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const node = approved.data.state.milestones.find((item) => item.projectId === project.id);
  assert.equal(node.dueDate, '2099-10-25T17:00');
  assert.equal(node.originalDueDate, node.dueDate);
  const taskInput = { projectId: project.id, milestoneId: node.id, ownerId: 'u-engineer', reviewerId: 'u-manager', title: '小时任务', dueDate: '2099-10-25T16:00', acceptance: '提交完整成果' };
  const taskCreated = await f.call('/api/command', ENGINEER, { revision: approved.data.revision, action: 'createTask', payload: taskInput });
  assert.equal(taskCreated.status, 200, JSON.stringify(taskCreated.data));
  const task = taskCreated.data.state.tasks.at(-1);
  assert.equal(task.dueDate, taskInput.dueDate);
  assert.equal(task.originalDueDate, taskInput.dueDate);
  const refreshed = await f.call('/api/session', ENGINEER);
  assert.ok(refreshed.data.state.projects.some((entry) => entry.id === project.id));
  assert.ok(!refreshed.data.state.projects.some((entry) => entry.id === 'p-site'));
  assert.equal(refreshed.data.state.tasks.find((entry) => entry.id === task.id).dueDate, taskInput.dueDate);
});

test('concurrent hourly applications still use CAS instead of losing a submitted time', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const project = staff.data.state.projects.find((entry) => entry.id === 'p-pcb');
  const before = f.stored();
  const results = await Promise.all(['17:00', '18:00'].map((hour) => f.call('/api/command', ENGINEER, {
    revision: staff.data.revision, action: 'requestMilestone',
    payload: nodeProposal(staff.data, { title: `交付时间${hour}`, dueDate: `${project.dueDate}T${hour}` }),
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const saved = f.stored();
  assert.equal(saved.state.milestoneRequests.length, 1);
  assert.match(saved.state.milestoneRequests[0].proposed.dueDate, /T(17|18):00$/);
  assert.equal(saved.revision, staff.data.revision + 1);
  assert.deepEqual(saved.state.projects, before.state.projects);
  assert.deepEqual(saved.state.milestones, before.state.milestones);
  assert.deepEqual(saved.state.tasks, before.state.tasks);
});

test('submission timestamps always come from the server clock despite client-provided backdating', async (t) => {
  const f = fixture(t);
  const staff = await provision(f, ENGINEER, 'u-engineer');
  const earliest = Date.now();
  const submitted = await f.call('/api/command', ENGINEER, {
    revision: staff.data.revision, action: 'submitTask',
    payload: { id: 't-07', deliverable: '交付成果', submittedAt: '1990-01-01T00:00:00Z', reviewedAt: '1990-01-01T00:00:00Z', status: 'done' },
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  const task = f.stored().state.tasks.find((entry) => entry.id === 't-07');
  assert.equal(task.status, 'review');
  assert.equal(task.reviewedAt, null);
  assert.ok(Date.parse(task.submittedAt) >= earliest);
  assert.ok(Date.parse(task.submittedAt) <= Date.now());
});

test('API enforces a distinct designated reviewer through delivery and acceptance while preserving scope and state checks', async (t) => {
  const f = fixture(t);
  await provision(f, ENGINEER, 'u-engineer');
  await provision(f, MANAGER, 'u-manager', 'member');
  const command = (identity, action, payload) => f.call('/api/command', identity, { revision: f.stored().revision, action, payload });
  const node = f.stored().state.milestones.find((item) => item.id === 'm-mower-2');
  const created = await command(ADMIN, 'createTask', {
    projectId: node.projectId, milestoneId: node.id, title: '本人交付并验收', ownerId: 'u-engineer',
    reviewerId: 'u-manager', dueDate: node.dueDate, acceptance: '提交可复核的测试报告',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const taskId = created.data.state.tasks.at(-1).id;
  const task = () => f.stored().state.tasks.find((item) => item.id === taskId);
  const premature = await command(MANAGER, 'reviewTask', { id: taskId, approve: true });
  assert.equal(premature.status, 400);
  assert.match(premature.data.error, /仅待验收任务/);
  assert.equal(task().status, 'todo');
  const started = await command(ENGINEER, 'updateTask', { id: taskId, status: 'doing' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(task().status, 'doing');
  const submitted = await command(ENGINEER, 'submitTask', { id: taskId, deliverable: '测试报告 V1' });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  assert.equal(task().status, 'review');
  assert.ok(!submitted.data.state.projects.some((project) => project.id === 'p-site'));
  const beforeDenied = f.stored();
  const wrongReviewer = await command(ENGINEER, 'reviewTask', { id: taskId, approve: true });
  assert.equal(wrongReviewer.status, 400);
  assert.match(wrongReviewer.data.error, /验收自己|指定验收人/);
  const outsideScope = await command(ENGINEER, 'reviewTask', { id: 't-13', approve: true });
  assert.equal(outsideScope.status, 404);
  const blankReturn = await command(MANAGER, 'reviewTask', { id: taskId, approve: false });
  assert.equal(blankReturn.status, 400);
  assert.match(blankReturn.data.error, /退回原因/);
  assert.deepEqual(f.stored(), beforeDenied);
  const returned = await command(MANAGER, 'reviewTask', { id: taskId, approve: false, comment: '补齐复测数据' });
  assert.equal(returned.status, 200, JSON.stringify(returned.data));
  assert.equal(task().status, 'doing');
  const resubmitted = await command(ENGINEER, 'submitTask', { id: taskId, deliverable: '测试报告 V2，附复测数据' });
  assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.data));
  const approved = await command(MANAGER, 'reviewTask', { id: taskId, approve: true });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(task().status, 'done');
  assert.notEqual(task().ownerId, task().reviewerId);
  assert.equal(task().reviewCount, 2);
  assert.equal(task().firstReviewPassed, false);
  assert.ok(task().submittedAt && task().reviewedAt);
  assert.equal(approved.data.actor.role, 'member');
});

test('API persists blank reasons and opinions for node creation/update approval and rejection', async (t) => {
  for (const kind of ['create', 'update']) for (const approve of [true, false]) {
    const f = fixture(t);
    const staff = await provision(f, ENGINEER, 'u-engineer');
    const node = staff.data.state.milestones.find(item => item.id === 'm-pcb-2');
    const beforeNodes = structuredClone(f.stored().state.milestones);
    const request = await f.call('/api/command', ENGINEER, {
      revision: staff.data.revision, action: 'requestMilestone',
      payload: nodeProposal(staff.data, {
        kind, title: '无需原因的阶段调整', reason: undefined,
        ...(kind === 'update' ? { milestoneId: node.id, dueDate: node.dueDate } : {}),
      }),
    });
    assert.equal(request.status, 200, JSON.stringify(request.data));
    const application = request.data.state.milestoneRequests[0];
    assert.equal(application.reason, '');
    assert.deepEqual(f.stored().state.milestones, beforeNodes);
    const reviewed = await f.call('/api/command', ADMIN, {
      revision: request.data.revision, action: 'reviewMilestoneRequest', payload: { id: application.id, approve },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    const stored = f.stored().state;
    const saved = stored.milestoneRequests.find(item => item.id === application.id);
    assert.equal(saved.status, approve ? 'approved' : 'rejected');
    assert.equal(saved.reason, '');
    assert.equal(saved.comment, '');
    assert.equal(saved.reviewerId, 'u-admin');
    assert.ok(saved.reviewedAt);
    assert.doesNotMatch(stored.logs[0].message, /[；;]\s*$/);
    if (!approve) assert.deepEqual(stored.milestones, beforeNodes);
    else if (kind === 'create') assert.equal(stored.milestones.length, beforeNodes.length + 1);
    else assert.equal(stored.milestones.find(item => item.id === node.id).title, application.proposed.title);
  }
});

test('API persists blank extension reason and approval opinions without changing pending or rejected deadlines', async (t) => {
  for (const approve of [true, false]) {
    const f = fixture(t);
    const manager = await provision(f, MANAGER, 'u-manager', 'member');
    const project = manager.data.state.projects.find(item => item.id === 'p-mower');
    const newDueDate = addDays(project.dueDate, 1);
    const request = await f.call('/api/command', MANAGER, {
      revision: manager.data.revision, action: 'requestExtension',
      payload: { projectId: project.id, newDueDate, reason: null, plan: '追加复测后交付', impact: '项目截止顺延一天' },
    });
    assert.equal(request.status, 200, JSON.stringify(request.data));
    const extension = request.data.state.extensions[0];
    assert.equal(extension.reason, '');
    assert.equal(f.stored().state.projects.find(item => item.id === project.id).dueDate, project.dueDate);
    const reviewed = await f.call('/api/command', ADMIN, {
      revision: request.data.revision, action: 'reviewExtension', payload: { id: extension.id, approve, comment: ' \n\t ' },
    });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    const stored = f.stored().state;
    const saved = stored.extensions.find(item => item.id === extension.id);
    assert.equal(saved.status, approve ? 'approved' : 'rejected');
    assert.equal(saved.reason, '');
    assert.equal(saved.comment, '');
    assert.equal(saved.reviewerId, 'u-admin');
    assert.ok(saved.reviewedAt);
    const updated = stored.projects.find(item => item.id === project.id);
    assert.equal(updated.originalDueDate, project.originalDueDate);
    assert.equal(updated.dueDate, approve ? newDueDate : project.dueDate);
    assert.doesNotMatch(stored.logs[0].message, /[；;]\s*$/);
  }
});

test('one project plan defers every node and assignment until an authorized reviewer approves once', async t => {
  const f = fixture(t);
  await provision(f, MANAGER, 'u-manager');
  await provision(f, ENGINEER, 'u-engineer');
  const other = {userId:'unrelatedadmin',email:'unrelatedadmin@example.com',displayName:'其他管理员'};
  await provision(f, other, 'u-ops', 'admin');
  const cmd = async (identity, action, payload, revision = f.stored().revision) =>
    f.call('/api/command', identity, {action, revision, payload});
  const makeTask = title => ({title,ownerId:'u-engineer',reviewerId:'u-manager',dueDate:'2099-10-15T10:00',acceptance:'可验收成果'});
  const plan = {name:'多阶段立项', ownerId:'u-manager',memberIds:['u-engineer'],startDate:'2099-10-01',dueDate:'2099-11-01',
    stages:['设计','测试'].map(title => ({title,description:'预期交付',dueDate:'2099-10-20T18:00',tasks:[makeTask(title+' 1'),makeTask(title+' 2')]}))};
  const previous = f.stored();
  const invalid = structuredClone(plan);
  invalid.stages[1].tasks[1].dueDate = '2099-10-23';
  assert.equal((await cmd(ADMIN,'createProject',invalid)).status,400);
  assert.deepEqual(f.stored(),previous);
  const submission = await cmd(ADMIN,'createProject',plan);
  assert.equal(submission.status,200);
  const request = submission.data.state.projectPlans[0], id = request.id;
  assert.equal(request.tasks.length,4);
  for (const key of ['projects','milestones','tasks']) assert.deepEqual(f.stored().state[key],previous.state[key]);
  assert.equal((await f.call('/api/session', ENGINEER)).data.state.projectPlans.length,0);
  assert.equal((await f.call('/api/session', MANAGER)).data.notifications.some(n=>n.entityId===id),true);
  assert.equal((await cmd(other,'reviewProjectPlan',{id,approve:true})).status,404);
  assert.equal((await cmd(ENGINEER,'reviewProjectPlan',{id,approve:true})).status,404);
  const decisions=await Promise.all([1,2].map(()=>cmd(MANAGER,'reviewProjectPlan',{id,approve:true},submission.data.revision)));
  assert.deepEqual(decisions.map(r=>r.status).sort(),[200,409]);
  const staff=(await f.call('/api/session', ENGINEER)).data;
  assert.equal(staff.state.projects.filter(p=>p.id===request.projectId).length,1);
  assert.equal(staff.state.milestones.filter(m=>m.projectId===request.projectId).length,2);
  const tasks=staff.state.tasks.filter(t=>t.projectId===request.projectId);
  assert.equal(tasks.length,4);
  assert.ok(tasks.every(t=>t.createdBy==='u-admin'&&t.status==='todo'&&staff.notifications.some(n=>n.entityId===t.id)));
  assert.equal((await cmd(MANAGER,'reviewProjectPlan',{id,approve:true})).status,400);
  const repeat=await cmd(ADMIN,'createProject',plan), second=repeat.data.state.projectPlans[0];
  const rejected=await cmd(MANAGER,'reviewProjectPlan',{id:second.id,approve:false,comment:'调整时间'});
  assert.equal(rejected.data.state.projectPlans[0].status,'rejected');
  assert.ok(!f.stored().state.projects.some(p=>p.id===second.projectId));
});

test('a collaborative plan notifies both workers and requires each task and stage signature',async t=>{
  const f=fixture(t);
  const qa={userId:'auth-qa-multi',email:'qa-multi@example.com',displayName:'验收员'};
  const design={userId:'auth-design-multi',email:'design-multi@example.com',displayName:'设计员'};
  const extra={userId:'auth-extra-multi',email:'extra-multi@example.com',displayName:'加验甲'};
  const second={userId:'auth-second-multi',email:'second-multi@example.com',displayName:'加验乙'};
  for(const [account,id,role] of [[MANAGER,'u-manager'],[ENGINEER,'u-engineer'],[qa,'u-qa'],[design,'u-design'],[extra,'u-ops','admin'],[second,undefined,'admin']])await provision(f,account,id,role);
  const secondId=(await f.call('/api/session',second)).data.actor.id;
  async function cmd(who,action,payload,code=200,revision=f.stored().revision) {
    const res=await f.call('/api/command',who,{action,payload,revision});
    assert.equal(res.status,code,JSON.stringify(res.data.error));return res.data;
  }
  const task={title:'联调',ownerId:'u-engineer',memberIds:['u-design'],reviewerId:'u-qa',extraReviewerIds:['u-manager'],dueDate:'2099-04-10',acceptance:'实现预期'};
  const stage={title:'阶段甲',dueDate:'2099-04-12',memberIds:['u-design','u-engineer'],coReviewerId:'u-ops',extraReviewerIds:[secondId],tasks:[task]};
  const body={name:'多人验证',ownerId:'u-manager',memberIds:['u-engineer','u-qa','u-design'],startDate:'2099-04-01',dueDate:'2099-04-30',stages:[stage]};
  await cmd(ADMIN,'createProject',{...body,stages:[{...stage,tasks:[{...task,extraReviewerIds:['u-design']}]}]},400);
  const pending=(await cmd(ADMIN,'createProject',body)).state.projectPlans[0];
  const live=await cmd(MANAGER,'reviewProjectPlan',{id:pending.id,approve:true});
  const id=live.state.tasks.at(-1).id,mid=live.state.milestones.at(-1).id;
  for(const worker of [design,ENGINEER])assert.ok((await f.call('/api/session',worker)).data.notifications.some(n=>n.entityId===id&&n.category==='tasks'));
  const partial=await cmd(design,'submitTask',{id,deliverable:'设计成果'});
  assert.equal(partial.state.tasks.at(-1).status,'doing');
  assert.equal(partial.state.tasks.at(-1).submittedAt,null);
  await cmd(qa,'reviewTask',{id,approve:true},400);
  await cmd(design,'submitTask',{id,deliverable:'重复提交'},400);
  await cmd(ADMIN,'submitTask',{id,deliverable:'代交'},400);
  await cmd(ENGINEER,'submitTask',{id,deliverable:'联调记录'});
  await cmd(design,'reviewTask',{id,approve:true},400);
  let result=await cmd(qa,'reviewTask',{id,approve:true});
  assert.equal(result.state.tasks.at(-1).status,'review');
  assert.ok((await f.call('/api/session',MANAGER)).data.notifications.some(n=>n.entityId===id&&n.action==='submitTask'));
  await cmd(qa,'reviewTask',{id,approve:true},400);
  await cmd(MANAGER,'completeMilestone',{id:mid},400);
  result=await cmd(MANAGER,'reviewTask',{id,approve:false,comment:'补测试'});
  assert.equal(result.state.tasks.at(-1).status,'doing');
  assert.equal(result.state.tasks.at(-1).deliveryHistory[0].deliveries.length,2);
  assert.deepEqual(result.state.tasks.at(-1).deliveries,[]);
  await cmd(ENGINEER,'submitTask',{id,deliverable:'第二次交付'});
  await cmd(design,'submitTask',{id,deliverable:'修改后的设计'});
  await cmd(MANAGER,'reviewTask',{id,approve:true});
  result=await cmd(qa,'reviewTask',{id,approve:true});
  assert.equal(result.state.tasks.at(-1).status,'done');
  assert.deepEqual(result.state.tasks.at(-1).reviewSignatures.map(s=>s.actorId),['u-manager','u-qa']);
  await cmd(extra,'completeMilestone',{id:mid});
  await cmd(extra,'completeMilestone',{id:mid},400);
  await cmd(design,'completeMilestone',{id:mid},400);
  assert.equal((await cmd(second,'completeMilestone',{id:mid})).state.milestones.at(-1).status,'pending');
  assert.equal((await cmd(MANAGER,'completeMilestone',{id:mid})).state.milestones.at(-1).status,'done');
});
