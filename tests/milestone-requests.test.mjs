import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, createSeedState, projectProgress, today, transact } from '../public/client/domain.js';

const byId = (list, id) => list.find((item) => item.id === id);
const createInput = (overrides = {}) => ({
  projectId: 'p-mower', kind: 'create', title: '追加可靠性检查',
  dueDate: addDays(today(), 11), weight: 10, reason: '覆盖补充的场景和交付要求', ...overrides,
});
const updateInput = (state, overrides = {}) => {
  const milestone = byId(state.milestones, 'm-mower-2');
  return {
    projectId: milestone.projectId, kind: 'update', milestoneId: milestone.id,
    title: `${milestone.title}与复核`, dueDate: milestone.dueDate, weight: milestone.weight,
    reason: '完善验收内容与节点安排', ...overrides,
  };
};
const review = (state, approve = true, actorId = 'u-admin') => transact(state, 'reviewMilestoneRequest', {
  id: state.milestoneRequests[0].id, approve, comment: approve ? '同意，按新节点计划执行' : '请补充必要性和实施方案',
}, actorId);
const livePlan = (state) => ({ projects: state.projects, milestones: state.milestones, tasks: state.tasks });

test('new requests retain an exact audit record while every live plan and progress remains unchanged', () => {
  const state = createSeedState();
  const before = structuredClone(state);
  const input = createInput({ title: '  追加可靠性检查  ', weight: '10' });
  const next = transact(state, 'requestMilestone', input, 'u-engineer');
  assert.deepEqual(state, before);
  assert.deepEqual(livePlan(next), livePlan(state));
  assert.equal(projectProgress(next, 'p-mower'), projectProgress(state, 'p-mower'));
  const request = next.milestoneRequests[0];
  assert.match(request.id, /^mr-/);
  assert.deepEqual(Object.keys(request).sort(), [
    'id', 'projectId', 'kind', 'milestoneId', 'applicantId', 'before', 'proposed', 'reason',
    'status', 'createdAt', 'reviewedAt', 'reviewerId', 'comment',
  ].sort());
  assert.equal(request.applicantId, 'u-engineer');
  assert.equal(request.milestoneId, null);
  assert.equal(request.before, null);
  assert.deepEqual(request.proposed, { title: '追加可靠性检查', dueDate: input.dueDate, weight: 10 });
  assert.equal(request.status, 'pending');
  assert.equal(request.reviewedAt, null);
  assert.equal(request.reviewerId, null);
  assert.equal(request.comment, '');
  assert.ok(!Number.isNaN(Date.parse(request.createdAt)));
  assert.equal(next.logs.length, state.logs.length + 1);
});

test('only project members, project owners and administrators can request a node change', () => {
  const state = createSeedState();
  for (const actorId of ['u-engineer', 'u-manager', 'u-admin']) {
    assert.equal(transact(state, 'requestMilestone', createInput(), actorId).milestoneRequests.length, 1);
  }
  assert.throws(() => transact(state, 'requestMilestone', createInput(), 'u-ops'), /无权访问该项目/);
  const project = byId(state.projects, 'p-mower');
  project.memberIds = project.memberIds.filter((id) => id !== project.ownerId);
  assert.equal(transact(state, 'requestMilestone', createInput(), project.ownerId).milestoneRequests.length, 1);
  assert.throws(() => transact(state, 'requestMilestone', updateInput(state, { milestoneId: 'm-pcb-2' }), 'u-engineer'), /不属于该项目/);
});

test('create approval adds the proposed milestone with a preserved initial date but never adjusts tasks', () => {
  const state = createSeedState();
  const requested = transact(state, 'requestMilestone', createInput(), 'u-engineer');
  const before = structuredClone(requested);
  const approved = review(requested);
  assert.deepEqual(requested, before);
  assert.equal(approved.milestones.length, state.milestones.length + 1);
  const added = approved.milestones.at(-1);
  assert.match(added.id, /^m-/);
  assert.equal(added.projectId, 'p-mower');
  assert.equal(added.title, createInput().title);
  assert.equal(added.dueDate, createInput().dueDate);
  assert.equal(added.originalDueDate, added.dueDate);
  assert.equal(added.weight, 10);
  assert.equal(added.status, 'pending');
  assert.equal(added.acceptedAt, null);
  assert.deepEqual(approved.tasks, state.tasks);
  assert.deepEqual(approved.projects, state.projects);
  assert.equal(approved.milestoneRequests[0].status, 'approved');
  assert.equal(approved.milestoneRequests[0].milestoneId, null);
  assert.equal(approved.milestoneRequests[0].reviewerId, 'u-admin');
  assert.ok(approved.milestoneRequests[0].reviewedAt);
  assert.equal(projectProgress(approved, 'p-mower'), 23);
});

