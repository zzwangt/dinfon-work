import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, createSeedState, memberStats, projectProgress, today, transact, weekRange,
} from '../public/client/domain.js';

const byId = (list, id) => list.find((item) => item.id === id);
const seed = () => createSeedState();
const deadlineSnapshot = (state) => ({
  projects: state.projects.map(({ id, dueDate, originalDueDate }) => ({ id, dueDate, originalDueDate })),
  milestones: state.milestones.map(({ id, dueDate, originalDueDate }) => ({ id, dueDate, originalDueDate })),
  tasks: state.tasks.map(({ id, dueDate, originalDueDate }) => ({ id, dueDate, originalDueDate })),
});
function requestFor(state, overrides = {}) {
  const project = byId(state.projects, 'p-mower');
  return {
    projectId: project.id, newDueDate: addDays(project.dueDate, 5),
    reason: '供应商物料延迟', plan: '先完成其他测试，再集中处理此项', impact: '报告验收顺延，其他任务保持原计划',
    affectedMilestones: [{ id: 'm-mower-3', newDueDate: addDays(project.dueDate, 5) }],
    affectedTasks: [{ id: 't-05', newDueDate: addDays(project.dueDate, 4) }],
    ...overrides,
  };
}

test('date helpers use valid calendar dates and Monday-through-Sunday weeks', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.deepEqual(weekRange('2026-10-25'), { start: '2026-10-19', end: '2026-10-25' });
  assert.throws(() => addDays('2026-02-30', 1), /日期无效/);
  assert.throws(() => addDays('2026-10-21', 1.5), /整数/);
});

test('seed has consistent assignments and schedules, one pending and one historic approved request', () => {
  const state = seed();
  assert.equal(state.projects.length, 4);
  assert.equal(state.users.length, 6);
  assert.equal(state.extensions.filter((e) => e.status === 'pending').length, 1);
  assert.equal(state.extensions.filter((e) => e.status === 'approved').length, 1);
  for (const task of state.tasks) {
    const project = byId(state.projects, task.projectId);
    const milestone = byId(state.milestones, task.milestoneId);
    assert.ok(project.memberIds.includes(task.ownerId));
    assert.notEqual(task.ownerId, task.reviewerId);
    assert.ok(task.dueDate >= project.startDate && task.dueDate <= milestone.dueDate && milestone.dueDate <= project.dueDate);
    if (milestone.status === 'done') assert.equal(task.status, 'done');
  }
});

test('pending extension leaves every live deadline unchanged and does not mutate input', () => {
  const state = seed();
  const before = structuredClone(state);
  const next = transact(state, 'requestExtension', requestFor(state), 'u-manager');
  assert.deepEqual(state, before);
  assert.deepEqual(deadlineSnapshot(next), deadlineSnapshot(state));
  assert.equal(next.extensions[0].status, 'pending');
  assert.equal(next.logs.length, state.logs.length + 1);
});

test('approval atomically updates explicit deadlines and preserves every original deadline', () => {
  const state = seed();
  const before = structuredClone(state);
  const request = byId(state.extensions, 'e-pending');
  const next = transact(state, 'reviewExtension', { id: request.id, approve: true, comment: '批准，请按新计划完成' }, 'u-admin');
  assert.deepEqual(state, before);
  assert.equal(byId(next.projects, 'p-pcb').dueDate, request.newDueDate);
  for (const group of ['projects', 'milestones', 'tasks']) {
    for (const item of state[group]) assert.equal(byId(next[group], item.id).originalDueDate, item.originalDueDate);
  }
  for (const item of request.affectedTasks) assert.equal(byId(next.tasks, item.id).dueDate, item.newDueDate);
  for (const item of request.affectedMilestones) assert.equal(byId(next.milestones, item.id).dueDate, item.newDueDate);
  assert.equal(byId(next.tasks, 't-06').dueDate, byId(state.tasks, 't-06').dueDate);
  assert.equal(byId(next.extensions, request.id).status, 'approved');
  assert.equal(byId(next.extensions, request.id).reviewerId, 'u-admin');
  assert.match(next.logs[0].message, /保留原计划/);
});

