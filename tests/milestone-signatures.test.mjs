import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, transact, addDays } from '../public/client/domain.js';
import { milestoneSignSlots } from '../public/client/approval-access.js';

const id = 'm-mower-2', projectId = 'p-mower', co = 'u-admin', owner = 'u-manager', total = 'u-total';
const byId = (list, key) => list.find(item => item.id === key);
const node = state => byId(state.milestones, id);
const sign = (state, actor, as) => transact(state, 'completeMilestone', as ? { id, as } : { id }, actor);
const assign = (state, reviewerId, actor = owner) => transact(state, 'setMilestoneCoReviewer', { id, reviewerId }, actor);
function fixture() {
  let state = createSeedState();
  state.users.push({ id: total, role: 'superadmin', name: '总管理员' }, { id: 'u-otheradmin', role: 'admin', name: '其他管理员' });
  byId(state.tasks, 't-02').ownerId = co;
  byId(state.tasks, 't-03').ownerId = owner;
  byId(state.tasks, 't-03').reviewerId = 'u-qa';
  for (const task of state.tasks.filter(task => task.milestoneId === id && task.status !== 'done')) {
    if (task.status !== 'review') state = transact(state, 'submitTask', { id: task.id, deliverable: '完成子任务' }, task.ownerId);
    state = transact(state, 'reviewTask', { id: task.id, approve: true }, task.reviewerId);
  }
  return state;
}

test('dedicated co-reviewers must be ordinary administrators distinct from the owner and configured by owner or super admin', () => {
  const state = fixture();
  for (const invalid of [total, 'u-qa', owner]) assert.throws(() => assign(state, invalid), /普通管理员|同一人/);
  for (const actor of [co, 'u-engineer']) assert.throws(() => assign(state, co, actor), /仅项目负责人或总管理员/);
  assert.equal(node(assign(state, co, total)).coReviewerId, co);
  const sharedRole = structuredClone(state);
  byId(sharedRole.users, owner).role = 'admin';
  assert.throws(() => assign(sharedRole, owner), /同一人/);
  assert.throws(() => transact(state, 'setMilestoneCoReviewer', { id }, owner), /明确清除/);
});

test('without a co-reviewer the owner signs once, with one each actual signer must sign even if they executed child tasks', () => {
  const state = fixture();
  assert.equal(node(sign(state, owner)).status, 'done');
  assert.throws(() => sign(state, co), /签字权限/);
  for (const [first, second] of [[owner, co], [co, owner]]) {
    const configured = assign(state, co);
    assert.throws(() => sign(configured, 'u-otheradmin'), /签字权限/);
    const half = sign(configured, first);
    assert.notEqual(node(half).status, 'done');
    assert.equal(node(half).acceptedAt, null);
    assert.equal(node(half).signatures[0].actorId, first);
    assert.throws(() => sign(half, first), /已在此节点签字/);
    const done = node(sign(half, second));
    assert.equal(done.status, 'done');
    assert.ok(done.acceptedAt);
    assert.deepEqual(done.signatures.map(signature => signature.actorId), [first, second]);
    assert.deepEqual(done.signatures.map(signature => signature.as).sort(), ['coReviewer','owner']);
    assert.ok(done.signatures.every(signature => signature.at));
  }
});

test('a super administrator can substitute for either seat, including their own, but never signs both seats', () => {
  const state = assign(fixture(), co);
  for (const [slot, other] of [['owner', co], ['coReviewer', owner]]) {
    const half = sign(state, total, slot);
    assert.throws(() => sign(half, total, slot === 'owner' ? 'coReviewer' : 'owner'), /签字权限/);
    assert.equal(node(sign(half, other)).status, 'done');
  }
  const personal = structuredClone(state);
  byId(personal.projects, projectId).ownerId = total;
  assert.deepEqual(milestoneSignSlots(byId(personal.projects, projectId), node(personal), byId(personal.users, total), personal.tasks), ['owner']);
  const half = sign(personal, total);
  assert.throws(() => sign(half, total), /签字权限/);
  assert.equal(node(sign(half, co)).status, 'done');
  assert.throws(() => transact(state, 'completeMilestone', { id, actorId: owner }, co), /本人/);
});

test('partial signatures are invalidated by changes to approver, accepted work, children, and approved schedules only', () => {
  const original = sign(assign(fixture(), co), owner);
  const child = byId(original.tasks, 't-02');
  const pending = transact(original, 'requestExtension', { projectId, newDueDate: addDays(byId(original.projects, projectId).dueDate, 2), plan: '补充验证', impact: '调整项目周期' }, 'u-engineer');
  assert.deepEqual(node(pending).signatures, node(original).signatures);
  const changed = [
    assign(original, 'u-otheradmin'),
    assign(original, null),
    transact(original, 'editMilestoneContent', { id, title: '更新节点说明' }, owner),
    transact(original, 'editTaskContent', { id: child.id, title: '更新已验收子任务说明' }, owner),
    transact(original, 'deleteTask', { id: child.id, confirm: true }, co),
    transact(original, 'createTask', { projectId, milestoneId: id, title: '新子任务', ownerId: 'u-qa', reviewerId: owner, dueDate: node(original).dueDate, acceptance: '完成检查' }, 'u-engineer'),
    transact(pending, 'reviewExtension', { id: pending.extensions[0].id, approve: true }, owner),
  ];
  for (const state of changed) {
    assert.deepEqual(node(state).signatures, []);
    assert.match(state.logs[0].message, /签字失效/);
    assert.deepEqual(state.logs[0].changes.signatures.before, node(original).signatures);
  }
  assert.equal(node(original).signatures.length, 1);
});

test('old completed nodes stay completed without fabricating signatures and the updateTask route cannot bypass plan editing permissions', () => {
  const old = createSeedState();
  const task = byId(old.tasks, 't-03');
  for (const actor of [task.ownerId, co]) assert.throws(() => transact(old, 'updateTask', { id: task.id, description: '改写工作范围' }, actor), /仅项目负责人或总管理员/);
  const updated = transact(old, 'updateTask', { id: task.id, status: 'doing' }, task.ownerId);
  const done = byId(old.milestones, 'm-mower-1');
  assert.deepEqual(byId(updated.milestones, done.id), done);
  assert.equal(byId(updated.milestones, done.id).signatures, undefined);
});
