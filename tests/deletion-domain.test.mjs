import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, transact, progressAgainstPlan } from '../public/client/domain.js';
import { appendNotifications, unreadNotifications } from '../server/notifications.mjs';
import { openDatabase } from '../server/sqlite.mjs';

const byId = (state, group, id) => state[group].find(item => item.id === id);
function fixture() {
  const state = createSeedState();
  state.users.push({ id: 'u-total', name: '总管理员', role: 'superadmin' });
  state.extensions.push(
    { id: 'pending-task', projectId: 'p-mower', status: 'pending', affectedTasks: [{ id: 't-03' }], affectedMilestones: [] },
    { id: 'pending-node', projectId: 'p-mower', status: 'pending', affectedTasks: [], affectedMilestones: [{ id: 'm-mower-2' }] },
    { id: 'past-task', projectId: 'p-mower', status: 'approved', affectedTasks: [{ id: 't-03' }], affectedMilestones: [] },
  );
  state.milestoneRequests.push(
    { id: 'pending-node-edit', projectId: 'p-mower', status: 'pending', milestoneId: 'm-mower-2' },
    { id: 'past-node-edit', projectId: 'p-mower', status: 'approved', milestoneId: 'm-mower-2' },
    { id: 'pending-node-create', projectId: 'p-mower', status: 'pending', milestoneId: null },
  );
  return state;
}

test('deletion is explicitly confirmed, limited to administrative roles, and project deletion is total-administrator only', () => {
  const state = fixture(), before = structuredClone(state);
  const targets = { deleteTask: 't-03', deleteMilestone: 'm-mower-2', deleteProject: 'p-mower' };
  for (const [action, id] of Object.entries(targets)) {
    for (const actor of ['u-manager', 'u-engineer']) assert.throws(() => transact(state, action, { id, confirm: true }, actor), /仅.*管理员/);
    for (const confirm of [undefined, false, 'true', 1]) assert.throws(() => transact(state, action, { id, confirm }, 'u-total'), /确认/);
    assert.throws(() => transact(state, action, { id, confirm: true, projectId: 'p-site' }, 'u-total'), /参数无效/);
    assert.throws(() => transact(state, action, { id: 'missing', confirm: true }, 'u-total'), /不存在/);
  }
  assert.throws(() => transact(state, 'deleteProject', { id: 'p-mower', confirm: true }, 'u-admin'), /仅总管理员/);
  assert.deepEqual(state, before);
});

test('deleting one task cancels only pending extensions referencing it and retains history, siblings and the milestone', () => {
  const state = fixture(), before = structuredClone(state), task = byId(state, 'tasks', 't-03');
  const next = transact(state, 'deleteTask', { id: task.id, confirm: true }, 'u-admin');
  assert.equal(next.tasks.length, state.tasks.length - 1);
  assert.equal(byId(next, 'tasks', task.id), undefined);
  assert.deepEqual(next.tasks, state.tasks.filter(item => item.id !== task.id));
  assert.deepEqual(next.milestones, state.milestones);
  assert.equal(byId(next, 'extensions', 'pending-task'), undefined);
  for (const id of ['pending-node', 'past-task', 'e-pending']) assert.ok(byId(next, 'extensions', id));
  assert.deepEqual(next.milestoneRequests, state.milestoneRequests);
  assert.deepEqual(next.logs[0].changes.tasks.before, [task]);
  assert.equal(next.logs[0].actorId, 'u-admin');
  assert.equal(next.logs[0].projectId, 'p-mower');
  assert.deepEqual(state, before);
});

