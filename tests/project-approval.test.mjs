import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, normalizeState, transact, addDays } from '../public/client/domain.js';
import { canApproveProject, canApproveRequest } from '../public/client/approval-access.js';
import { sanitizeStateForActor } from '../public/client/access.js';
import { openDatabase } from '../server/sqlite.mjs';
import { handleApi } from '../server/service.mjs';

const get = (state, collection, id) => state[collection].find(item => item.id === id);
const proposal = state => ({ projectId: 'p-mower', kind: 'create', title: '补充验证', dueDate: get(state, 'projects', 'p-mower').dueDate });
const pendingNode = (state = createSeedState(), actor = 'u-engineer') => transact(state, 'requestMilestone', proposal(state), actor);
const review = (state, actor, approve = true) => transact(state, 'reviewMilestoneRequest', { id: state.milestoneRequests[0].id, approve }, actor);
const assign = (state, reviewerId, actor = 'u-manager') => transact(state, 'setProjectReviewer', { id: 'p-mower', reviewerId }, actor);

test('project approval identity is explicit and pending requests cannot be approved by their applicant', () => {
  const project = { id: 'p', ownerId: 'owner', reviewerId: 'reviewer' };
  const request = { projectId: 'p', applicantId: 'member', status: 'pending' };
  assert.equal(canApproveProject(project, 'owner'), true);
  assert.equal(canApproveProject(project, 'reviewer'), true);
  assert.equal(canApproveProject(project, 'admin'), false);
  assert.equal(canApproveProject(null, 'owner'), false);
  assert.equal(canApproveRequest(project, request, 'reviewer'), true);
  assert.equal(canApproveRequest(project, { ...request, applicantId: 'owner' }, 'owner'), false);
  assert.equal(canApproveRequest(project, { ...request, status: 'approved' }, 'owner'), false);
  assert.equal(canApproveRequest(project, { ...request, projectId: 'other' }, 'owner'), false);
});

test('legacy projects acquire no administrator approval grant and project reviewers remain visible in scoped profiles', () => {
  const old = createSeedState();
  for (const project of old.projects) delete project.reviewerId;
  const normalized = normalizeState(old);
  assert.ok(normalized.projects.every(project => project.reviewerId === null));
  assert.ok(old.projects.every(project => !Object.hasOwn(project, 'reviewerId')));
  const pending = pendingNode(old);
  assert.throws(() => review(pending, 'u-admin'), /仅项目负责人或项目验收人/);
  assert.equal(review(pending, 'u-manager').milestoneRequests[0].status, 'approved');
  const visible = sanitizeStateForActor(createSeedState(), 'u-engineer');
  assert.ok(visible.users.some(user => user.id === 'u-admin'));
  assert.ok(!visible.projects.some(project => project.id === 'p-site'));
});

test('owner and independent member reviewer may approve nodes; admin status and task-review assignment grant no project approval', () => {
  const state = assign(createSeedState(), 'u-qa');
  const pending = pendingNode(state);
  for (const actor of ['u-manager', 'u-qa']) assert.equal(review(pending, actor).milestoneRequests[0].reviewerId, actor);
  for (const actor of ['u-admin', 'u-engineer', 'u-design']) assert.throws(() => review(pending, actor), /仅项目负责人或项目验收人/);
  const taskReviewer = structuredClone(pending);
  taskReviewer.tasks.forEach(task => { task.reviewerId = 'u-design'; });
  assert.throws(() => review(taskReviewer, 'u-design'), /仅项目负责人或项目验收人/);
  for (const actor of ['u-manager', 'u-qa']) {
    const own = pendingNode(state, actor);
    for (const approve of [true, false]) assert.throws(() => review(own, actor, approve), /不能审批自己/);
  }
  assert.deepEqual(pending.tasks, state.tasks);
  assert.deepEqual(pending.projects, state.projects);
});

