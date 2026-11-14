import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStateForActor } from '../public/client/access.js';
import { buildDailyBrief } from '../public/client/daily-brief.js';
import { createSeedState, transact } from '../public/client/domain.js';

const now = Date.parse('2026-11-14T16:30:00Z');
const employee = { id: 'me', name: '员工甲', role: 'member' };
const teammate = { id: 'other', name: '同事乙', role: 'member' };
const admin = { id: 'admin', name: '管理员', role: 'admin' };
const superadmin = { id: 'super', name: '总管理员', role: 'superadmin' };
const project = (id, ownerId, memberIds = []) => ({ id, name: `项目 ${id}`, ownerId, memberIds });
const task = (id, dueDate = '2026-11-15', extra = {}) => ({
  id, dueDate, projectId: 'p1', milestoneId: 'm1', title: `任务 ${id}`, ownerId: employee.id, status: 'todo', ...extra,
});
const state = (extra = {}) => ({
  version: 1, users: [employee, teammate, admin, superadmin], projects: [project('p1', employee.id, [teammate.id])],
  tasks: [], milestones: [], extensions: [], milestoneRequests: [], projectPlans: [], logs: [], ...extra,
});
const ids = rows => rows.map(row => row.id);

function brief(input, actor = employee, notices = []) {
  return buildDailyBrief({ state: sanitizeStateForActor(input, actor.id), actor, notifications: notices, now });
}

test('prioritizes my unfinished work with precise Beijing deadlines and keeps submitted work separate', () => {
  const input = state({ tasks: [
    task('today-all-day'), task('past-day', '2026-11-14'), task('earlier-today', '2026-11-15T00:10'),
    task('due-now', '2026-11-14T16:30:00Z'), task('tomorrow-in-beijing', '2026-11-15T16:00:00Z'),
    task('another-owner', '2026-11-15', { ownerId: teammate.id }), task('complete', '2026-11-15', { status: 'done' }),
    task('co-owner', '2026-11-15T10:00', { ownerId: teammate.id, memberIds: [employee.id], status: 'doing' }),
    task('my-delivery-is-in', '2026-11-14', { memberIds: [teammate.id], status: 'doing', deliveries: [{ ownerId: employee.id, at: '2026-11-13T02:00:00Z' }] }),
    task('all-deliveries-in', '2026-11-13', { status: 'review', reviewerId: teammate.id }),
    task('returned-single-owner-task', '2026-11-15T08:00', { status: 'doing', submittedAt: '2026-11-13T02:00:00Z' }),
    task('old-invalid-deadline', '2026-11-99'),
  ] });
  const before = structuredClone(input);
  const result = brief(input);
  assert.equal(result.day, '2026-11-15');
  assert.deepEqual(ids(result.overdueTasks), ['past-day', 'earlier-today']);
  assert.deepEqual(ids(result.todayTasks), ['due-now', 'returned-single-owner-task', 'co-owner', 'today-all-day']);
  assert.deepEqual(ids(result.upcomingTasks), ['tomorrow-in-beijing']);
  assert.deepEqual(result.waitingTasks.map(({ id, reason }) => [id, reason]), [
    ['all-deliveries-in', '等待验收'], ['my-delivery-is-in', '等其他负责人提交'],
  ]);
  assert.deepEqual(input, before);
});

test('shows open review seats, and phase signatures require all child tasks to be accepted', () => {
  const node = (id, extra = {}) => ({ id, projectId: 'p1', title: id, dueDate: '2026-11-15', status: 'pending', ...extra });
  const input = state({
    milestones: [node('m1'), node('ready'), node('signed', { coReviewerId: teammate.id, signatures: [{ as: 'owner', actorId: employee.id }] }), node('empty')],
    tasks: [
      task('mine-and-to-review', '2026-11-15', { status: 'review', reviewerId: employee.id }),
      task('teammate-task-review', '2026-11-15', { ownerId: teammate.id, status: 'review', reviewerId: teammate.id, extraReviewerIds: [employee.id] }),
      task('already-reviewed', '2026-11-15', { status: 'review', reviewerId: employee.id, extraReviewerIds: [teammate.id], reviewSignatures: [{ reviewerId: employee.id, actorId: employee.id }] }),
      task('ready-child', '2026-11-15', { milestoneId: 'ready', status: 'done' }),
      task('signed-child', '2026-11-15', { milestoneId: 'signed', status: 'done' }),
    ],
  });
  const employeeBrief = brief(input);
  assert.deepEqual(ids(employeeBrief.reviewTasks), ['mine-and-to-review', 'teammate-task-review']);
  assert.deepEqual(ids(employeeBrief.waitingTasks), ['already-reviewed']);
  assert.deepEqual(ids(employeeBrief.signMilestones), ['ready']);
  assert.deepEqual(ids(brief(input, teammate).signMilestones), ['signed']);
  assert.deepEqual(brief(input, admin).reviewTasks, []);
  assert.deepEqual(brief(input, admin).signMilestones, []);
  assert.deepEqual(ids(brief(input, superadmin).signMilestones), ['signed']);
});

