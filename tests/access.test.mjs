import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStateForActor, canAccessRoute } from '../public/client/access.js';
import { createSeedState } from '../public/client/domain.js';

const ids = (items) => items.map((item) => item.id).sort();

test('administrator receives all business records but never login/account metadata', () => {
  const state = createSeedState();
  state.accounts = [{ email: 'private@example.test', passwordHash: 'not-a-real-hash' }];
  state.sessions = [{ token: 'not-a-real-token' }];
  state.users[0].email = 'private@example.test';
  state.users[0].passwordHash = 'not-a-real-hash';
  state.users[0].login = { lastIp: '192.0.2.1' };
  const result = sanitizeStateForActor(state, 'u-admin');
  for (const collection of ['projects', 'milestones', 'tasks', 'extensions', 'milestoneRequests', 'logs']) {
    assert.deepEqual(result[collection], state[collection] ?? []);
  }
  assert.deepEqual(ids(result.users), ids(state.users));
  assert.deepEqual(Object.keys(result).sort(), ['version', 'users', 'projects', 'milestones', 'tasks', 'extensions', 'milestoneRequests', 'logs'].sort());
  assert.equal(result.users[0].email, undefined);
  assert.equal(result.users[0].passwordHash, undefined);
  assert.equal(result.users[0].login, undefined);
  assert.equal(result.users[0].name, state.users[0].name);
});

test('employee receives only assigned projects and their linked business records', () => {
  const state = createSeedState();
  state.logs.push({ id: 'global-user-log', actorId: 'u-admin', projectId: null, message: '后台账号操作' });
  const result = sanitizeStateForActor(state, 'u-design');
  assert.deepEqual(ids(result.projects), ['p-mower', 'p-site']);
  const allowedProjects = new Set(['p-mower', 'p-site']);
  for (const collection of ['milestones', 'tasks', 'extensions', 'logs']) {
    assert.deepEqual(ids(result[collection]), ids(state[collection].filter((record) => allowedProjects.has(record.projectId))));
  }
  assert.equal(result.logs.some((log) => log.id === 'global-user-log'), false);
});

test('manager role does not confer access to every project', () => {
  const state = createSeedState();
  const result = sanitizeStateForActor(state, 'u-ops');
  assert.deepEqual(ids(result.projects), ['p-delivery', 'p-site']);
  assert.ok(!result.tasks.some((task) => task.projectId === 'p-pcb' || task.projectId === 'p-mower'));
});

test('project owner retains access even if absent from memberIds', () => {
  const state = createSeedState();
  state.projects.find((project) => project.id === 'p-delivery').memberIds = [];
  assert.ok(sanitizeStateForActor(state, 'u-ops').projects.some((project) => project.id === 'p-delivery'));
});

test('referenced reviewer and log actor profiles are included without granting their other projects', () => {
  const state = createSeedState();
  state.users.push({ id: 'u-audit', name: '审计员', role: 'member', title: '审核', department: '审核', color: '#123456', email: 'hidden@example.test' });
  state.projects.push({ id: 'p-private-audit', ownerId: 'u-audit', memberIds: ['u-audit'] });
  state.logs.push({ id: 'audit-visible', actorId: 'u-audit', projectId: 'p-delivery', message: '可见项目的审核操作' });
  const result = sanitizeStateForActor(state, 'u-ops');
  assert.ok(result.extensions.some((extension) => extension.reviewerId === 'u-admin'));
  assert.ok(result.users.some((user) => user.id === 'u-admin'));
  assert.ok(result.users.some((user) => user.id === 'u-audit'));
  assert.ok(!result.projects.some((project) => project.id === 'p-private-audit'));
  assert.equal(result.users.find((user) => user.id === 'u-audit').email, undefined);
});

test('referenced task reviewers and applicants are retained while unrelated profiles are excluded', () => {
  const state = createSeedState();
  const profile = (id) => ({ id, name: id, role: 'member', title: '岗位', department: '部门', color: '#123456' });
  state.users.push(profile('external-reviewer'), profile('external-applicant'), profile('unrelated-user'));
  state.tasks.find((task) => task.projectId === 'p-site').reviewerId = 'external-reviewer';
  state.extensions.push({ id: 'external-request', projectId: 'p-site', applicantId: 'external-applicant', reviewerId: null });
  const result = sanitizeStateForActor(state, 'u-design');
  assert.ok(result.users.some((user) => user.id === 'external-reviewer'));
  assert.ok(result.users.some((user) => user.id === 'external-applicant'));
  assert.ok(!result.users.some((user) => user.id === 'unrelated-user'));
});

test('employee without assigned projects receives empty business collections and only their own profile', () => {
  const state = createSeedState();
  state.users.push({ id: 'u-new', name: '新员工', role: 'member', title: '岗位', department: '部门', color: '#123456' });
  const result = sanitizeStateForActor(state, 'u-new');
  assert.deepEqual(ids(result.users), ['u-new']);
  for (const collection of ['projects', 'milestones', 'tasks', 'extensions', 'milestoneRequests', 'logs']) assert.deepEqual(result[collection], []);
});