test('extension approvals use project roles and reject self approval while retaining original plans', () => {
  const state = assign(createSeedState(), 'u-qa');
  const project = get(state, 'projects', 'p-mower');
  const payload = { projectId: project.id, newDueDate: addDays(project.dueDate, 2), plan: '补充验证', impact: '项目延期' };
  const pending = transact(state, 'requestExtension', payload, 'u-manager');
  const command = { id: pending.extensions[0].id, approve: true };
  assert.throws(() => transact(pending, 'reviewExtension', command, 'u-manager'), /不能审批自己/);
  assert.throws(() => transact(pending, 'reviewExtension', command, 'u-admin'), /仅项目负责人或项目验收人/);
  const approved = transact(pending, 'reviewExtension', command, 'u-qa');
  assert.equal(get(approved, 'projects', project.id).originalDueDate, project.originalDueDate);
  assert.deepEqual(approved.tasks, state.tasks);
  assert.deepEqual(approved.milestones, state.milestones);
  const adminRequest = transact(state, 'requestExtension', payload, 'u-admin');
  assert.equal(transact(adminRequest, 'reviewExtension', { id: adminRequest.extensions[0].id, approve: false }, 'u-manager').extensions[0].status, 'rejected');
});

test('project reviewer settings permit owner/admin, preserve business data, revoke old assignment, and allow clearing', () => {
  const original = createSeedState();
  assert.throws(() => assign(original, 'u-qa', 'u-engineer'), /仅项目负责人/);
  assert.throws(() => assign(original, 'u-ops'), /当前项目成员/);
  assert.throws(() => assign(original, 'missing'), /项目验收人不存在/);
  const state = assign(original, 'u-qa');
  for (const collection of ['tasks', 'milestones', 'extensions']) assert.deepEqual(state[collection], original[collection]);
  const pending = pendingNode(state);
  const reassigned = assign(pending, 'u-design', 'u-admin');
  assert.throws(() => review(reassigned, 'u-qa'), /仅项目负责人或项目验收人/);
  assert.equal(review(reassigned, 'u-design').milestoneRequests[0].status, 'approved');
  const cleared = assign(pending, null);
  assert.equal(get(cleared, 'projects', 'p-mower').reviewerId, null);
  assert.throws(() => review(cleared, 'u-qa'), /仅项目负责人或项目验收人/);
  const sameOwner = assign(original, 'u-manager');
  assert.equal(get(sameOwner, 'projects', 'p-mower').reviewerId, 'u-manager');
  const removed = structuredClone(pending);
  get(removed, 'projects', 'p-mower').memberIds = ['u-manager', 'u-engineer'];
  assert.throws(() => review(removed, 'u-qa'), /无权访问/);
});

test('new projects optionally include an explicit reviewer and never default approval to a platform administrator', () => {
  const state = createSeedState();
  const payload = { name: '独立项目', ownerId: 'u-manager', memberIds: [], startDate: '2099-01-01', dueDate: '2099-02-01' };
  const plain = transact(state, 'createProject', payload, 'u-admin').projects.at(-1);
  assert.equal(plain.reviewerId, null);
  assert.deepEqual(plain.memberIds, ['u-manager']);
  const assigned = transact(state, 'createProject', { ...payload, reviewerId: 'u-qa' }, 'u-admin').projects.at(-1);
  assert.equal(assigned.reviewerId, 'u-qa');
  assert.deepEqual(assigned.memberIds, ['u-manager', 'u-qa']);
  assert.throws(() => transact(state, 'createProject', { ...payload, reviewerId: 'missing' }, 'u-admin'), /项目验收人不存在/);
});

