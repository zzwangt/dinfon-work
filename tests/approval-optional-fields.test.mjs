import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, createSeedState, transact } from '../public/client/domain.js';

const byId = (list, id) => list.find(item => item.id === id);
const emptyValues = [undefined, null, '', ' \n\t '];
function nodeInput(state, kind, reason) {
  const project = byId(state.projects, 'p-mower');
  const milestone = byId(state.milestones, 'm-mower-2');
  return {
    projectId: project.id, kind, title: '补充交付检查', reason,
    dueDate: kind === 'create' ? project.dueDate : milestone.dueDate,
    ...(kind === 'update' ? { milestoneId: milestone.id } : {}),
  };
}
function extensionInput(state, reason) {
  const project = byId(state.projects, 'p-mower');
  return { projectId: project.id, newDueDate: addDays(project.dueDate, 1), reason, plan: '补充复测后交付', impact: '项目截止顺延一天' };
}
const livePlan = state => ({ projects: state.projects, milestones: state.milestones, tasks: state.tasks });

test('node create/update requests and approve/reject decisions allow blank reason and comment', () => {
  for (const kind of ['create', 'update']) for (const empty of emptyValues) for (const approve of [true, false]) {
    const before = createSeedState();
    const pending = transact(before, 'requestMilestone', nodeInput(before, kind, empty), 'u-engineer');
    const request = pending.milestoneRequests[0];
    assert.equal(request.reason, '');
    assert.deepEqual(livePlan(pending), livePlan(before));
    const result = transact(pending, 'reviewMilestoneRequest', { id: request.id, approve, comment: empty }, 'u-admin');
    const reviewed = result.milestoneRequests[0];
    assert.equal(reviewed.status, approve ? 'approved' : 'rejected');
    assert.equal(reviewed.comment, '');
    assert.equal(reviewed.reviewerId, 'u-admin');
    assert.ok(reviewed.reviewedAt);
    assert.doesNotMatch(result.logs[0].message, /[；;]\s*$|undefined|null/);
    if (!approve) assert.deepEqual(livePlan(result), livePlan(before));
    else if (kind === 'create') assert.equal(result.milestones.length, before.milestones.length + 1);
    else assert.equal(byId(result.milestones, 'm-mower-2').title, request.proposed.title);
  }
});

test('extension approval/rejection permits blank fields while preserving original deadlines', () => {
  for (const empty of emptyValues) for (const approve of [true, false]) {
    const before = createSeedState();
    const project = byId(before.projects, 'p-mower');
    const pending = transact(before, 'requestExtension', extensionInput(before, empty), 'u-manager');
    const request = pending.extensions[0];
    assert.equal(request.reason, '');
    assert.deepEqual(livePlan(pending), livePlan(before));
    const result = transact(pending, 'reviewExtension', { id: request.id, approve, comment: empty }, 'u-admin');
    const reviewed = result.extensions[0];
    assert.equal(reviewed.status, approve ? 'approved' : 'rejected');
    assert.equal(reviewed.comment, '');
    assert.equal(reviewed.reviewerId, 'u-admin');
    assert.ok(reviewed.reviewedAt);
    assert.equal(byId(result.projects, project.id).originalDueDate, project.originalDueDate);
    assert.equal(byId(result.projects, project.id).dueDate, approve ? request.newDueDate : project.dueDate);
    assert.doesNotMatch(result.logs[0].message, /[；;]\s*$|undefined|null/);
  }
});

test('optional reasons and opinions retain text trimming, type checks and maximum length', () => {
  for (const mode of ['create', 'update', 'extension']) {
    const before = createSeedState();
    const extension = mode === 'extension';
    const requestAction = extension ? 'requestExtension' : 'requestMilestone';
    const reviewAction = extension ? 'reviewExtension' : 'reviewMilestoneRequest';
    const input = reason => extension ? extensionInput(before, reason) : nodeInput(before, mode, reason);
    const actor = extension ? 'u-manager' : 'u-engineer';
    const getRequest = state => extension ? state.extensions[0] : state.milestoneRequests[0];
    const pending = transact(before, requestAction, input('  补充说明  '), actor);
    assert.equal(getRequest(pending).reason, '补充说明');
    const reviewed = transact(pending, reviewAction, { id: getRequest(pending).id, approve: true, comment: '  同意  ' }, 'u-admin');
    assert.equal(getRequest(reviewed).comment, '同意');
    assert.match(reviewed.logs[0].message, /；同意$/);
    const maximum = '字'.repeat(2000);
    const maximumPending = transact(before, requestAction, input(maximum), actor);
    assert.equal(getRequest(maximumPending).reason, maximum);
    assert.equal(getRequest(transact(maximumPending, reviewAction, { id: getRequest(maximumPending).id, approve: false, comment: maximum }, 'u-admin')).comment, maximum);
    for (const invalid of [42, false, {}, [], '字'.repeat(2001)]) {
      assert.throws(() => transact(before, requestAction, input(invalid), actor), /文本长度不能超过 2000/);
      for (const approve of [true, false]) {
        const snapshot = structuredClone(pending);
        assert.throws(() => transact(pending, reviewAction, { id: getRequest(pending).id, approve, comment: invalid }, 'u-admin'), /文本长度不能超过 2000/);
        assert.deepEqual(pending, snapshot);
      }
    }
  }
});

test('blank approval fields do not bypass permissions, decisions, schedules or task acceptance requirements', () => {
  const state = createSeedState();
  const node = nodeInput(state, 'create');
  assert.throws(() => transact(state, 'requestMilestone', { ...node, title: '' }, 'u-engineer'), /节点名称/);
  assert.throws(() => transact(state, 'requestMilestone', { ...node, dueDate: addDays(node.dueDate, 1) }, 'u-engineer'), /超出项目周期/);
  const pending = transact(state, 'requestMilestone', node, 'u-engineer');
  const id = pending.milestoneRequests[0].id;
  assert.throws(() => transact(pending, 'reviewMilestoneRequest', { id, approve: true }, 'u-engineer'), /仅后台管理员/);
  assert.throws(() => transact(pending, 'reviewMilestoneRequest', { id }, 'u-admin'), /请选择批准或驳回/);
  const extension = extensionInput(state);
  assert.throws(() => transact(state, 'requestExtension', extension, 'u-engineer'), /仅项目负责人/);
  assert.throws(() => transact(state, 'requestExtension', { ...extension, plan: '' }, 'u-manager'), /后续安排/);
  assert.throws(() => transact(state, 'requestExtension', { ...extension, impact: '' }, 'u-manager'), /影响范围/);
  const own = transact(state, 'requestExtension', extension, 'u-admin');
  assert.throws(() => transact(own, 'reviewExtension', { id: own.extensions[0].id, approve: true }, 'u-admin'), /不能审批自己/);
  const reviewingTask = state.tasks.find(task => task.status === 'review');
  assert.ok(reviewingTask);
  assert.throws(() => transact(state, 'reviewTask', { id: reviewingTask.id, approve: false, comment: '' }, 'u-admin'), /退回原因/);
});
