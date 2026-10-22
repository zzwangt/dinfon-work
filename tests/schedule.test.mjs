import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, memberStats, progressAgainstPlan, projectScheduleProgress, transact, weekRange } from '../public/client/domain.js';
import { deadlineMs } from '../public/client/time.js';

const DAY = '2099-10-25';
const at = (hour) => `${DAY}T${String(hour).padStart(2, '0')}:00`;
const byId = (list, id) => list.find((entry) => entry.id === id);
function hourlyState() {
  const state = createSeedState();
  const project = byId(state.projects, 'p-mower');
  Object.assign(project, { startDate: at(8), dueDate: at(18), originalDueDate: at(18) });
  for (const milestone of state.milestones.filter((item) => item.projectId === project.id)) {
    milestone.dueDate = milestone.id === 'm-mower-1' ? at(9) : milestone.id === 'm-mower-2' ? at(14) : at(18);
    milestone.originalDueDate = milestone.dueDate;
  }
  for (const task of state.tasks.filter((item) => item.projectId === project.id)) {
    task.dueDate = task.milestoneId === 'm-mower-1' ? at(9) : task.milestoneId === 'm-mower-2' ? at(13) : at(17);
    task.originalDueDate = task.dueDate;
  }
  return state;
}
const extensionInput = () => ({
  projectId: 'p-mower', newDueDate: at(20), reason: '增加同日复测', plan: '补充复测并交付报告', impact: '节点和关联任务顺延数小时',
  affectedMilestones: [{ id: 'm-mower-2', newDueDate: at(16) }], affectedTasks: [{ id: 't-03', newDueDate: at(15) }],
});

test('planned progress advances only when actual deadlines are reached, not linearly during the project', () => {
  const items = [{ status: 'done', dueDate: at(9) }, { status: 'pending', dueDate: at(14) }, { status: 'pending', dueDate: at(18) }];
  assert.deepEqual(progressAgainstPlan(items, deadlineMs(at(10))), { actual: 33, planned: 33, lag: 0, total: 3, completed: 1, due: 1, overdueCount: 0 });
  assert.deepEqual(progressAgainstPlan(items, deadlineMs(at(14))), { actual: 33, planned: 67, lag: 34, total: 3, completed: 1, due: 2, overdueCount: 1 });
  assert.deepEqual(progressAgainstPlan(items, deadlineMs(at(19))), { actual: 33, planned: 100, lag: 67, total: 3, completed: 1, due: 3, overdueCount: 2 });
  items[1].status = 'done';
  assert.equal(progressAgainstPlan(items, deadlineMs(at(10))).lag, 0);
});

test('progress handles no plan, all completed, and rounding without a false 100 percent', () => {
  assert.deepEqual(progressAgainstPlan([], deadlineMs(at(10))), { actual: 0, planned: 0, lag: 0, total: 0, completed: 0, due: 0, overdueCount: 0 });
  const items = Array.from({ length: 201 }, (_, i) => ({ status: i === 200 ? 'pending' : 'done', dueDate: at(9) }));
  assert.equal(progressAgainstPlan(items, deadlineMs(at(10))).actual, 99);
  assert.equal(progressAgainstPlan(items, deadlineMs(at(10))).lag, 1);
  items.at(-1).status = 'done';
  assert.equal(progressAgainstPlan(items, deadlineMs(at(10))).actual, 100);
  assert.equal(progressAgainstPlan(items, deadlineMs(at(10))).overdueCount, 0);
});

test('unapproved new or changed nodes cannot change the current project plan or its red lag segment', () => {
  const state = hourlyState();
  const now = deadlineMs(at(15));
  const expected = projectScheduleProgress(state, 'p-mower', now);
  const created = transact(state, 'requestMilestone', { projectId: 'p-mower', kind: 'create', title: '增加同日检查', dueDate: at(10), reason: '补充检查' }, 'u-engineer');
  assert.deepEqual(projectScheduleProgress(created, 'p-mower', now), expected);
  const changed = transact(created, 'requestMilestone', { projectId: 'p-mower', kind: 'update', milestoneId: 'm-mower-2', title: '核心场景测试', dueDate: at(16), reason: '补充检查' }, 'u-engineer');
  assert.deepEqual(projectScheduleProgress(changed, 'p-mower', now), expected);
  const approved = transact(changed, 'reviewMilestoneRequest', { id: changed.milestoneRequests[0].id, approve: true, comment: '同意调整' }, 'u-admin');
  assert.equal(projectScheduleProgress(approved, 'p-mower', now).lag, 0);
  assert.equal(byId(approved.milestones, 'm-mower-2').originalDueDate, at(14));
});

