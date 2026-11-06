import { createApprovalWorkspace as createSeedState } from './acceptance-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, transact, progressAgainstPlan } from '../public/client/domain.js';
import { openDatabase } from '../server/sqlite.mjs';
import { initializeAuthSchema, hashPassword, issueSession } from '../server/auth.mjs';
import { handleHttpApi, initializeLocalWorkspace } from '../server/service.mjs';

const item = (state, collection, id) => state[collection].find(entry => entry.id === id);
const onlyContent = ({ title, description, acceptance, ...unchanged }) => unchanged;
const taskInput = (state, id = 't-02') => ({ id, title: `${item(state, 'tasks', id).title} · 补充说明`, description: '明确执行步骤与检查方式', acceptance: '提供完整结果及异常处理记录' });
const milestoneInput = (state, id = 'm-mower-2') => ({ id, title: `${item(state, 'milestones', id).title} · 复核`, description: '覆盖本阶段的验证内容与交付范围' });

test('project owners edit task text while identity, schedule and progress stay unchanged', () => {
  const state = createSeedState(), before = structuredClone(state), input = taskInput(state);
  const old = item(state, 'tasks', input.id);
  assert.notEqual(old.ownerId, 'u-engineer');
  const next = transact(state, 'editTaskContent', input, 'u-manager');
  const edited = item(next, 'tasks', input.id);
  assert.equal(edited.title, input.title);
  assert.equal(edited.description, input.description);
  assert.equal(edited.acceptance, input.acceptance);
  assert.deepEqual(onlyContent(edited), onlyContent(old));
  assert.deepEqual(next.projects, state.projects);
  assert.deepEqual(next.milestones, state.milestones);
  assert.deepEqual(progressAgainstPlan(next.tasks), progressAgainstPlan(state.tasks));
  assert.deepEqual(state, before);
  assert.equal(next.logs[0].actorId, 'u-manager');
  assert.deepEqual(next.logs[0].changes.title, { before: old.title, after: edited.title });
  assert.deepEqual(next.logs[0].changes.acceptance, { before: old.acceptance, after: edited.acceptance });
  assert.throws(() => transact(state, 'editTaskContent', input, 'u-ops'), /无权访问该项目/);
  const removed = structuredClone(state);
  item(removed, 'projects', 'p-mower').memberIds = ['u-manager', 'u-qa'];
  assert.throws(() => transact(removed, 'editTaskContent', input, 'u-engineer'), /无权访问该项目/);
});

test('broader text editing does not grant task execution or acceptance permissions', () => {
  const state = createSeedState();
  assert.throws(() => transact(state, 'updateTask', { id: 't-02', status: 'doing' }, 'u-engineer'), /自己负责/);
  assert.throws(() => transact(state, 'submitTask', { id: 't-02', deliverable: '他人的交付成果' }, 'u-engineer'), /仅任务负责人/);
  assert.throws(() => transact(state, 'reviewTask', { id: 't-04', approve: true }, 'u-engineer'), /指定验收人/);
});

test('submitted and completed tasks keep their original acceptance criteria and delivery records', () => {
  for (const id of ['t-04', 't-01']) {
    const state = createSeedState(), old = item(state, 'tasks', id);
    const input = { id, title: `${old.title}（文字校对）`, description: '修正说明中的文字' };
    const next = transact(state, 'editTaskContent', input, 'u-manager');
    assert.deepEqual(onlyContent(item(next, 'tasks', id)), onlyContent(old));
    assert.equal(item(next, 'tasks', id).acceptance, old.acceptance);
    assert.doesNotThrow(() => transact(state, 'editTaskContent', { ...input, acceptance: old.acceptance }, 'u-manager'));
    assert.throws(() => transact(state, 'editTaskContent', { ...input, acceptance: '改成更低的标准' }, 'u-manager'), /验收标准不能修改/);
  }
});

test('project owners and super administrators directly edit major-node text, including completed nodes without reopening them', () => {
  for (const id of ['m-mower-2', 'm-mower-1']) {
    const state = createSeedState(), input = milestoneInput(state, id), old = item(state, 'milestones', id);
    for (const actor of ['u-qa', 'u-engineer']) assert.throws(() => transact(state, 'editMilestoneContent', input, actor), /仅项目负责人或管理员/);
    const next = transact(state, 'editMilestoneContent', input, 'u-admin');
    assert.equal(item(next, 'milestones', id).description, input.description);
    assert.deepEqual(onlyContent(item(next, 'milestones', id)), onlyContent(old));
    assert.deepEqual(next.tasks, state.tasks);
    assert.deepEqual(next.projects, state.projects);
    assert.deepEqual(next.logs[0].changes.description, { before: '', after: input.description });
  }
});