test('rejection preserves deadlines and records review reason', () => {
  const state = seed();
  const next = transact(state, 'reviewExtension', { id: 'e-pending', approve: false, comment: '请补充供应商确认记录' }, 'u-admin');
  assert.deepEqual(deadlineSnapshot(next), deadlineSnapshot(state));
  assert.equal(byId(next.extensions, 'e-pending').status, 'rejected');
  assert.equal(byId(next.extensions, 'e-pending').comment, '请补充供应商确认记录');
  assert.throws(() => transact(next, 'reviewExtension', { id: 'e-pending', approve: true, comment: '再次处理' }, 'u-admin'), /已处理/);
});

test('members cannot request project changes and managers cannot approve them', () => {
  const state = seed();
  assert.throws(() => transact(state, 'requestExtension', requestFor(state), 'u-engineer'), /项目负责人/);
  assert.throws(() => transact(state, 'requestExtension', requestFor(state), 'u-ops'), /项目负责人/);
  assert.throws(() => transact(state, 'reviewExtension', { id: 'e-pending', approve: true, comment: '批准' }, 'u-manager'), /后台管理员/);
  const request = transact(state, 'requestExtension', requestFor(state), 'u-admin');
  assert.throws(() => transact(request, 'reviewExtension', { id: request.extensions[0].id, approve: true, comment: '批准' }, 'u-admin'), /不能审批自己/);
});

test('one pending extension per project and a meaningful later deadline are required', () => {
  const state = seed();
  assert.throws(() => transact(state, 'requestExtension', requestFor(state, { projectId: 'p-pcb' }), 'u-manager'), /已有待审批/);
  assert.throws(() => transact(state, 'requestExtension', requestFor(state, { newDueDate: byId(state.projects, 'p-mower').dueDate }), 'u-manager'), /晚于当前/);
  assert.throws(() => transact(state, 'requestExtension', requestFor(state, { reason: '  ' }), 'u-manager'), /延期原因/);
});

test('extension rejects cross-project, completed and duplicate adjustments', () => {
  const state = seed();
  assert.throws(() => transact(state, 'requestExtension', requestFor(state, { affectedTasks: [{ id: 't-09', newDueDate: addDays(today(), 15) }] }), 'u-manager'), /不属于该项目/);
  assert.throws(() => transact(state, 'requestExtension', requestFor(state, { affectedTasks: [{ id: 't-01', newDueDate: addDays(today(), 15) }] }), 'u-manager'), /已完成/);
  const duplicate = { id: 't-05', newDueDate: addDays(today(), 15) };
  assert.throws(() => transact(state, 'requestExtension', requestFor(state, { affectedTasks: [duplicate, duplicate] }), 'u-manager'), /不能重复/);
});

test('task extension must include a sufficient milestone adjustment', () => {
  const state = seed();
  assert.throws(() => transact(state, 'requestExtension', requestFor(state, { affectedMilestones: [] }), 'u-manager'), /不能晚于所属节点/);
});

test('approval revalidates child deadlines and fails atomically after conflicting changes', () => {
  const state = seed();
  byId(state.tasks, 't-08').dueDate = addDays(today(), 10);
  byId(state.extensions, 'e-pending').affectedTasks = byId(state.extensions, 'e-pending').affectedTasks.filter((item) => item.id !== 't-08');
  const before = structuredClone(state);
  assert.throws(() => transact(state, 'reviewExtension', { id: 'e-pending', approve: true, comment: '批准' }, 'u-admin'), /不能晚于所属节点/);
  assert.deepEqual(state, before);
});