test('deleting a milestone cascades its tasks, cancels dependent pending requests, and preserves other project progress', () => {
  const state = fixture(), children = state.tasks.filter(item => item.milestoneId === 'm-mower-2');
  for (const actor of ['u-admin', 'u-total']) {
    const next = transact(state, 'deleteMilestone', { id: 'm-mower-2', confirm: true }, actor);
    assert.equal(byId(next, 'milestones', 'm-mower-2'), undefined);
    assert.equal(next.tasks.some(task => task.milestoneId === 'm-mower-2'), false);
    assert.equal(next.tasks.length, state.tasks.length - children.length);
    for (const id of ['pending-task', 'pending-node']) assert.equal(byId(next, 'extensions', id), undefined);
    assert.equal(byId(next, 'milestoneRequests', 'pending-node-edit'), undefined);
    assert.ok(byId(next, 'extensions', 'past-task'));
    assert.ok(byId(next, 'milestoneRequests', 'past-node-edit'));
    assert.ok(byId(next, 'milestoneRequests', 'pending-node-create'));
    assert.deepEqual(next.tasks.filter(item => item.projectId !== 'p-mower'), state.tasks.filter(item => item.projectId !== 'p-mower'));
    assert.deepEqual(progressAgainstPlan(next.tasks.filter(item => item.projectId === 'p-pcb')), progressAgainstPlan(state.tasks.filter(item => item.projectId === 'p-pcb')));
    assert.deepEqual(next.logs[0].changes.tasks.before, children);
  }
});

test('deleting a project removes only its records and stores complete business history in a global audit entry', () => {
  const state = fixture(), before = structuredClone(state);
  const next = transact(state, 'deleteProject', { id: 'p-mower', confirm: true }, 'u-total');
  assert.equal(byId(next, 'projects', 'p-mower'), undefined);
  for (const group of ['tasks', 'milestones', 'extensions', 'milestoneRequests']) {
    assert.deepEqual(next[group], state[group].filter(item => item.projectId !== 'p-mower'));
    const removed = state[group].filter(item => item.projectId === 'p-mower');
    if (removed.length) assert.deepEqual(next.logs[0].changes[group].before, removed);
  }
  assert.equal(next.logs[0].projectId, null);
  assert.match(next.logs[0].message, /p-mower/);
  assert.deepEqual(next.logs[0].changes.project.before, byId(state, 'projects', 'p-mower'));
  assert.deepEqual(next.logs[0].changes.projectLogs.before, state.logs.filter(item => item.projectId === 'p-mower'));
  assert.deepEqual(next.logs.slice(1), state.logs.filter(item => item.projectId !== 'p-mower'));
  assert.deepEqual(next.users, state.users);
  assert.deepEqual(state, before);
});

test('deletion notifications reach original participants, suppress dead task links, and never notify unrelated employees', async t => {
  const state = fixture(), db = openDatabase(':memory:');t.after(() => db.close());
  const accounts = state.users.map(user => ({ id: `a-${user.id}`, userId: user.id, status: 'active' }));
  const account = id => accounts.find(item => item.userId === id);
  const previous = { state, accounts, notifications: [{ id: 'old-task', accountId: account('u-engineer').id, action: 'createTask', category: 'tasks', entityId: 't-03', projectId: 'p-mower' }] };
  const taskDeleted = appendNotifications(previous, { ...previous, state: transact(state, 'deleteTask', { id: 't-03', confirm: true }, 'u-admin') }, 'u-admin', 'deleteTask', { id: 't-03' });
  const taskNotices = await unreadNotifications(db, taskDeleted, account('u-engineer'), byId(state, 'users', 'u-engineer'));
  assert.equal(taskNotices.some(item => item.id === 'old-task'), false);
  assert.ok(taskNotices.some(item => item.action === 'deleteTask' && item.target === '#projects/p-mower'));
  const deleted = appendNotifications(previous, { ...previous, state: transact(state, 'deleteProject', { id: 'p-mower', confirm: true }, 'u-total') }, 'u-total', 'deleteProject', { id: 'p-mower' });
  const notices = await unreadNotifications(db, deleted, account('u-engineer'), byId(state, 'users', 'u-engineer'));
  assert.equal(notices.length, 1);assert.equal(notices[0].action, 'deleteProject');assert.equal(notices[0].target, '#overview');
  assert.deepEqual(await unreadNotifications(db, deleted, account('u-ops'), byId(state, 'users', 'u-ops')), []);
});