test('content commands reject hidden schedule, assignment, project and status changes and invalid text', () => {
  const state = createSeedState();
  for (const [action, input] of [['editTaskContent', taskInput(state)], ['editMilestoneContent', milestoneInput(state)]]) {
    for (const field of ['projectId', 'dueDate', 'status', 'ownerId', 'reviewerId', 'milestoneId']) {
      assert.throws(() => transact(state, action, { ...input, [field]: 'forged' }, 'u-admin'), /只能修改/);
    }
    assert.throws(() => transact(state, action, { ...input, title: ' ' }, 'u-admin'), /请填写/);
    assert.throws(() => transact(state, action, { ...input, title: '字'.repeat(101) }, 'u-admin'), /100/);
    assert.throws(() => transact(state, action, { ...input, description: '字'.repeat(2001) }, 'u-admin'), /2000/);
    assert.doesNotThrow(() => transact(state, action, { ...input, description: '' }, 'u-admin'));
  }
  assert.throws(() => transact(state, 'editTaskContent', { ...taskInput(state), acceptance: ' ' }, 'u-admin'), /验收标准/);
  const old = item(state, 'tasks', 't-02');
  assert.throws(() => transact(state, 'editTaskContent', { id: old.id, title: old.title }, 'u-manager'), /没有变化/);
});

test('major-node descriptions survive legacy normalization and later plan approvals; renamed plans invalidate stale proposals', () => {
  const legacy = createSeedState();
  delete item(legacy, 'milestones', 'm-mower-2').description;
  assert.equal(item(normalizeState(legacy), 'milestones', 'm-mower-2').description, '');
  assert.equal(Object.hasOwn(item(legacy, 'milestones', 'm-mower-2'), 'description'), false);
  const state = createSeedState(), node = item(state, 'milestones', 'm-mower-2');
  const pending = transact(state, 'requestMilestone', { projectId: node.projectId, kind: 'update', milestoneId: node.id, title: `${node.title}与复核`, dueDate: node.dueDate }, 'u-engineer');
  const requestId = pending.milestoneRequests[0].id;
  const withContent = transact(pending, 'editMilestoneContent', { id: node.id, title: node.title, description: '新增的阶段内容' }, 'u-admin');
  const approved = transact(withContent, 'reviewMilestoneRequest', { id: requestId, approve: true }, 'u-admin');
  assert.equal(item(approved, 'milestones', node.id).description, '新增的阶段内容');
  assert.equal(item(approved, 'milestones', node.id).title, `${node.title}与复核`);
  const renamed = transact(pending, 'editMilestoneContent', milestoneInput(pending), 'u-admin');
  assert.throws(() => transact(renamed, 'reviewMilestoneRequest', { id: requestId, approve: true }, 'u-admin'), /节点计划已变化/);
  const addedRequest = transact(state, 'requestMilestone', { projectId: node.projectId, kind: 'create', title: '补充节点', dueDate: node.dueDate }, 'u-engineer');
  const added = transact(addedRequest, 'reviewMilestoneRequest', { id: addedRequest.milestoneRequests[0].id, approve: true }, 'u-admin');
  assert.equal(added.milestones.at(-1).description, '');
});