test('approval rejects a stale schedule or a task that completed while waiting', () => {
  const stale = seed();
  byId(stale.projects, 'p-pcb').dueDate = addDays(today(), 8);
  assert.throws(() => transact(stale, 'reviewExtension', { id: 'e-pending', approve: true, comment: '批准' }, 'u-admin'), /计划已变化/);
  const completed = seed();
  byId(completed.tasks, 't-07').status = 'done';
  assert.throws(() => transact(completed, 'reviewExtension', { id: 'e-pending', approve: true, comment: '批准' }, 'u-admin'), /已完成或变更/);
});

test('task cannot be marked done directly and only permitted assignees can submit', () => {
  const state = seed();
  assert.throws(() => transact(state, 'updateTask', { id: 't-07', status: 'done' }, 'u-engineer'), /通过验收/);
  assert.throws(() => transact(state, 'updateTask', { id: 't-07', status: 'doing' }, 'u-qa'), /自己负责/);
  assert.throws(() => transact(state, 'submitTask', { id: 't-07', deliverable: '成果' }, 'u-qa'), /任务负责人/);
  assert.throws(() => transact(state, 'updateTask', { id: 't-07', status: 'doing' }, 'u-design'), /无权访问该项目/);
  assert.throws(() => transact(state, 'submitTask', { id: 't-07', deliverable: '成果' }, 'u-design'), /无权访问该项目/);
  assert.throws(() => transact(state, 'submitTask', { id: 't-07', deliverable: '' }, 'u-engineer'), /成果说明/);
  assert.throws(() => transact(state, 'updateTask', { id: 't-07', status: 'blocked' }, 'u-engineer'), /阻塞原因/);
});

test('revoked project members cannot update or submit tasks still assigned to them', () => {
  const state = seed();
  const project = byId(state.projects, 'p-pcb');
  project.memberIds = project.memberIds.filter((id) => id !== 'u-engineer');
  const before = structuredClone(state);
  assert.throws(() => transact(state, 'updateTask', { id: 't-07', status: 'doing' }, 'u-engineer'), /无权访问该项目/);
  assert.throws(() => transact(state, 'submitTask', { id: 't-07', deliverable: '撤权后提交' }, 'u-engineer'), /无权访问该项目/);
  assert.deepEqual(state, before);
});

test('revoked project reviewers cannot review old assignments while administrators retain access', () => {
  const state = seed();
  const project = byId(state.projects, 'p-mower');
  byId(state.tasks, 't-04').reviewerId = 'u-qa';
  project.memberIds = project.memberIds.filter((id) => id !== 'u-qa');
  assert.throws(() => transact(state, 'reviewTask', { id: 't-04', approve: true }, 'u-qa'), /无权访问该项目/);
  assert.ok(!project.memberIds.includes('u-admin'));
  const approved = transact(state, 'reviewTask', { id: 't-04', approve: true }, 'u-admin');
  assert.equal(byId(approved.tasks, 't-04').status, 'done');
});

test('project owners retain task management and assigned review access without membership entries', () => {
  const state = seed();
  const project = byId(state.projects, 'p-mower');
  project.memberIds = project.memberIds.filter((id) => id !== 'u-manager');
  const updated = transact(state, 'updateTask', { id: 't-03', status: 'doing' }, 'u-manager');
  assert.equal(byId(updated.tasks, 't-03').status, 'doing');
  const approved = transact(updated, 'reviewTask', { id: 't-04', approve: true }, 'u-manager');
  assert.equal(byId(approved.tasks, 't-04').status, 'done');
});