const taskPayload = state => ({ projectId: 'p-mower', milestoneId: 'm-mower-2', title: '文员登记的测试任务', ownerId: 'u-qa', reviewerId: 'u-manager', dueDate: get(state, 'milestones', 'm-mower-2').dueDate, acceptance: '提交测试记录' });
test('a current project member may create a task for another member without gaining execution, review or approval rights', () => {
  const original = createSeedState(), input = taskPayload(original);
  const state = transact(original, 'createTask', { ...input, createdBy: 'u-admin', createdAt: '2000-01-01' }, 'u-engineer');
  const task = state.tasks.at(-1);
  assert.equal(task.createdBy, 'u-engineer');
  assert.equal(task.createdAt, state.logs[0].at);
  assert.equal(task.status, 'todo');
  assert.equal(task.ownerId, 'u-qa');
  assert.throws(() => transact(original, 'createTask', input, 'u-ops'), /无权访问/);
  assert.throws(() => transact(state, 'updateTask', { id: task.id, status: 'doing' }, 'u-engineer'), /自己负责/);
  assert.throws(() => transact(state, 'submitTask', { id: task.id, deliverable: '代交' }, 'u-engineer'), /仅任务负责人/);
  const submitted = transact(state, 'submitTask', { id: task.id, deliverable: '正式成果' }, 'u-qa');
  assert.throws(() => transact(submitted, 'reviewTask', { id: task.id, approve: true }, 'u-engineer'), /指定验收人/);
  assert.throws(() => review(pendingNode(state, 'u-qa'), 'u-engineer'), /仅项目负责人或项目验收人/);
  assert.throws(() => transact(original, 'createTask', { ...input, ownerId: 'u-ops' }, 'u-engineer'), /项目组成员/);
  assert.throws(() => transact(original, 'createTask', { ...input, milestoneId: 'm-site-3' }, 'u-engineer'), /不属于该项目/);
  assert.throws(() => transact(original, 'createTask', { ...input, milestoneId: 'm-mower-1' }, 'u-engineer'), /已验收节点/);
  assert.throws(() => transact(original, 'createTask', { ...input, dueDate: '2100-01-01' }, 'u-engineer'), /项目周期/);
});

const ORIGIN = 'https://project-approvals.example';
const identities = Object.fromEntries(['admin', 'engineer', 'manager', 'qa', 'ops'].map(name => [`u-${name}`, { userId: `auth-${name}`, email: `${name}@example.com`, displayName: name }]));
async function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const env = { DB: db, FIRST_ADMIN_EMAIL: identities['u-admin'].email };
  const call = async (path, actor = 'u-admin', data, method = data ? 'POST' : 'GET') => {
    const response = await handleApi(new Request(ORIGIN + path, { method, headers: data ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}, ...(data ? { body: JSON.stringify(data) } : {}) }), env, identities[actor]);
    return { status: response.status, data: await response.json() };
  };
  const stored = () => { const row = db.sqlite.prepare("SELECT payload,revision FROM workspace WHERE id='main'").get(); return { ...JSON.parse(row.payload), revision: row.revision }; };
  await call('/api/session');
  for (const id of ['u-engineer', 'u-manager', 'u-qa', 'u-ops']) {
    const result = await call('/api/accounts', 'u-admin', { revision: stored().revision, existingUserId: id, email: identities[id].email, name: identities[id].displayName, role: 'member' });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal((await call('/api/session', id)).status, 200);
  }
  const command = (action, payload, actor = 'u-manager', revision = stored().revision) => call('/api/command', actor, { action, payload, revision });
  return { db, call, stored, command };
}

test('API enforces assigned project approvers, current scope, reassignments and stale revisions without leaking approval rights', async t => {
  const f = await fixture(t);
  assert.equal((await f.command('setProjectReviewer', { id: 'p-mower', reviewerId: 'u-qa' })).status, 200);
  const requested = await f.command('requestMilestone', proposal(f.stored().state), 'u-engineer');
  assert.equal(requested.status, 200);
  const requestId = requested.data.state.milestoneRequests[0].id;
  const body = { id: requestId, approve: true }, before = f.stored();
  assert.equal((await f.command('reviewMilestoneRequest', body, 'u-admin')).status, 403);
  assert.equal((await f.command('reviewMilestoneRequest', body, 'u-engineer')).status, 403);
  assert.equal((await f.command('reviewMilestoneRequest', body, 'u-ops')).status, 404);
  assert.equal((await f.command('setProjectReviewer', { id: 'p-mower', reviewerId: 'u-engineer' }, 'u-engineer')).status, 400);
  assert.equal((await f.command('setProjectReviewer', { id: 'p-site', reviewerId: 'u-engineer' }, 'u-engineer')).status, 404);
  assert.deepEqual(f.stored(), before);
  const stale = before.revision;
  assert.equal((await f.command('setProjectReviewer', { id: 'p-mower', reviewerId: 'u-engineer' })).status, 200);
  assert.equal((await f.command('reviewMilestoneRequest', body, 'u-qa')).status, 403);
  assert.equal((await f.command('reviewMilestoneRequest', body, 'u-engineer')).status, 400, 'assigned applicant cannot self approve');
  assert.equal((await f.command('reviewMilestoneRequest', body, 'u-manager', stale)).status, 409);
  assert.equal((await f.command('reviewMilestoneRequest', body, 'u-manager')).status, 200);
  assert.equal((await f.command('setProjectReviewer', { id: 'p-pcb', reviewerId: 'u-qa' })).status, 200);
  assert.equal((await f.command('reviewExtension', { id: 'e-pending', approve: true }, 'u-admin')).status, 403);
  assert.equal((await f.command('reviewExtension', { id: 'e-pending', approve: true }, 'u-manager')).status, 400);
  assert.equal((await f.command('reviewExtension', { id: 'e-pending', approve: true }, 'u-qa')).status, 200);
});