const ORIGIN = 'https://node-edit.example';
const PASSWORD_HASH = await hashPassword('Isolated node editing test credential');
async function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  await initializeAuthSchema(db);
  const env = { DB: db, SITE_ORIGIN: ORIGIN, INITIAL_ADMIN_LOGIN: 'owner', INITIAL_ADMIN_PASSWORD_HASH: PASSWORD_HASH, SEED_DEMO_DATA: true };
  await initializeLocalWorkspace(env);
  const stored = () => { const row = db.sqlite.prepare("SELECT payload,revision FROM workspace WHERE id='main'").get(); return { ...JSON.parse(row.payload), revision: row.revision }; };
  const cookies = {};
  for (const id of ['u-admin', 'u-engineer', 'u-qa', 'u-manager', 'u-ops']) {
    const workspace = stored(); let account = workspace.accounts.find(entry => entry.userId === id);
    if (!account) {
      account = { id: `account-${id}`, userId: id, login: `login-${id}`, status: 'active' };
      workspace.accounts.push(account); delete workspace.revision;
      db.sqlite.prepare("UPDATE workspace SET payload=?,revision=revision+1 WHERE id='main'").run(JSON.stringify(workspace));
      db.sqlite.prepare('INSERT INTO auth_credentials VALUES (?,?,?,0,1,?)').run(account.id, account.login, PASSWORD_HASH, new Date().toISOString());
    }
    const credential = db.sqlite.prepare('SELECT * FROM auth_credentials WHERE account_id=?').get(account.id);
    cookies[id] = (await issueSession(db, env, credential)).split(';')[0];
  }
  const call = async (path, userId, data) => {
    const response = await handleHttpApi(new Request(ORIGIN + path, { method: data ? 'POST' : 'GET', headers: { Cookie: cookies[userId], ...(data ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }), env);
    return { status: response.status, data: await response.json() };
  };
  const command = (action, payload, actor = 'u-engineer', revision = stored().revision) => call('/api/command', actor, { action, payload, revision });
  return { db, env, stored, call, command };
}

test('HTTP text commands respect current project scope, administrator-only major edits and CAS conflicts', async t => {
  const f = await fixture(t), original = f.stored(), input = taskInput(original.state);
  const saved = await f.command('editTaskContent', input, 'u-manager');
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(item(saved.data.state, 'tasks', input.id).title, input.title);
  assert.equal(saved.data.actor.role, 'member');
  assert.equal(saved.data.actor.id, 'u-manager');
  const beforeDenied = f.stored();
  assert.equal((await f.command('editTaskContent', { ...input, title: '过期覆盖' }, 'u-qa', original.revision)).status, 409);
  assert.equal((await f.command('editTaskContent', { id: 't-13', title: '其他项目内容' })).status, 404);
  assert.equal((await f.command('editTaskContent', { ...input, projectId: 'p-site' }, 'u-manager')).status, 400);
  assert.equal((await f.command('editMilestoneContent', milestoneInput(original.state))).status, 403);
  assert.equal((await f.command('editMilestoneContent', { id: 'm-site-3', title: '无权项目' })).status, 404);
  assert.deepEqual(f.stored(), beforeDenied);
  const editedNode = await f.command('editMilestoneContent', milestoneInput(original.state), 'u-admin');
  assert.equal(editedNode.status, 200, JSON.stringify(editedNode.data));
  assert.equal(item(editedNode.data.state, 'milestones', 'm-mower-2').description, '覆盖本阶段的验证内容与交付范围');
  assert.equal(editedNode.data.state.milestoneRequests.length, original.state.milestoneRequests.length);
});

test('text-only edits produce scoped notifications and audit records without changing delivery permissions', async t => {
  const f = await fixture(t), initial = f.stored();
  const result = await f.command('editTaskContent', taskInput(initial.state), 'u-manager');
  assert.equal(result.status, 200);
  const notifications = f.stored().notifications.filter(notice => notice.action === 'editTaskContent');
  assert.equal(notifications.length, 3, 'other current project participants and admin get one notice each');
  assert.ok(notifications.every(notice => notice.entityId === 't-02' && notice.category === 'tasks'));
  assert.ok(!notifications.some(notice => ['account-u-manager', 'account-u-ops'].includes(notice.accountId)));
  assert.match((await f.call('/api/session', 'u-qa')).data.notifications[0].title, /任务内容已更新/);
  const beforeDenied = f.stored();
  assert.equal((await f.command('updateTask', { id: 't-02', status: 'doing' })).status, 400);
  assert.equal((await f.command('submitTask', { id: 't-02', deliverable: '试图提交他人的成果' })).status, 400);
  assert.equal((await f.command('editTaskContent', { id: 't-04', title: '校对名称', acceptance: '更改已提交标准' }, 'u-manager')).status, 400);
  assert.deepEqual(f.stored(), beforeDenied);
  const node = item(f.stored().state, 'milestones', 'm-mower-2');
  const edited = await f.command('editMilestoneContent', { id: node.id, title: node.title, description: '只更新节点正文' }, 'u-admin');
  assert.equal(edited.status, 200);
  const notices = f.stored().notifications.filter(notice => notice.action === 'editMilestoneContent');
  assert.equal(notices.length, 3);
  assert.ok(notices.every(notice => notice.category === 'projects' && notice.entityId === node.id));
  assert.deepEqual(f.stored().state.logs[0].changes.description, { before: '', after: '只更新节点正文' });
});

test('local stage-reviewer options expose only minimal profiles of enabled login-capable admins to project owners',async t=>{
  const f=await fixture(t),snapshot=f.stored();delete snapshot.revision;
  for(const id of ['eligible','unbound','disabled']){
    snapshot.state.users.push({id,name:id,title:'阶段验收',role:'admin',department:'不对外分享'});
    snapshot.accounts.push({id:'acc-'+id,userId:id,login:id,status:id==='disabled'?'disabled':'active'});
    if(id!=='unbound')f.db.sqlite.prepare('INSERT INTO auth_credentials VALUES(?,?,?,0,1,?)').run('acc-'+id,id,PASSWORD_HASH,new Date().toISOString());
  }
  f.db.sqlite.prepare('UPDATE workspace SET payload=?,revision=revision+1').run(JSON.stringify(snapshot));
  const owner=await f.call('/api/session','u-manager');assert.equal(owner.status,200);
  assert.deepEqual(owner.data.milestoneReviewerOptions,[{id:'eligible',name:'eligible',title:'阶段验收'}]);
  assert.ok(!owner.data.state.users.some(user=>user.id==='eligible'));
  assert.deepEqual((await f.call('/api/session','u-engineer')).data.milestoneReviewerOptions,[]);
  for(const reviewerId of ['unbound','disabled']){
    assert.equal((await f.command('setMilestoneCoReviewer',{id:'m-mower-2',reviewerId},'u-admin')).status,400);
  }
  const forbidden=await f.command('setMilestoneCoReviewer',{id:'m-mower-2',reviewerId:'eligible'},'u-manager');
  assert.equal(forbidden.status,403);assert.equal(forbidden.data.code,'PROJECT_PARTICIPANT_MANAGER_REQUIRED');
  const saved=await f.command('setMilestoneCoReviewer',{id:'m-mower-2',reviewerId:'eligible'},'u-admin');
  assert.equal(saved.status,200);assert.equal(saved.data.state.milestones.find(node=>node.id==='m-mower-2').coReviewerId,'eligible');
});