test('submission and review preserve first-review result across rejection and resubmission', () => {
  let state = seed();
  state = transact(state, 'submitTask', { id: 't-07', deliverable: '联调报告 V1' }, 'u-engineer');
  assert.equal(byId(state.tasks, 't-07').status, 'review');
  assert.throws(() => transact(state, 'reviewTask', { id: 't-07', approve: true }, 'u-qa'), /指定验收人/);
  state = transact(state, 'reviewTask', { id: 't-07', approve: false, comment: '补充接口异常记录' }, 'u-manager');
  assert.equal(byId(state.tasks, 't-07').firstReviewPassed, false);
  assert.equal(byId(state.tasks, 't-07').reviewComment, '补充接口异常记录');
  assert.equal(byId(state.tasks, 't-07').status, 'doing');
  state = transact(state, 'submitTask', { id: 't-07', deliverable: '联调报告 V2，已补充记录' }, 'u-engineer');
  state = transact(state, 'reviewTask', { id: 't-07', approve: true }, 'u-manager');
  const task = byId(state.tasks, 't-07');
  assert.equal(task.status, 'done');
  assert.equal(task.reviewCount, 2);
  assert.equal(task.firstReviewPassed, false);
  assert.throws(() => transact(state, 'updateTask', { id: 't-07', status: 'doing' }, 'u-admin'), /已验收任务/);
});

test('even an administrator cannot review their own task', () => {
  const state = seed();
  byId(state.tasks, 't-04').ownerId = 'u-admin';
  assert.throws(() => transact(state, 'reviewTask', { id: 't-04', approve: true }, 'u-admin'), /不能验收自己/);
});

test('project progress is accepted milestone weight, not task count', () => {
  const state = seed();
  assert.equal(projectProgress(state, 'p-mower'), 25);
  assert.equal(projectProgress(state, 'p-site'), 60);
  assert.equal(projectProgress(state, 'p-delivery'), 65);
  assert.equal(projectProgress(state, 'not-present'), 0);
  byId(state.tasks, 't-02').status = 'done';
  assert.equal(projectProgress(state, 'p-mower'), 25);
});

test('rounding cannot mark a project complete while a small-weight milestone remains unfinished', () => {
  const state = seed();
  state.milestones = [
    { id: 'a', projectId: 'p-test', weight: 100, status: 'done' },
    { id: 'b', projectId: 'p-test', weight: 100, status: 'done' },
    { id: 'c', projectId: 'p-test', weight: 1, status: 'pending' },
  ];
  assert.equal(projectProgress(state, 'p-test'), 99);
  state.milestones[2].status = 'done';
  assert.equal(projectProgress(state, 'p-test'), 100);
});

test('milestone requires linked accepted tasks, then updates weighted progress', () => {
  let state = seed();
  assert.throws(() => transact(state, 'completeMilestone', { id: 'm-mower-2' }, 'u-manager'), /所有任务通过验收/);
  for (const task of state.tasks.filter((item) => item.milestoneId === 'm-mower-2')) task.status = 'done';
  assert.throws(() => transact(state, 'completeMilestone', { id: 'm-mower-2' }, 'u-engineer'), /项目负责人/);
  state = transact(state, 'completeMilestone', { id: 'm-mower-2' }, 'u-manager');
  assert.equal(projectProgress(state, 'p-mower'), 65);
  state = transact(state, 'createMilestone', { projectId: 'p-mower', title: '空节点', dueDate: addDays(today(), 11), weight: 5 }, 'u-manager');
  assert.throws(() => transact(state, 'completeMilestone', { id: state.milestones.at(-1).id }, 'u-manager'), /先为节点添加任务/);
});

