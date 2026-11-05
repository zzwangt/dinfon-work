import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState, normalizeState, transact, addDays } from '../public/client/domain.js';
import { taskOwners, taskReviewers, canApproveProject, canApproveRequest } from '../public/client/approval-access.js';
import { sanitizeStateForActor } from '../public/client/access.js';
import { openDatabase } from '../server/sqlite.mjs';
import { handleApi } from '../server/service.mjs';

const get = (state, collection, id) => state[collection].find(item => item.id === id);
const proposal = state => ({ projectId: 'p-mower', kind: 'create', title: '补充验证', dueDate: get(state, 'projects', 'p-mower').dueDate });
const pendingNode = (state = createSeedState(), actor = 'u-engineer') => transact(state, 'requestMilestone', proposal(state), actor);
const review = (state, actor, approve = true) => transact(state, 'reviewMilestoneRequest', { id: state.milestoneRequests[0].id, approve }, actor);
const assign = (state, reviewerId, actor = 'u-manager') => transact(state, 'setProjectReviewer', { id: 'p-mower', reviewerId }, actor);

test('administrators and the project owner approve project requests; staff owners need a second person for their own requests', () => {
  const state = createSeedState(), project = get(state, 'projects', 'p-mower');
  project.reviewerId = 'u-qa';
  state.users.push({ id: 'u-total', role: 'superadmin' });
  for (const actor of state.users) {
    const pending = pendingNode(state);
    const allowed = ['superadmin','admin'].includes(actor.role) || actor.id === project.ownerId;
    assert.equal(canApproveProject(project, actor), allowed);
    assert.equal(canApproveRequest(project, pending.milestoneRequests[0], actor), allowed);
    if (allowed) assert.equal(review(pending, actor.id).milestoneRequests[0].status, 'approved');
    else assert.throws(() => review(pending, actor.id));
  }
  assert.throws(() => review(pendingNode(state, project.ownerId), project.ownerId), /不能审批自己/);
  assert.equal(review(pendingNode(state, 'u-total'), 'u-total').milestoneRequests[0].status, 'approved');
});

