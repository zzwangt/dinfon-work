import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApi } from '../server/service.mjs';

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
  assert.equal(owner.data.account.role, 'admin');
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
  assert.equal(f.stored().state.users.find((u) => u.id === 'u-admin').role, 'admin');
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
  await provision(f, MANAGER, 'u-manager', 'manager');
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
  return { projectId: project.id, kind: 'create', title: '补充接口验证', dueDate: project.dueDate, weight: 15, reason: '增加接口可靠性验证，保证交付前完成', ...extra };
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
    payload: nodeProposal(staff.data, { kind: 'update', milestoneId: existing.id, title: '样板联调与接口验证完成', dueDate: existing.dueDate, weight: existing.weight }),
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const application = response.data.state.milestoneRequests[0];
  assert.deepEqual(application.before, { title: existing.title, dueDate: existing.dueDate, weight: existing.weight, status: existing.status });
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
  assert.equal(forged.data.code, 'ADMIN_REQUIRED');
  assert.deepEqual(f.stored(), pending);
});

test('no role can bypass node approval through the former direct-create command', async (t) => {
  const f = fixture(t);
  await provision(f, ENGINEER, 'u-engineer');
  await provision(f, MANAGER, 'u-manager', 'manager');
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
  f.db.sqlite.prepare('UPDATE workspace SET payload = ? WHERE id = ?').run(JSON.stringify({ state: legacy.state, accounts: legacy.accounts }), 'main');
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