test('one administrator can submit then approve their own request in separate transactions', () => {
  const state = createSeedState();
  assert.equal(state.users.filter((user) => user.role === 'admin').length, 1);
  const pending = transact(state, 'requestMilestone', createInput(), 'u-admin');
  assert.deepEqual(pending.milestones, state.milestones);
  assert.equal(review(pending).milestoneRequests[0].status, 'approved');
});

test('update requests capture the node snapshot and only approval changes editable fields', () => {
  const state = createSeedState();
  const old = byId(state.milestones, 'm-mower-2');
  const input = updateInput(state, { dueDate: addDays(old.dueDate, 2), weight: 55 });
  const pending = transact(state, 'requestMilestone', input, 'u-qa');
  assert.deepEqual(livePlan(pending), livePlan(state));
  assert.deepEqual(pending.milestoneRequests[0].before, { title: old.title, dueDate: old.dueDate, weight: old.weight, status: old.status });
  const approved = review(pending);
  const updated = byId(approved.milestones, old.id);
  assert.deepEqual(updated, { ...old, title: input.title, dueDate: input.dueDate, weight: input.weight });
  assert.equal(updated.originalDueDate, old.originalDueDate);
  assert.deepEqual(approved.tasks, state.tasks);
  assert.deepEqual(approved.projects, state.projects);
  assert.equal(approved.milestones.length, state.milestones.length);
});

test('rejection keeps new and changed plans untouched and processed requests cannot be reviewed again', () => {
  for (const kind of ['create', 'update']) {
    const state = createSeedState();
    const pending = transact(state, 'requestMilestone', kind === 'create' ? createInput() : updateInput(state), 'u-engineer');
    const rejected = review(pending, false);
    assert.deepEqual(livePlan(rejected), livePlan(state));
    assert.equal(rejected.milestoneRequests[0].status, 'rejected');
    assert.equal(rejected.milestoneRequests[0].comment, '请补充必要性和实施方案');
    assert.throws(() => review(rejected), /已处理/);
    assert.throws(() => review(rejected, false), /已处理/);
  }
});

test('node reviews require administrator role, an explicit decision and an explanation', () => {
  const pending = transact(createSeedState(), 'requestMilestone', createInput(), 'u-engineer');
  for (const actorId of ['u-engineer', 'u-manager', 'u-ops']) assert.throws(() => review(pending, true, actorId), /仅后台管理员/);
  assert.throws(() => transact(pending, 'reviewMilestoneRequest', { id: pending.milestoneRequests[0].id, comment: '说明' }, 'u-admin'), /请选择批准或驳回/);
  for (const approve of [true, false]) {
    assert.throws(() => transact(pending, 'reviewMilestoneRequest', { id: pending.milestoneRequests[0].id, approve, comment: ' ' }, 'u-admin'), /审批意见|驳回原因/);
  }
});

test('the old direct node creation action is closed to every role', () => {
  for (const actorId of ['u-admin', 'u-manager', 'u-engineer', 'u-ops']) {
    assert.throws(() => transact(createSeedState(), 'createMilestone', createInput(), actorId), /先提交申请.*管理员审批/);
  }
});

test('request validation rejects bad fields, nonexistent dates and out-of-project dates', () => {
  const state = createSeedState();
  const attempt = (overrides) => transact(state, 'requestMilestone', createInput(overrides), 'u-engineer');
  for (const kind of [undefined, 'delete', 'createMilestone']) assert.throws(() => attempt({ kind }), /类型无效/);
  assert.throws(() => attempt({ title: ' ' }), /节点名称/);
  assert.throws(() => attempt({ title: '名'.repeat(101) }), /不能超过 100/);
  for (const weight of [undefined, null, '', ' ', 0, -1, 101, NaN, Infinity, true, {}, 'bad']) {
    assert.throws(() => attempt({ weight }), /节点权重/);
  }
  assert.throws(() => attempt({ reason: '' }), /申请原因/);
  assert.throws(() => attempt({ reason: '因'.repeat(2001) }), /不能超过 2000/);
  assert.throws(() => attempt({ dueDate: '2026-02-30' }), /节点截止日期无效/);
  assert.throws(() => attempt({ dueDate: addDays(byId(state.projects, 'p-mower').startDate, -1) }), /早于项目开始日期/);
  assert.throws(() => attempt({ dueDate: addDays(byId(state.projects, 'p-mower').dueDate, 1) }), /先申请项目延期并获批/);
  assert.throws(() => attempt({ milestoneId: 'm-mower-2' }), /新增节点申请不能指定/);
});