test('approval notices go to assigned owner/reviewer, follow reassignment, and membership removal clears reviewer rights', async t => {
  const f = await fixture(t);
  await f.command('setProjectReviewer', { id: 'p-mower', reviewerId: 'u-qa' });
  const requested = await f.command('requestMilestone', proposal(f.stored().state), 'u-engineer');
  const id = requested.data.state.milestoneRequests[0].id;
  const notices = f.stored().notifications.filter(entry => entry.action === 'requestMilestone' && entry.entityId === id);
  const recipients = notices.map(entry => f.stored().accounts.find(account => account.id === entry.accountId).userId).sort();
  assert.deepEqual(recipients, ['u-manager', 'u-qa']);
  await f.command('setProjectReviewer', { id: 'p-mower', reviewerId: 'u-engineer' });
  assert.ok(!(await f.call('/api/session', 'u-qa')).data.notifications.some(entry => entry.entityId === id));
  assert.ok(!(await f.call('/api/session', 'u-engineer')).data.notifications.some(entry => entry.entityId === id), 'applicant never receives own pending approval notice');
  await f.command('setProjectReviewer', { id: 'p-mower', reviewerId: 'u-qa' });
  assert.ok((await f.call('/api/session', 'u-qa')).data.notifications.some(entry => entry.entityId === id));
  const account = f.stored().accounts.find(entry => entry.userId === 'u-qa');
  const projectIds = f.stored().state.projects.filter(project => project.id !== 'p-mower' && project.memberIds.includes('u-qa')).map(project => project.id);
  const removed = await f.call(`/api/accounts/${account.id}`, 'u-admin', { revision: f.stored().revision, projectIds }, 'PATCH');
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(get(f.stored().state, 'projects', 'p-mower').reviewerId, null);
  assert.equal((await f.command('reviewMilestoneRequest', { id, approve: true }, 'u-qa')).status, 404);
  assert.ok(!(await f.call('/api/session', 'u-qa')).data.notifications.some(entry => entry.projectId === 'p-mower'));
});

test('API accepts member task registration with trusted creator metadata and retains execution restrictions', async t => {
  const f = await fixture(t), before = f.stored();
  const result = await f.command('createTask', { ...taskPayload(before.state), createdBy: 'u-admin', createdAt: '2000-01-01' }, 'u-engineer');
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const task = result.data.state.tasks.at(-1);
  assert.equal(task.createdBy, 'u-engineer');
  assert.equal(task.createdAt, f.stored().state.logs[0].at);
  assert.equal((await f.command('createTask', taskPayload(before.state), 'u-ops')).status, 404);
  assert.equal((await f.command('updateTask', { id: task.id, status: 'doing' }, 'u-engineer')).status, 400);
  assert.equal((await f.command('submitTask', { id: task.id, deliverable: '替别人交付' }, 'u-engineer')).status, 400);
  assert.equal((await f.command('submitTask', { id: task.id, deliverable: '成果完整' }, 'u-qa')).status, 200);
  assert.equal((await f.command('reviewTask', { id: task.id, approve: true }, 'u-engineer')).status, 400);
});