test('node applications are project scoped and include only safe applicant and reviewer profiles', () => {
  const state = createSeedState();
  state.users.push(
    { id: 'historic-applicant', name: '原申请人', role: 'member', title: '研发', department: '产品', email: 'hidden-applicant@example.test', authId: 'secret-subject' },
    { id: 'node-reviewer', name: '节点审批员', role: 'admin', title: '管理', department: '运营', email: 'hidden-reviewer@example.test' },
    { id: 'unrelated-applicant', name: '无关申请人', role: 'member', email: 'hidden-unrelated@example.test' },
  );
  state.milestoneRequests = [
    { id: 'mr-visible', projectId: 'p-pcb', kind: 'create', applicantId: 'historic-applicant', reviewerId: 'node-reviewer', status: 'approved', proposed: { title: '新增验证', dueDate: '2026-10-25', weight: 15 } },
    { id: 'mr-hidden', projectId: 'p-delivery', kind: 'update', applicantId: 'unrelated-applicant', reviewerId: 'node-reviewer', status: 'pending' },
  ];
  const result = sanitizeStateForActor(state, 'u-engineer');
  assert.deepEqual(ids(result.milestoneRequests), ['mr-visible']);
  assert.ok(result.users.some((user) => user.id === 'historic-applicant'));
  assert.ok(result.users.some((user) => user.id === 'node-reviewer'));
  assert.ok(!result.users.some((user) => user.id === 'unrelated-applicant'));
  for (const user of result.users) { assert.equal(user.email, undefined); assert.equal(user.authId, undefined); }
  assert.deepEqual(ids(sanitizeStateForActor(state, 'u-admin').milestoneRequests), ['mr-hidden', 'mr-visible']);
  result.milestoneRequests[0].proposed.title = 'changed locally';
  assert.equal(state.milestoneRequests[0].proposed.title, '新增验证');
});

test('legacy v1 data returns an empty node application collection without changing records', () => {
  const state = createSeedState();
  delete state.milestoneRequests;
  const before = structuredClone(state);
  for (const actorId of ['u-admin', 'u-engineer']) {
    const result = sanitizeStateForActor(state, actorId);
    assert.deepEqual(result.milestoneRequests, []);
    assert.ok(result.projects.length > 0);
  }
  assert.deepEqual(state, before);
  state.milestoneRequests = { unexpected: true };
  assert.throws(() => sanitizeStateForActor(state, 'u-admin'), /节点申请数据结构/);
});

test('invalid identities and unrecognized roles fail closed', () => {
  const state = createSeedState();
  assert.throws(() => sanitizeStateForActor(state, ''), /请先登录/);
  assert.throws(() => sanitizeStateForActor(state, 'not-a-user'), /账号不存在/);
  state.users.push({ id: 'u-invalid', role: 'superadmin' });
  assert.throws(() => sanitizeStateForActor(state, 'u-invalid'), /有效访问角色/);
  assert.throws(() => sanitizeStateForActor({ version: 1, users: [] }, 'u-admin'), /业务数据结构/);
});

test('sanitized snapshots have no mutable references into server state', () => {
  const state = createSeedState();
  const original = structuredClone(state);
  const admin = sanitizeStateForActor(state, 'u-admin');
  const employee = sanitizeStateForActor(state, 'u-ops');
  admin.users[0].name = 'changed';
  admin.projects[0].memberIds.push('changed');
  employee.projects[0].description = 'changed';
  employee.extensions[0].affectedTasks[0].newDueDate = '2099-01-01';
  assert.deepEqual(state, original);
});

test('employee and manager route policies exclude global administration', () => {
  for (const role of ['member', 'manager']) {
    for (const route of ['overview', 'projects', 'projects/p-mower', '#projects/p-mower', '/projects/p-mower', 'tasks', 'weekly', 'approvals', 'my-account']) {
      assert.equal(canAccessRoute({ role }, route), true, `${role}: ${route}`);
    }
    for (const route of ['dashboard', '#dashboard', 'accounts', 'accounts/new', 'team', 'settings', 'unknown', 'my-accounting']) {
      assert.equal(canAccessRoute({ role }, route), false, `${role}: ${route}`);
    }
  }
});

test('administrator routes are allowed and unauthenticated or malformed route requests are denied', () => {
  for (const route of ['dashboard', 'accounts', 'accounts/new', 'team', 'settings', 'my-account', 'projects/p-mower']) {
    assert.equal(canAccessRoute({ role: 'admin' }, route), true);
  }
  for (const actor of [null, undefined, {}, { role: 'superadmin' }]) {
    assert.equal(canAccessRoute(actor, 'overview'), false);
  }
  for (const route of ['', ' ', '/', '#', null, undefined, {}, ['projects']]) {
    assert.equal(canAccessRoute({ role: 'admin' }, route), false);
  }
});