test('completed nodes and updates with no actual change cannot enter approval', () => {
  const state = createSeedState();
  const milestone = byId(state.milestones, 'm-mower-2');
  assert.throws(() => transact(state, 'requestMilestone', updateInput(state, { title: milestone.title, weight: String(milestone.weight) }), 'u-engineer'), /没有实际变化/);
  assert.throws(() => transact(state, 'requestMilestone', updateInput(state, { milestoneId: 'm-mower-1' }), 'u-admin'), /已完成节点/);
});

test('a node has one pending update and a project has one pending new request for the same name', () => {
  const state = createSeedState();
  let pending = transact(state, 'requestMilestone', updateInput(state), 'u-engineer');
  assert.throws(() => transact(pending, 'requestMilestone', updateInput(state, { weight: 50 }), 'u-qa'), /已有待审批的修改申请/);
  pending = transact(state, 'requestMilestone', createInput(), 'u-engineer');
  assert.throws(() => transact(pending, 'requestMilestone', createInput({ title: '  追加可靠性检查  ' }), 'u-qa'), /同名节点的待审批新增申请/);
  assert.equal(transact(pending, 'requestMilestone', createInput({ projectId: 'p-pcb', dueDate: addDays(today(), 6) }), 'u-engineer').milestoneRequests.length, 2);
  assert.equal(transact(review(pending, false), 'requestMilestone', createInput(), 'u-engineer').milestoneRequests.length, 2);
});

test('a proposed earlier milestone cannot overtake any linked task and no task dates are silently moved', () => {
  const state = createSeedState();
  const before = structuredClone(state);
  assert.throws(() => transact(state, 'requestMilestone', updateInput(state, { dueDate: today() }), 'u-engineer'), /不能晚于所属节点/);
  assert.deepEqual(state, before);
});

test('approval rejects any changed target snapshot and retains pending status atomically', () => {
  for (const field of ['title', 'dueDate', 'weight', 'status']) {
    const initial = createSeedState();
    const state = transact(initial, 'requestMilestone', updateInput(initial), 'u-engineer');
    const target = byId(state.milestones, 'm-mower-2');
    if (field === 'title') target.title += '另一个版本';
    if (field === 'dueDate') target.dueDate = addDays(target.dueDate, 1);
    if (field === 'weight') target.weight += 1;
    if (field === 'status') target.status = 'done';
    const before = structuredClone(state);
    assert.throws(() => review(state), /节点计划已变化|已完成节点/);
    assert.deepEqual(state, before);
    assert.equal(state.milestoneRequests[0].status, 'pending');
    assert.equal(review(state, false).milestoneRequests[0].status, 'rejected');
  }
});

test('a competing approved project extension makes an earlier node-update snapshot stale', () => {
  const state = createSeedState();
  const target = byId(state.milestones, 'm-pcb-2');
  const pending = transact(state, 'requestMilestone', {
    projectId: target.projectId, kind: 'update', milestoneId: target.id,
    title: `${target.title}与复核`, dueDate: target.dueDate, weight: target.weight, reason: '补充复核',
  }, 'u-engineer');
  const extended = transact(pending, 'reviewExtension', { id: 'e-pending', approve: true, comment: '同意延期' }, 'u-admin');
  const before = structuredClone(extended);
  assert.throws(() => review(extended), /节点计划已变化/);
  assert.deepEqual(extended, before);
});

test('an old extension cannot roll back a newer approved milestone plan and failure is atomic', () => {
  let state = createSeedState();
  state = transact(state, 'requestExtension', {
    projectId: 'p-mower', newDueDate: addDays(today(), 17),
    reason: '供应商交期调整', plan: '调整场景测试排期', impact: '核心场景节点顺延',
    affectedMilestones: [{ id: 'm-mower-2', newDueDate: addDays(today(), 4) }], affectedTasks: [],
  }, 'u-manager');
  const extensionId = state.extensions[0].id;
  state = transact(state, 'requestMilestone', updateInput(state, { dueDate: addDays(today(), 8) }), 'u-engineer');
  state = review(state);
  const before = structuredClone(state);
  assert.throws(() => transact(state, 'reviewExtension', { id: extensionId, approve: true, comment: '批准延期' }, 'u-admin'), /节点计划已变化.*驳回后重新提交/);
  assert.deepEqual(state, before);
  assert.equal(byId(state.extensions, extensionId).status, 'pending');
  assert.equal(byId(state.milestones, 'm-mower-2').dueDate, addDays(today(), 8));
});