test('approval backlog respects per-role action permissions and omits completed requests', () => {
  const request = (id, projectId, applicantId = teammate.id, extra = {}) => ({
    id, projectId, applicantId, status: 'pending', createdAt: '2026-11-06T00:00:00Z', ...extra,
  });
  const plan = (id, ownerId, applicantId) => ({ ...request(id, id, applicantId), project: project(id, ownerId), milestones: [], tasks: [] });
  const input = state({
    projects: [project('p1', employee.id, [teammate.id]), project('p2', teammate.id, [employee.id])],
    projectPlans: [plan('own-plan', employee.id, teammate.id), plan('submitted-plan', teammate.id, employee.id)],
    milestoneRequests: [
      request('own-node', 'p1', teammate.id, { proposed: { title: '节点标题' } }), request('self-node', 'p1', employee.id), request('other-node', 'p2'),
    ],
    extensions: [
      request('own-extension', 'p1', teammate.id, { newDueDate: '2026-11-30' }), request('other-extension', 'p2', teammate.id, { newDueDate: '2026-11-30' }),
      request('finished-extension', 'p1', teammate.id, { newDueDate: '2026-11-30', status: 'approved' }),
    ],
  });
  assert.deepEqual(brief(input).approvals.map(({ id, kind, title }) => [id, kind, title]), [
    ['own-plan', 'plan', '项目 own-plan'], ['own-node', 'nodeRequest', '节点标题'], ['own-extension', 'extension', '项目 p1'],
  ]);
  assert.deepEqual(ids(brief(input, admin).approvals), ['own-plan', 'submitted-plan', 'own-node', 'self-node', 'other-node']);
  assert.deepEqual(ids(brief(input, superadmin).approvals), ['own-plan', 'submitted-plan', 'own-node', 'self-node', 'other-node', 'own-extension', 'other-extension']);
  assert.deepEqual(brief(input).activityGroups, []);
});

test('groups today’s authorized project records independently of notification read status', () => {
  const log = (id, projectId, at, extra = {}) => ({ id, projectId, at, actorId: teammate.id, message: `更新 ${id}`, ...extra });
  const input = state({
    projects: [project('p1', employee.id, [teammate.id]), project('p2', teammate.id, [employee.id]), project('secret', teammate.id)],
    logs: [
      log('earlier', 'p1', '2026-11-14T16:04:00Z'), log('yesterday', 'p1', '2026-11-14T15:59:59Z'),
      log('newest', 'p2', '2026-11-15T00:25:00+08:00'), log('future', 'p1', '2026-11-14T16:31:00Z'),
      log('account-event', null, '2026-11-14T16:28:00Z'), log('hidden', 'secret', '2026-11-14T16:29:00Z'),
      log('later', 'p1', '2026-11-14T16:17:00Z', { changes: { accountSecret: true } }),
    ],
  });
  const notices = [
    { id: 'old-unread', title: '昨天的未读提醒', createdAt: '2026-11-14T13:00:00Z' },
    { id: 'new-unread', title: '今天的未读提醒', createdAt: '2026-11-14T16:16:00Z' },
  ];
  const result = brief(input, employee, notices);
  assert.deepEqual(result.activityGroups, [
    { projectId: 'p2', projectName: '项目 p2', count: 1, events: [{ id: 'newest', at: '2026-11-15T00:25:00+08:00', actorName: '同事乙', message: '更新 newest' }] },
    { projectId: 'p1', projectName: '项目 p1', count: 2, events: [
      { id: 'later', at: '2026-11-14T16:17:00Z', actorName: '同事乙', message: '更新 later' },
      { id: 'earlier', at: '2026-11-14T16:04:00Z', actorName: '同事乙', message: '更新 earlier' },
    ] },
  ]);
  assert.deepEqual(result.unreadNotifications, [...notices].reverse());
  assert.deepEqual(brief(input).activityGroups, result.activityGroups);
});

test('a real approved plan leaves approval backlog and appears in authorized project activity', t => {
  t.mock.timers.enable({ apis: ['Date'], now });
  const input = createSeedState();
  const approver = input.users.find(user => user.id === 'u-admin');
  const owner = input.users.find(user => user.id === 'u-engineer');
  const outsider = input.users.find(user => user.id === 'u-qa');
  const submitted = transact(input, 'createProject', {
    name: '新项目', ownerId: owner.id, startDate: '2026-11-15', dueDate: '2026-11-30',
  }, approver.id);
  const plan = submitted.projectPlans[0];
  assert.ok(brief(submitted, owner).approvals.some(item => item.id === plan.id));
  assert.ok(brief(submitted, approver).approvals.some(item => item.id === plan.id));
  assert.ok(!brief(submitted, outsider).approvals.some(item => item.id === plan.id));
  const approved = transact(submitted, 'reviewProjectPlan', { id: plan.id, approve: true }, approver.id);
  const ownerBrief = brief(approved, owner);
  assert.ok(!ownerBrief.approvals.some(item => item.id === plan.id));
  const approvalGroup = ownerBrief.activityGroups.find(group => group.projectId === plan.projectId);
  assert.equal(approvalGroup.count, 1);
  assert.equal(approvalGroup.events[0].message, '批准整份新建项目计划“新项目”');
  assert.ok(!brief(approved, outsider).activityGroups.some(group => group.projectId === plan.projectId));
});

test('returns an empty brief for an account without assigned work and during sign-out', () => {
  const empty = { day: '2026-11-15', overdueTasks: [], todayTasks: [], upcomingTasks: [], waitingTasks: [], reviewTasks: [], signMilestones: [], approvals: [], activityGroups: [], unreadNotifications: [] };
  assert.deepEqual(brief(state({ projects: [] })), empty);
  assert.deepEqual(buildDailyBrief({ state: state(), now }), empty);
});
