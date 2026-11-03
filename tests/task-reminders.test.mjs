import test from 'node:test';
import assert from 'node:assert/strict';
import { taskReminderSummary, approvalReminderSummary } from '../public/client/task-reminders.js';

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

test('administrators see eligible reviews including explicitly assigned self-review, but not their work assigned to another reviewer', () => {
  const state = fixture();
  state.tasks.push({ id: 'admin-task', projectId: 'outside', ownerId: 'admin', reviewerId: 'admin', status: 'review' });
  state.tasks.push({ id: 'admin-peer-review', projectId: 'outside', ownerId: 'admin', reviewerId: 'outsider', status: 'review' });
  const summary = taskReminderSummary(state, 'admin');
  assert.deepEqual(summary.projectCounts, { shared: 5, outside: 3, empty: 0 });
  assert.deepEqual(summary.ownedTaskIds, ['admin-task', 'admin-peer-review']);
  assert.deepEqual(summary.reviewTaskIds, ['submitted', 'peer-review', 'external', 'admin-task']);
  assert.equal(summary.count, 5);
  assert.equal(summary.reviewTaskIds.includes('admin-peer-review'), false);
  assert.equal(summary.pendingTaskIds.includes('orphan'), false);
});

test('one self-reviewed task remains one reminder through submission and clears after acceptance', () => {
  const state = fixture();
  const task = { id: 'self-task', projectId: 'shared', ownerId: 'worker', reviewerId: 'worker', status: 'todo' };
  state.tasks = [task];
  for (const status of ['todo', 'doing', 'review', 'doing', 'review']) {
    task.status = status;
    const summary = taskReminderSummary(state, 'worker');
    assert.equal(summary.count, 1, status);
    assert.equal(summary.ownedCount, 1, status);
    assert.equal(summary.reviewCount, status === 'review' ? 1 : 0, status);
    assert.deepEqual(summary.taskIds, ['self-task']);
    assert.deepEqual(summary.reviewTaskIds, status === 'review' ? ['self-task'] : []);
    assert.equal(summary.projectCounts.shared, 1);
  }
  task.status = 'done';
  const accepted = taskReminderSummary(state, 'worker');
  assert.equal(accepted.count, 0);
  assert.equal(accepted.ownedCount, 0);
  assert.equal(accepted.reviewCount, 0);
  assert.equal(accepted.projectCounts.shared, 0);
  assert.deepEqual(accepted.taskIds, []);
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

function approvalFixture() {
  return {
    ...fixture(),
    milestoneRequests: [
      { id: 'own-node', projectId: 'shared', applicantId: 'worker', status: 'pending' },
      { id: 'peer-node', projectId: 'shared', applicantId: 'peer', status: 'pending' },
      { id: 'approved-node', projectId: 'shared', applicantId: 'worker', status: 'approved' },
      { id: 'rejected-node', projectId: 'shared', applicantId: 'worker', status: 'rejected' },
      { id: 'external-node', projectId: 'outside', applicantId: 'worker', status: 'pending' },
      { id: 'orphan-node', projectId: 'removed-project', applicantId: 'admin', status: 'pending' },
    ],
    extensions: [
      { id: 'shared-extension', projectId: 'shared', applicantId: 'lead', status: 'pending' },
      { id: 'external-extension', projectId: 'outside', applicantId: 'outsider', status: 'pending' },
      { id: 'own-admin-extension', projectId: 'shared', applicantId: 'admin', status: 'pending' },
      { id: 'approved-extension', projectId: 'shared', applicantId: 'lead', status: 'approved' },
    ],
  };
}

test('approval reminders match pending applications in visible projects, including own submissions', () => {
  const state = approvalFixture();
  assert.deepEqual(approvalReminderSummary(state, 'worker'), {
    count: 4, nodeCount: 2, extensionCount: 2,
    nodeIds: ['own-node', 'peer-node'],
    extensionIds: ['shared-extension', 'own-admin-extension'],
  });
  const admin = approvalReminderSummary(state, 'admin');
  assert.equal(admin.count, 6);
  assert.equal(admin.nodeCount, 3);
  assert.equal(admin.extensionCount, 3);
  assert.ok(admin.extensionIds.includes('own-admin-extension'));
  assert.equal(admin.nodeIds.includes('orphan-node'), false);
});

test('reading, refreshing and signing in again cannot clear pending approval reminders', () => {
  const state = approvalFixture();
  state.notifications = [{ id: 'notice', category: 'approvals', entityId: 'own-node' }];
  const expected = approvalReminderSummary(state, 'worker');
  state.notifications = [];
  state.notificationReads = ['notice'];
  assert.deepEqual(approvalReminderSummary(state, 'worker'), expected);
  assert.deepEqual(approvalReminderSummary(structuredClone(state), 'worker'), expected);
  assert.equal(approvalReminderSummary(state, '').count, 0);
  assert.deepEqual(approvalReminderSummary(structuredClone(state), 'worker'), expected);
});

test('approvals and rejections remove only their matching reminders; returned pending items reappear', () => {
  const state = approvalFixture();
  state.milestoneRequests.find(item => item.id === 'own-node').status = 'approved';
  assert.equal(approvalReminderSummary(state, 'worker').count, 3);
  state.extensions.find(item => item.id === 'shared-extension').status = 'rejected';
  assert.equal(approvalReminderSummary(state, 'worker').count, 2);
  state.milestoneRequests.find(item => item.id === 'peer-node').status = 'approved';
  state.extensions.find(item => item.id === 'own-admin-extension').status = 'approved';
  assert.equal(approvalReminderSummary(state, 'worker').count, 0);
  state.milestoneRequests.find(item => item.id === 'own-node').status = 'pending';
  assert.deepEqual(approvalReminderSummary(state, 'worker').nodeIds, ['own-node']);
});

test('approval reminders follow account switches and membership revocation without leaking project identifiers', () => {
  const state = approvalFixture();
  const original = structuredClone(state);
  const worker = approvalReminderSummary(state, 'worker');
  const outside = approvalReminderSummary(state, 'outsider');
  assert.deepEqual(outside.nodeIds, ['external-node']);
  assert.deepEqual(outside.extensionIds, ['external-extension']);
  worker.nodeIds.splice(0);
  assert.deepEqual(state, original);
  assert.equal(approvalReminderSummary(state, 'worker').count, 4);
  state.projects.find(project => project.id === 'shared').memberIds = ['peer'];
  assert.equal(approvalReminderSummary(state, 'worker').count, 0);
  assert.equal(approvalReminderSummary(state, 'lead').count, 4, 'project owners keep visibility without duplicate membership');
});

test('missing or invalid actors and legacy empty application collections produce no approval reminders', () => {
  const state = approvalFixture();
  state.users.push({ id: 'invalid', role: 'unknown' });
  state.projects[0].memberIds.push('invalid');
  const empty = { count: 0, nodeCount: 0, extensionCount: 0, nodeIds: [], extensionIds: [] };
  for (const actorId of [null, undefined, '', 'missing', 'invalid']) {
    assert.deepEqual(approvalReminderSummary(state, actorId), empty);
  }
  assert.deepEqual(approvalReminderSummary(null, null), empty);
  assert.deepEqual(approvalReminderSummary(fixture(), 'admin'), empty);
});