test('extension approval rejects equal or earlier node and task dates without partial writes', () => {
  for (const collection of ['milestones', 'tasks']) {
    for (const offset of [0, 1]) {
      const state = createSeedState();
      const extension = byId(state.extensions, 'e-pending');
      const adjustment = (collection === 'milestones' ? extension.affectedMilestones : extension.affectedTasks).at(-1);
      byId(state[collection], adjustment.id).dueDate = addDays(adjustment.newDueDate, offset);
      const before = structuredClone(state);
      assert.throws(() => transact(state, 'reviewExtension', { id: extension.id, approve: true, comment: '批准延期' }, 'u-admin'), /节点计划已变化|任务计划已变化/);
      assert.deepEqual(state, before);
      assert.equal(byId(state.extensions, extension.id).status, 'pending');
    }
  }
});

test('approval rechecks newly added child tasks against a proposed earlier node date', () => {
  const state = createSeedState();
  const pending = transact(state, 'requestMilestone', updateInput(state, { dueDate: addDays(today(), 1) }), 'u-engineer');
  const withNewTask = transact(pending, 'createTask', {
    projectId: 'p-mower', milestoneId: 'm-mower-2', title: '审批期间新增检查', ownerId: 'u-qa',
    reviewerId: 'u-manager', dueDate: addDays(today(), 2), acceptance: '提交检查记录',
  }, 'u-manager');
  const before = structuredClone(withNewTask);
  assert.throws(() => review(withNewTask), /不能晚于所属节点/);
  assert.deepEqual(withNewTask, before);
});

test('approval rechecks current project dates and saved proposal validation', () => {
  const pending = transact(createSeedState(), 'requestMilestone', createInput(), 'u-engineer');
  for (const change of [
    (state) => { byId(state.projects, 'p-mower').dueDate = today(); },
    (state) => { state.milestoneRequests[0].proposed.weight = 0; },
    (state) => { state.milestoneRequests[0].proposed.title = ''; },
    (state) => { state.milestoneRequests[0].reason = ''; },
  ]) {
    const state = structuredClone(pending);
    change(state);
    const before = structuredClone(state);
    assert.throws(() => review(state), /项目延期|节点权重|节点名称|申请原因/);
    assert.deepEqual(state, before);
  }
});

test('approval refuses a removed applicant but still allows rejection for cleanup', () => {
  const pending = transact(createSeedState(), 'requestMilestone', createInput(), 'u-engineer');
  const project = byId(pending.projects, 'p-mower');
  project.memberIds = project.memberIds.filter((id) => id !== 'u-engineer');
  const before = structuredClone(pending);
  assert.throws(() => review(pending), /申请人已无项目访问权限/);
  assert.deepEqual(pending, before);
  assert.equal(review(pending, false).milestoneRequests[0].status, 'rejected');
  pending.users = pending.users.filter((user) => user.id !== 'u-engineer');
  assert.throws(() => review(pending), /申请人不存在/);
});

test('an owner without a member entry retains approval eligibility while a demoted outside admin does not', () => {
  const state = createSeedState();
  let pending = transact(state, 'requestMilestone', createInput(), 'u-manager');
  byId(pending.projects, 'p-mower').memberIds = byId(pending.projects, 'p-mower').memberIds.filter((id) => id !== 'u-manager');
  assert.equal(review(pending).milestoneRequests[0].status, 'approved');
  pending = transact(state, 'requestMilestone', createInput(), 'u-admin');
  byId(pending.users, 'u-admin').role = 'member';
  byId(pending.users, 'u-ops').role = 'admin';
  assert.throws(() => review(pending, true, 'u-ops'), /申请人已无项目访问权限/);
});

test('an unrelated project change does not invalidate a pending request', () => {
  const state = createSeedState();
  let pending = transact(state, 'requestMilestone', updateInput(state), 'u-engineer');
  pending = transact(pending, 'reviewExtension', { id: 'e-pending', approve: true, comment: '同意延期' }, 'u-admin');
  assert.equal(review(pending).milestoneRequests[0].status, 'approved');
});

test('legacy v1 states acquire an empty request collection without being mutated', () => {
  const state = createSeedState();
  assert.deepEqual(state.milestoneRequests, []);
  delete state.milestoneRequests;
  const before = structuredClone(state);
  const updated = transact(state, 'updateTask', { id: 't-02', status: 'doing' }, 'u-qa');
  assert.deepEqual(updated.milestoneRequests, []);
  assert.equal(transact(state, 'requestMilestone', createInput(), 'u-engineer').milestoneRequests.length, 1);
  assert.deepEqual(state, before);
  assert.throws(() => transact({ ...state, milestoneRequests: {} }, 'requestMilestone', createInput(), 'u-engineer'), /节点申请数据无效/);
});