test('hour-level project and task creation respect same-day order and offset equivalence', () => {
  const state = hourlyState();
  const projectInput = { name: '小时排期', ownerId: 'u-manager', memberIds: ['u-engineer'], startDate: at(10), dueDate: at(18) };
  assert.equal(transact(state, 'createProject', projectInput, 'u-admin').projects.at(-1).dueDate, at(18));
  assert.throws(() => transact(state, 'createProject', { ...projectInput, dueDate: at(9) }, 'u-admin'), /不能早于开始/);
  const input = { projectId: 'p-mower', milestoneId: 'm-mower-2', ownerId: 'u-engineer', reviewerId: 'u-manager', title: '小时任务', acceptance: '完整记录', dueDate: `${DAY}T06:00:00Z` };
  assert.equal(transact(state, 'createTask', input, 'u-manager').tasks.at(-1).dueDate, input.dueDate);
  assert.throws(() => transact(state, 'createTask', { ...input, dueDate: at(15) }, 'u-manager'), /不能晚于所属节点/);
  assert.throws(() => transact(state, 'createTask', { ...input, dueDate: at(7) }, 'u-manager'), /项目周期/);
});

test('a legacy whole-day child task cannot be silently shortened by an earlier hour on its node', () => {
  const state = hourlyState();
  const project = byId(state.projects, 'p-mower');
  project.dueDate = DAY;
  const target = byId(state.milestones, 'm-mower-2');
  target.dueDate = DAY;
  byId(state.tasks, 't-03').dueDate = DAY;
  const before = structuredClone(state);
  assert.throws(() => transact(state, 'requestMilestone', { projectId: project.id, kind: 'update', milestoneId: target.id, title: target.title, dueDate: at(23), reason: '调整交付时间' }, 'u-engineer'), /不能晚于所属节点/);
  assert.deepEqual(state, before);
});

test('same-day extensions update explicit hours only on approval and recompute plan lag', () => {
  const state = hourlyState();
  const now = deadlineMs(at(15));
  const before = structuredClone(state);
  const pending = transact(state, 'requestExtension', extensionInput(), 'u-manager');
  assert.deepEqual(state, before);
  assert.deepEqual(pending.tasks, state.tasks);
  assert.deepEqual(pending.milestones, state.milestones);
  assert.equal(projectScheduleProgress(pending, 'p-mower', now).lag, 34);
  const approved = transact(pending, 'reviewExtension', { id: pending.extensions[0].id, approve: true, comment: '同意顺延两小时' }, 'u-admin');
  assert.equal(projectScheduleProgress(approved, 'p-mower', now).lag, 0);
  assert.equal(byId(approved.projects, 'p-mower').dueDate, at(20));
  assert.equal(byId(approved.projects, 'p-mower').originalDueDate, at(18));
  assert.equal(byId(approved.milestones, 'm-mower-2').originalDueDate, at(14));
  assert.equal(byId(approved.tasks, 't-03').dueDate, at(15));
  assert.equal(byId(approved.tasks, 't-03').originalDueDate, at(13));
  assert.equal(byId(approved.tasks, 't-02').dueDate, at(13));
});

test('extensions compare real instants so offset-only edits and earlier hours are rejected', () => {
  const state = hourlyState();
  assert.throws(() => transact(state, 'requestExtension', { ...extensionInput(), newDueDate: `${DAY}T10:00:00Z` }, 'u-manager'), /晚于当前截止/);
  assert.throws(() => transact(state, 'requestExtension', { ...extensionInput(), newDueDate: at(17) }, 'u-manager'), /晚于当前截止/);
  assert.throws(() => transact(state, 'requestExtension', { ...extensionInput(), affectedMilestones: [{ id: 'm-mower-2', newDueDate: `${DAY}T06:00:00Z` }] }, 'u-manager'), /晚于当前日期/);
  const legacy = hourlyState();
  byId(legacy.projects, 'p-mower').dueDate = DAY;
  assert.throws(() => transact(legacy, 'requestExtension', { ...extensionInput(), newDueDate: at(23) }, 'u-manager'), /晚于当前截止/);
});

