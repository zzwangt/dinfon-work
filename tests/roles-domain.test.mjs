import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, normalizeState, transact } from '../public/client/domain.js';
import { sanitizeStateForActor, canAccessRoute } from '../public/client/access.js';
import { taskReminderSummary, approvalReminderSummary } from '../public/client/task-reminders.js';
import { buildWeeklyReport } from '../public/client/weekly-export.js';
import { workspacePayload } from '../server/notifications.mjs';

const get = (state, group, id) => state[group].find(item => item.id === id);
const seed = role => {
  const state = createSeedState();
  get(state, 'users', 'u-admin').role = role;
  return state;
};

test('legacy manager roles become employees without changing identities, project responsibilities, or schedules', () => {
  const old = createSeedState();
  for (const id of ['u-manager', 'u-ops']) get(old, 'users', id).role = 'manager';
  const before = structuredClone(old), normalized = normalizeState(old);
  for (const id of ['u-manager', 'u-ops']) {
    assert.equal(get(normalized, 'users', id).role, 'member');
    assert.equal(get(sanitizeStateForActor(old, id), 'users', id).role, 'member');
  }
  for (const group of ['projects', 'tasks', 'milestones', 'extensions', 'milestoneRequests', 'logs']) assert.deepEqual(normalized[group], before[group]);
  assert.deepEqual(old, before);
  assert.equal(get(normalized, 'users', 'u-admin').role, 'admin', 'domain normalization never elects a super administrator');
});

test('both administrative roles can assign any employee as project owner; an owner remains an employee', () => {
  const payload = { name: '独立分工项目', ownerId: 'u-engineer', memberIds: [], reviewerId: 'u-qa', startDate: '2099-01-01', dueDate: '2099-01-20' };
  for (const role of ['admin', 'superadmin']) {
    const next = transact(seed(role), 'createProject', payload, 'u-admin');
    const project = next.projects.at(-1);
    assert.equal(project.ownerId, 'u-engineer');
    assert.equal(get(next, 'users', 'u-engineer').role, 'member');
    assert.throws(() => transact(next, 'createProject', payload, 'u-engineer'), /仅管理员/);
    assert.equal(transact(next, 'setProjectReviewer', { id: project.id, reviewerId: null }, 'u-engineer').projects.at(-1).reviewerId, null);
    assert.equal(canAccessRoute(get(next, 'users', 'u-engineer'), 'accounts'), false);
  }
});

test('super administrators have global business visibility and maintenance routes, without automatic project approval', () => {
  const state = seed('superadmin'), project = get(state, 'projects', 'p-mower');
  project.reviewerId = 'u-qa';
  const scoped = sanitizeStateForActor(state, 'u-admin');
  assert.equal(scoped.projects.length, state.projects.length);
  assert.equal(canAccessRoute(get(state, 'users', 'u-admin'), 'settings'), true);
  assert.equal(canAccessRoute({ role: 'admin' }, 'settings'), false);
  for (const role of ['admin', 'superadmin']) for (const route of ['team', 'accounts', 'projects']) assert.equal(canAccessRoute({ role }, route), true);
  const pending = transact(state, 'requestMilestone', { projectId: project.id, kind: 'create', title: '待批准阶段', dueDate: project.dueDate }, 'u-engineer');
  assert.throws(() => transact(pending, 'reviewMilestoneRequest', { id: pending.milestoneRequests[0].id, approve: true }, 'u-admin'), /仅项目负责人或项目验收人/);
  assert.equal(transact(pending, 'reviewMilestoneRequest', { id: pending.milestoneRequests[0].id, approve: true }, 'u-manager').milestoneRequests[0].status, 'approved');
});

test('global task reminders and weekly exports treat both administrative roles equally', () => {
  const normal = seed('admin'), elevated = seed('superadmin');
  assert.deepEqual(taskReminderSummary(elevated, 'u-admin'), taskReminderSummary(normal, 'u-admin'));
  assert.deepEqual(approvalReminderSummary(elevated, 'u-admin'), approvalReminderSummary(normal, 'u-admin'));
  const options = { actorId: 'u-admin', range: { start: '2026-11-02', end: '2026-11-08' }, now: Date.parse('2026-11-03T12:00:00Z') };
  const ordinary = buildWeeklyReport(normal, options), total = buildWeeklyReport(elevated, options);
  assert.equal(total.scope, '全部项目');
  assert.deepEqual(total, ordinary);
});

test('business snapshots preserve the account-role migration marker and restrict legacy addUser role grants', () => {
  const state = seed('admin'), payload = { name: '新成员', title: '工程师', department: '研发', role: 'admin' };
  assert.throws(() => transact(state, 'addUser', payload, 'u-admin'), /总管理员/);
  assert.equal(transact(seed('superadmin'), 'addUser', payload, 'u-admin').users.at(-1).role, 'admin');
  assert.throws(() => transact(seed('superadmin'), 'addUser', { ...payload, role: 'superadmin' }, 'u-admin'), /角色无效/);
  assert.throws(() => transact(seed('superadmin'), 'addUser', { ...payload, role: 'manager' }, 'u-admin'), /角色无效/);
  assert.equal(JSON.parse(workspacePayload({ state, accounts: [], accountPolicyVersion: 2 })).accountPolicyVersion, 2);
});
