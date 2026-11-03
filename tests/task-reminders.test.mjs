import test from 'node:test';
import assert from 'node:assert/strict';
import { taskReminderSummary } from '../public/client/task-reminders.js';

function fixture() {
  return {
    users: [
      { id: 'admin', role: 'admin' },
      { id: 'lead', role: 'manager' },
      { id: 'worker', role: 'member' },
      { id: 'peer', role: 'member' },
      { id: 'outsider', role: 'member' },
    ],
    projects: [
      { id: 'shared', ownerId: 'lead', memberIds: ['worker', 'peer'] },
      { id: 'outside', ownerId: 'outsider', memberIds: ['outsider'] },
      { id: 'empty', ownerId: 'lead', memberIds: ['worker'] },
    ],
    tasks: [
      { id: 'todo', projectId: 'shared', ownerId: 'worker', reviewerId: 'lead', status: 'todo' },
      { id: 'doing', projectId: 'shared', ownerId: 'worker', reviewerId: 'lead', status: 'doing' },
      { id: 'submitted', projectId: 'shared', ownerId: 'worker', reviewerId: 'lead', status: 'review' },
      { id: 'accepted', projectId: 'shared', ownerId: 'worker', reviewerId: 'lead', status: 'done' },
      { id: 'peer-review', projectId: 'shared', ownerId: 'peer', reviewerId: 'worker', status: 'review' },
      { id: 'peer-todo', projectId: 'shared', ownerId: 'peer', reviewerId: 'lead', status: 'todo' },
      { id: 'external', projectId: 'outside', ownerId: 'worker', reviewerId: 'worker', status: 'review' },
      { id: 'orphan', projectId: 'removed-project', ownerId: 'worker', reviewerId: 'worker', status: 'todo' },
    ],
  };
}

test('personal reminders include unfinished assigned work and distinguish actionable reviews', () => {
  const state = fixture();
  const summary = taskReminderSummary(state, 'worker');
  assert.deepEqual(summary.ownedTaskIds, ['todo', 'doing', 'submitted']);
  assert.deepEqual(summary.reviewTaskIds, ['peer-review']);
  assert.deepEqual(summary.taskIds, ['todo', 'doing', 'submitted', 'peer-review']);
  assert.equal(summary.count, 4);
  assert.equal(summary.ownedCount, 3);
  assert.equal(summary.reviewCount, 1);
  assert.equal(summary.pendingCount, 5);
  assert.deepEqual(summary.projectCounts, { shared: 5, empty: 0 });
});

test('viewing or marking notifications read does not clear unfinished work', () => {
  const state = fixture();
  state.notifications = [{ id: 'notice', category: 'tasks', entityId: 'todo' }];
  const before = taskReminderSummary(state, 'worker');
  state.notifications = [];
  state.notificationReads = ['notice'];
  assert.deepEqual(taskReminderSummary(state, 'worker'), before);
});

test('start, submit and rejection preserve reminders; acceptance removes them and reopening restores them', () => {
  const state = fixture();
  const task = state.tasks.find(item => item.id === 'todo');
  for (const status of ['todo', 'doing', 'review', 'doing', 'blocked']) {
    task.status = status;
    assert.ok(taskReminderSummary(state, 'worker').taskIds.includes(task.id), status);
  }
  task.status = 'done';
  assert.equal(taskReminderSummary(state, 'worker').taskIds.includes(task.id), false);
  assert.equal(taskReminderSummary(state, 'worker').projectCounts.shared, 4);
  task.status = 'doing';
  assert.ok(taskReminderSummary(state, 'worker').taskIds.includes(task.id));
  assert.equal(taskReminderSummary(state, 'worker').projectCounts.shared, 5);
});

test('project reminders are limited to currently accessible projects even when task ownership lingers', () => {
  const state = fixture();
  let summary = taskReminderSummary(state, 'worker');
  assert.equal(summary.pendingTaskIds.includes('external'), false);
  assert.equal(summary.pendingTaskIds.includes('orphan'), false);
  assert.equal(Object.hasOwn(summary.projectCounts, 'outside'), false);
  state.projects.find(project => project.id === 'shared').memberIds = ['peer'];
  summary = taskReminderSummary(state, 'worker');
  assert.equal(summary.count, 0);
  assert.deepEqual(summary.pendingTaskIds, []);
  assert.deepEqual(summary.projectCounts, { empty: 0 });
});

test('project owner access does not require duplicate membership, but review assignment remains explicit', () => {
  const state = fixture();
  const summary = taskReminderSummary(state, 'lead');
  assert.equal(summary.ownedCount, 0);
  assert.equal(summary.pendingCount, 5);
  assert.deepEqual(summary.reviewTaskIds, ['submitted']);
  assert.equal(summary.count, 1);
});

test('administrators see all project pending counts and all eligible reviews, excluding self-review', () => {
  const state = fixture();
  state.tasks.push({ id: 'admin-task', projectId: 'outside', ownerId: 'admin', reviewerId: 'admin', status: 'review' });
  const summary = taskReminderSummary(state, 'admin');
  assert.deepEqual(summary.projectCounts, { shared: 5, outside: 2, empty: 0 });
  assert.deepEqual(summary.ownedTaskIds, ['admin-task']);
  assert.deepEqual(summary.reviewTaskIds, ['submitted', 'peer-review', 'external']);
  assert.equal(summary.count, 4);
  assert.equal(summary.reviewTaskIds.includes('admin-task'), false);
  assert.equal(summary.pendingTaskIds.includes('orphan'), false);
});

test('missing and invalid accounts receive no reminders or project identifiers', () => {
  const state = fixture();
  state.users.push({ id: 'invalid', role: 'unknown' });
  state.projects[0].memberIds.push('invalid');
  for (const actorId of [null, undefined, '', 'missing', 'invalid']) {
    const summary = taskReminderSummary(state, actorId);
    assert.equal(summary.count, 0);
    assert.equal(summary.pendingCount, 0);
    assert.deepEqual(summary.projectCounts, {});
    assert.deepEqual(summary.pendingTaskIds, []);
  }
  assert.equal(taskReminderSummary(null, null).count, 0);
});

test('summary calculation does not mutate state and updates when current account changes', () => {
  const state = fixture();
  const original = structuredClone(state);
  const worker = taskReminderSummary(state, 'worker');
  const peer = taskReminderSummary(state, 'peer');
  assert.notDeepEqual(worker.taskIds, peer.taskIds);
  assert.deepEqual(peer.taskIds, ['peer-review', 'peer-todo']);
  worker.taskIds.splice(0);
  assert.deepEqual(state, original);
  assert.equal(taskReminderSummary(state, 'worker').count, 4);
});