test('old date baselines stay unchanged when an approved extension introduces exact hours', () => {
  const state = hourlyState();
  byId(state.projects, 'p-mower').dueDate = DAY;
  byId(state.projects, 'p-mower').originalDueDate = DAY;
  const nextDay = '2099-10-26T10:00';
  const pending = transact(state, 'requestExtension', { ...extensionInput(), newDueDate: nextDay, affectedMilestones: [], affectedTasks: [] }, 'u-manager');
  const approved = transact(pending, 'reviewExtension', { id: pending.extensions[0].id, approve: true, comment: '同意' }, 'u-admin');
  assert.equal(byId(approved.projects, 'p-mower').originalDueDate, DAY);
  assert.equal(byId(approved.projects, 'p-mower').dueDate, nextDay);
  assert.equal(approved.extensions[0].originalDueDate, DAY);
});

test('node snapshots recognize equivalent timestamp formatting while preserving stale-hour protection', () => {
  const state = hourlyState();
  const input = { projectId: 'p-mower', kind: 'update', milestoneId: 'm-mower-2', title: '核心场景测试', dueDate: `${DAY}T06:00:00Z`, reason: '调整日期格式' };
  assert.throws(() => transact(state, 'requestMilestone', input, 'u-engineer'), /没有实际变化/);
  const pending = transact(state, 'requestMilestone', { ...input, dueDate: at(16) }, 'u-engineer');
  byId(pending.milestones, input.milestoneId).dueDate = `${DAY}T06:00:00Z`;
  assert.equal(transact(pending, 'reviewMilestoneRequest', { id: pending.milestoneRequests[0].id, approve: true, comment: '同意' }, 'u-admin').milestoneRequests[0].status, 'approved');
  byId(pending.milestones, input.milestoneId).dueDate = at(15);
  const before = structuredClone(pending);
  assert.throws(() => transact(pending, 'reviewMilestoneRequest', { id: pending.milestoneRequests[0].id, approve: true, comment: '同意' }, 'u-admin'), /计划已变化/);
  assert.deepEqual(pending, before);
});

test('personal on-time metrics use exact submission instants and still include the whole Sunday cohort', () => {
  const state = createSeedState();
  const task = (dueDate, submittedAt) => ({ ownerId: 'u-engineer', dueDate, submittedAt, status: 'done', reviewCount: 1, firstReviewPassed: true, reviewedAt: '2026-10-28T09:00:00Z' });
  state.tasks = [
    task('2026-10-25T10:00', '2026-10-25T02:00:00Z'),
    task('2026-10-25T10:00', '2026-10-25T02:00:00.001Z'),
    task('2026-10-25', '2026-10-25T15:59:59.999Z'),
    task('2026-10-25T15:00:00Z', '2026-10-25T14:59:00Z'),
    task('2026-10-25T16:00:00Z', '2026-10-25T15:59:00Z'),
  ];
  const result = memberStats(state, 'u-engineer', '2026-10-19', '2026-10-25');
  assert.equal(result.due, 4);
  assert.equal(result.completed, 4);
  assert.equal(result.onTime, 3);
  assert.equal(result.onTimeRate, 75);
  assert.equal(memberStats(state, 'u-engineer', '2026-10-26', '2026-10-26').due, 1);
  assert.deepEqual(weekRange('2026-10-25T16:00:00Z'), { start: '2026-10-26', end: '2026-11-01' });
});

test('legacy dates become due at the final millisecond of their Shanghai day', () => {
  const items = [{ status: 'pending', dueDate: '2026-10-25' }];
  assert.equal(progressAgainstPlan(items, Date.parse('2026-10-25T15:59:59.998Z')).planned, 0);
  assert.equal(progressAgainstPlan(items, Date.parse('2026-10-25T15:59:59.999Z')).planned, 100);
  assert.equal(progressAgainstPlan(items, Date.parse('2026-10-25T16:00:00Z')).overdueCount, 1);
});

test('same-day extension times are checked against the current hour again during approval', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: deadlineMs(at(19)) });
  const state = hourlyState();
  assert.throws(() => transact(state, 'requestExtension', { ...extensionInput(), newDueDate: `${DAY}T18:30` }, 'u-manager'), /不能早于当前时间/);
  const pending = transact(state, 'requestExtension', extensionInput(), 'u-manager');
  t.mock.timers.setTime(deadlineMs(at(21)));
  const before = structuredClone(pending);
  assert.throws(() => transact(pending, 'reviewExtension', { id: pending.extensions[0].id, approve: true, comment: '批准' }, 'u-admin'), /已经过去/);
  assert.deepEqual(pending, before);
  assert.equal(transact(pending, 'reviewExtension', { id: pending.extensions[0].id, approve: false, comment: '时间已过，请重提' }, 'u-admin').extensions[0].status, 'rejected');
});