test('personal statistics use latest submission in Shanghai time and ignore review delay', () => {
  const state = seed();
  state.tasks = [
    { ownerId: 'u-engineer', dueDate: '2026-10-21', status: 'done', submittedAt: '2026-10-21T15:59:59Z', reviewedAt: '2026-10-25T10:00:00Z', reviewCount: 1, firstReviewPassed: true },
    { ownerId: 'u-engineer', dueDate: '2026-10-21', status: 'review', submittedAt: '2026-10-21T16:00:00Z', reviewCount: 1, firstReviewPassed: false },
    { ownerId: 'u-engineer', dueDate: '2026-10-21', status: 'doing', submittedAt: null, reviewCount: 0, firstReviewPassed: null },
    { ownerId: 'u-engineer', dueDate: '2026-10-22', status: 'done', submittedAt: '2026-10-21T10:00:00Z', reviewCount: 1, firstReviewPassed: true },
  ];
  assert.deepEqual(memberStats(state, 'u-engineer', '2026-10-21', '2026-10-21'), {
    due: 3, completed: 1, onTime: 1, firstReviewed: 2, firstPassed: 1,
    completionRate: 33, onTimeRate: 33, firstPassRate: 50,
  });
  const empty = memberStats(state, 'u-design', '2026-10-21', '2026-10-21');
  assert.equal(empty.completionRate, null);
  assert.equal(empty.onTimeRate, null);
  assert.equal(empty.firstPassRate, null);
});

test('create-project validates date ordering, owner role and member permissions', () => {
  const state = seed();
  const input = { name: '新项目', description: '真实项目待补充', category: '研发', ownerId: 'u-manager', memberIds: ['u-engineer'], startDate: today(), dueDate: addDays(today(), 14) };
  const next = transact(state, 'createProject', input, 'u-admin');
  assert.equal(next.projects.length, 5);
  assert.deepEqual(next.projects.at(-1).memberIds, ['u-manager', 'u-engineer']);
  assert.equal(next.projects.at(-1).originalDueDate, input.dueDate);
  assert.throws(() => transact(state, 'createProject', input, 'u-engineer'), /仅管理员或项目负责人/);
  assert.throws(() => transact(state, 'createProject', { ...input, ownerId: 'u-engineer' }, 'u-admin'), /负责人或管理员角色/);
  assert.throws(() => transact(state, 'createProject', { ...input, dueDate: addDays(today(), -1) }, 'u-admin'), /不能早于开始/);
});

test('create-task enforces membership, reviewer separation, acceptance and schedule', () => {
  const state = seed();
  const input = { projectId: 'p-mower', milestoneId: 'm-mower-2', title: '新测试项', ownerId: 'u-qa', reviewerId: 'u-manager', dueDate: today(), acceptance: '提供完整测试记录' };
  const next = transact(state, 'createTask', input, 'u-manager');
  assert.equal(next.tasks.at(-1).status, 'todo');
  assert.throws(() => transact(state, 'createTask', { ...input, reviewerId: 'u-qa' }, 'u-manager'), /不能验收自己/);
  assert.throws(() => transact(state, 'createTask', { ...input, ownerId: 'u-ops' }, 'u-manager'), /必须是项目组成员/);
  assert.throws(() => transact(state, 'createTask', { ...input, acceptance: '' }, 'u-manager'), /验收标准/);
  assert.throws(() => transact(state, 'createTask', { ...input, milestoneId: '' }, 'u-manager'), /选择任务所属的里程碑/);
  assert.throws(() => transact(state, 'createTask', { ...input, milestoneId: undefined }, 'u-manager'), /选择任务所属的里程碑/);
  assert.throws(() => transact(state, 'createTask', { ...input, dueDate: addDays(today(), 4) }, 'u-manager'), /不能晚于所属节点/);
  assert.throws(() => transact(state, 'createTask', { ...input, milestoneId: 'm-mower-1' }, 'u-manager'), /已验收节点/);
});

test('only administrators can add valid team members', () => {
  const state = seed();
  const input = { name: '演示成员', title: '产品经理', department: '产品研发', role: 'member' };
  assert.throws(() => transact(state, 'addUser', input, 'u-manager'), /仅管理员/);
  assert.throws(() => transact(state, 'addUser', { ...input, role: 'owner' }, 'u-admin'), /角色无效/);
  const next = transact(state, 'addUser', input, 'u-admin');
  assert.equal(next.users.length, 7);
  assert.equal(next.users.at(-1).name, input.name);
});