test('legacy project reviewer assignments stay historical and cannot be configured on new projects', () => {
  const state = createSeedState(), project = get(state, 'projects', 'p-mower');
  project.reviewerId = 'u-qa';
  assert.equal(get(normalizeState(state), 'projects', project.id).reviewerId, 'u-qa');
  assert.throws(() => assign(state, 'u-design'), /已停用/);
  const payload = { name: '独立项目', ownerId: 'u-manager', memberIds: [], startDate: '2099-01-01', dueDate: '2099-02-01' };
  assert.equal(transact(state, 'createProject', payload, 'u-admin').projectPlans[0].project.reviewerId, null);
  assert.throws(() => transact(state, 'createProject', { ...payload, reviewerId: 'u-qa' }, 'u-admin'), /已停用/);
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
  assert.throws(() => review(pendingNode(state, 'u-qa'), 'u-engineer'), /仅项目负责人或管理员/);
  assert.ok(transact(original, 'createTask', { ...input, ownerId: 'u-ops' }, 'u-engineer').projects.find(p=>p.id===input.projectId).memberIds.includes('u-ops'));
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

const setRole = (f, userId, role) => f.call(`/api/accounts/${f.stored().accounts.find(a => a.userId === userId).id}`, 'u-admin', {revision:f.stored().revision,role}, 'PATCH');
function arrange(f, edit) {
  const snapshot = f.stored(); delete snapshot.revision; edit(snapshot.state);
  f.db.sqlite.prepare('UPDATE workspace SET payload=?, revision=revision+1').run(JSON.stringify(snapshot));
}

test('API authorizes requests only for the actual project owner or super administrator', async t => {
  const f = await fixture(t);
  assert.equal((await setRole(f, 'u-qa', 'admin')).status, 200);
  arrange(f, state => { get(state, 'projects', 'p-mower').reviewerId = 'u-qa'; });
  assert.equal((await f.command('setProjectReviewer',{id:'p-mower',reviewerId:'u-qa'})).status, 400);
  const request = await f.command('requestMilestone', proposal(f.stored().state), 'u-engineer');
  assert.equal(request.status, 200);
  const decision = {id:request.data.state.milestoneRequests[0].id,approve:true};
  assert.equal((await f.command('reviewMilestoneRequest',decision,'u-engineer')).status,403);
  assert.equal((await f.command('reviewMilestoneRequest',decision,'u-ops')).status,404);
  assert.equal((await f.command('reviewMilestoneRequest',decision,'u-manager',f.stored().revision-1)).status,409);
  const noticeAccounts = f.stored().notifications.filter(n=>n.action==='requestMilestone'&&n.entityId===decision.id).map(n=>f.stored().accounts.find(a=>a.id===n.accountId).userId).sort();
  assert.deepEqual(noticeAccounts,['u-admin','u-manager','u-qa']);
  assert.equal((await f.command('reviewMilestoneRequest',decision,'u-qa')).status,200);
  assert.equal((await f.command('reviewExtension',{id:'e-pending',approve:true},'u-manager')).status,400);
  assert.equal((await f.command('reviewExtension',{id:'e-pending',approve:true},'u-admin')).status,200);
  const own=await f.command('requestMilestone',proposal(f.stored().state),'u-admin');assert.equal(own.status,200);
  assert.equal((await f.command('reviewMilestoneRequest',{id:own.data.state.milestoneRequests[0].id,approve:true},'u-admin')).status,200);
});

test('stage reviewers are selected from active administrators and two people sign separate positions',async t=>{
  const f=await fixture(t);assert.equal((await setRole(f,'u-qa','admin')).status,200);
  arrange(f,state=>{for(const task of state.tasks.filter(t=>['m-mower-2','m-pcb-2'].includes(t.milestoneId)))task.status='done';});
  const owner=(await f.call('/api/session','u-manager')).data,member=(await f.call('/api/session','u-engineer')).data;
  assert.deepEqual(owner.milestoneReviewerOptions.map(p=>p.id),['u-qa']);
  assert.deepEqual(Object.keys(owner.milestoneReviewerOptions[0]).sort(),['id','name','title']);
  assert.deepEqual(member.milestoneReviewerOptions,[]);
  assert.ok(!member.state.projects.some(p=>p.id==='p-site'));
  const id='m-mower-2',assignment={id,reviewerId:'u-qa'};
  assert.equal((await f.command('setMilestoneCoReviewer',assignment,'u-engineer')).status,403);
  assert.equal((await f.command('setMilestoneCoReviewer',{id,reviewerId:'u-design'})).status,400);
  assert.equal((await f.command('setMilestoneCoReviewer',assignment)).status,200);
  assert.equal((await f.command('completeMilestone',{id,as:'owner'},'u-admin')).status,400);
  const one=await f.command('completeMilestone',{id,as:'owner'},'u-manager');assert.equal(one.status,200,JSON.stringify(one.data));
  assert.notEqual(get(one.data.state,'milestones',id).status,'done');
  assert.equal((await f.command('completeMilestone',{id,as:'coReviewer'},'u-manager')).status,400);
  const second=await f.command('completeMilestone',{id,as:'coReviewer'},'u-qa');assert.equal(second.status,200);
  assert.equal(get(second.data.state,'milestones',id).status,'done');
  const other='m-pcb-2';assert.equal((await f.command('setMilestoneCoReviewer',{id:other,reviewerId:'u-qa'})).status,200);
  assert.equal((await f.command('completeMilestone',{id:other,as:'coReviewer'},'u-qa')).status,200);
  const account=f.stored().accounts.find(a=>a.userId==='u-qa');
  const revoked=await f.call(`/api/accounts/${account.id}`,'u-admin',{revision:f.stored().revision,status:'disabled'},'PATCH');assert.equal(revoked.status,200);
  assert.deepEqual(get(revoked.data.state,'milestones',other).signatures,[]);
  assert.equal(get(revoked.data.state,'milestones',id).signatures.length,2,'completed history is retained');
  assert.deepEqual((await f.call('/api/session','u-manager')).data.milestoneReviewerOptions,[]);
  assert.equal((await f.command('completeMilestone',{id:other})).status,400);
  assert.equal((await f.command('setMilestoneCoReviewer',{id:other,reviewerId:null})).status,200);
  assert.equal((await f.command('completeMilestone',{id:other})).status,200);
});

test('old conflicting task reviewers can be repaired by a project owner without changing delivery history',async t=>{
  const f=await fixture(t),id='t-02';
  arrange(f,state=>{const task=get(state,'tasks',id);Object.assign(task,{reviewerId:task.ownerId,status:'review',deliverable:'已提交成果',submittedAt:'2026-11-03T12:00:00Z'});});
  const before=get(f.stored().state,'tasks',id);
  assert.equal((await f.command('setTaskReviewer',{id,reviewerId:'u-engineer'},'u-engineer')).status,403);
  assert.equal((await f.command('setTaskReviewer',{id,reviewerId:'u-design'},'u-manager')).status,400,'unprovisioned accounts cannot accept');
  const fixed=await f.command('setTaskReviewer',{id,reviewerId:'u-engineer'});assert.equal(fixed.status,200);
  const task=get(fixed.data.state,'tasks',id);assert.equal(task.deliverable,before.deliverable);assert.equal(task.submittedAt,before.submittedAt);
  const mine=(await f.call('/api/session','u-engineer')).data.notifications;
  assert.ok(mine.some(n=>n.entityId===id&&n.action==='submitTask'));
  assert.ok(!(await f.call('/api/session','u-admin')).data.notifications.some(n=>n.entityId===id&&n.action==='submitTask'));
  assert.equal((await f.command('reviewTask',{id,approve:true},'u-engineer')).status,200);
  assert.ok(!(await f.call('/api/session','u-engineer')).data.notifications.some(n=>n.entityId===id&&n.action==='submitTask'));
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

test('checkbox assignments replace the former first owner, protect pending work and require every signature', async t => {
  const f=await fixture(t);
  const {ownerId,reviewerId,...base}=taskPayload(f.stored().state);
  const roster={ownerIds:['u-qa','u-engineer'],reviewerIds:['u-manager','u-admin']};
  for(const bad of [{ownerIds:[]},{reviewerIds:[]},{ownerIds:['u-design']},{reviewerIds:['missing']}]){
    assert.equal((await f.command('createTask',{...base,...roster,...bad})).status,400);
  }
  const created=await f.command('createTask',{...base,...roster});
  assert.equal(created.status,200,JSON.stringify(created.data));const id=created.data.state.tasks.at(-1).id;
  const cmd=(action,payload,actor)=>f.command(action,{id,...payload},actor);
  assert.equal((await cmd('submitTask',{deliverable:'测试记录'},'u-qa')).status,200);
  assert.equal((await cmd('setTaskReviewer',{ownerIds:['u-engineer','u-qa'],reviewerIds:['u-admin','u-manager']})).status,400);
  const swapped=await cmd('setTaskReviewer',{ownerIds:['u-engineer','u-manager'],reviewerIds:['u-qa','u-admin']});
  assert.equal(swapped.status,200,JSON.stringify(swapped.data));
  const task=get(swapped.data.state,'tasks',id);assert.deepEqual(taskOwners(task),['u-engineer','u-manager']);
  assert.deepEqual(taskReviewers(task).sort(),['u-admin','u-qa']);assert.equal(task.deliveryHistory.at(-1).deliveries[0].ownerId,'u-qa');
  assert.equal((await cmd('submitTask',{deliverable:'旧负责人'},'u-qa')).status,400);
  for(const actor of taskOwners(task))assert.equal((await cmd('submitTask',{deliverable:'更新成果'},actor)).status,200);
  assert.equal((await cmd('setTaskReviewer',{ownerIds:['u-engineer'],reviewerIds:['u-qa']})).status,400);
  for(const [actor,status] of [['u-qa','review'],['u-admin','done']]){
    const signed=await cmd('reviewTask',{approve:true},actor);assert.equal(signed.status,200);
    assert.equal(get(signed.data.state,'tasks',id).status,status);
  }
});

test('an administrator self-approves a plan without a roster; assigned employees deliver, self-review and co-sign', async t => {
  const f = await fixture(t);
  await setRole(f,'u-qa','admin');
  const title='跨部门校对';
  const cmd=async(actor,action,payload)=>{
    const result=await f.command(action,payload,actor);
    assert.equal(result.status,200,JSON.stringify(result.data));
    return result.data.state;
  };
  const directory=(await f.call('/api/session','u-ops')).data;
  assert.ok(directory.companyMembers.some(user=>user.id==='u-engineer'));
  assert.ok(directory.companyMembers.every(user=>Object.keys(user).sort().join(',')==='id,name'));
  const input={name:title,ownerId:'u-manager',startDate:'2099-01-01',dueDate:'2099-01-30',stages:[
    {title:'联调阶段',dueDate:'2099-01-20',memberIds:['u-ops'],extraReviewerIds:['u-ops'],tasks:[
      {title,ownerIds:['u-ops'],reviewerIds:['u-ops'],acceptance:'交付记录',dueDate:'2099-01-15'}]}]};
  const plan=(await cmd('u-qa','createProject',input)).projectPlans[0];
  const live=await cmd('u-qa','reviewProjectPlan',{id:plan.id,approve:true});
  const stage=live.milestones.at(-1),task=live.tasks.at(-1),pid=plan.projectId;
  assert.ok((await f.call('/api/session','u-ops')).data.state.projects.some(p=>p.id===pid));
  assert.ok(!(await f.call('/api/session','u-engineer')).data.state.projects.some(p=>p.id===pid));
  await cmd('u-qa','editTaskContent',{id:task.id,title:'更新名称',description:'新说明'});
  await cmd('u-qa','editMilestoneContent',{id:stage.id,title:'更新阶段',description:'新阶段说明'});
  const change=await cmd('u-qa','requestMilestone',{projectId:pid,kind:'create',title:'下一阶段',dueDate:'2099-01-29',memberIds:['u-engineer'],extraReviewerIds:['u-engineer']});
  assert.ok(!(await f.call('/api/session','u-engineer')).data.state.projects.some(p=>p.id===pid));
  await cmd('u-qa','reviewMilestoneRequest',{id:change.milestoneRequests[0].id,approve:true});
  assert.ok((await f.call('/api/session','u-engineer')).data.state.projects.some(p=>p.id===pid));
  await cmd('u-ops','submitTask',{id:task.id,deliverable:'已提交'});
  await cmd('u-ops','reviewTask',{id:task.id,approve:true});
  const half=await cmd('u-ops','completeMilestone',{id:stage.id});
  assert.notEqual(get(half,'milestones',stage.id).status,'done');
  assert.equal((await f.command('completeMilestone',{id:stage.id,as:'owner'},'u-admin')).status,400);
  assert.equal(get(await cmd('u-manager','completeMilestone',{id:stage.id}),'milestones',stage.id).status,'done');
});
