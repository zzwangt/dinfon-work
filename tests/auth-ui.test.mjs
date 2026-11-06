import * as rosterUI from '../public/client/node-people.js';
import * as peopleAccess from '../public/client/approval-access.js';
import * as planUI from '../public/client/project-plan.js';
import { isAdminRole, isSuperAdminRole, normalizeRole, ROLE_LABELS } from '../public/client/roles.js';
import { canApproveProject, canApproveRequest, canReviewTask, canManageProjectPlan, canSignMilestone, milestoneSignSlots } from '../public/client/approval-access.js';
import { renderMaintenancePanel, bindMaintenancePanel, resetMaintenance, maintenanceIsBusy } from '../public/client/maintenance.js';
import { refreshFlowFileCounts, hasActiveFileOperations } from '../public/client/files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as domain from '../public/client/domain.js';
import * as times from '../public/client/time.js';
import { canAccessRoute, sanitizeStateForActor } from '../public/client/access.js';
import { renderMilestoneProgress } from '../public/client/milestone-progress.js';
import { renderProjectFlow } from '../public/client/flow.js';
import { renderNodeFiles, bindProjectFiles, resetProjectFiles } from '../public/client/files.js';
import * as noticeUI from '../public/client/notifications.js';
import { renderProjectPeopleSummary } from '../public/client/project-team.js';
import { renderProgressNote, renderProgressTrack } from '../public/client/progress.js';
import { taskReminderSummary, approvalReminderSummary } from '../public/client/task-reminders.js';
import { renderMilestoneRequestCard, requestComparison } from '../public/client/milestone-requests.js';
import { buildWeeklyReport, createWeeklyExport } from '../public/client/weekly-export.js';

// Exercise the browser controller with controlled network timing. No credentials are real.
const source = (await readFile(new URL('../public/client/app.js', import.meta.url), 'utf8'))
  .replace(/^import .+;\n/gm, '')
  .replace(/^await loadSession\(\);$/m, '');
function harness(fetchImpl, overrides = {}) {
  const app = { innerHTML: '' }, content = { innerHTML: '' };
  const downloads=[], objectUrls=new Map();
  class DownloadURL extends URL {
    static createObjectURL(blob) { const id=`blob:test-${objectUrls.size}`;objectUrls.set(id,blob);return id; }
    static revokeObjectURL(id) { objectUrls.delete(id); }
  }
  const toast = { hidden: true, textContent: '', classList: { toggle() {} } };
  const modal = { innerHTML: '', open: false, close() { this.open=false; }, showModal() { this.open=true; }, querySelector(selector) { return selector==='.modal-footer > button[data-action="close-modal"]'?{textContent:''}:null; }, addEventListener() {} };
  const location = { hash: '#tasks', pathname: '/', search: '' }, listeners = new Map();
  const document = {
    title: '', hidden: false,
    querySelector: (selector) => ({ '#app':app, '#content':content, '#modal':modal, '#toast':toast }[selector]),
    querySelectorAll: () => [],
    createElement: tag => { assert.equal(tag,'a');return {href:'',download:'',click(){downloads.push({filename:this.download,blob:objectUrls.get(this.href)});},remove(){}}; },
    body: {append() {}},
    addEventListener: (name,fn) => listeners.set(`document:${name}`,fn),
  };
  const context = {
    ...rosterUI, ...peopleAccess, ...planUI, ...domain, ...times, refreshFlowFileCounts, isAdminRole, isSuperAdminRole, normalizeRole, ROLE_LABELS, canApproveProject, canApproveRequest, canReviewTask, canManageProjectPlan, canSignMilestone, milestoneSignSlots, ...noticeUI, renderMaintenancePanel, bindMaintenancePanel, resetMaintenance, maintenanceIsBusy, hasActiveFileOperations, canAccessRoute, document, location,
    window: { addEventListener:(name,fn)=>listeners.set(`window:${name}`,fn), scrollTo() {} },
    history: { replaceState(_state,_unused,url) { location.hash=url.includes('#')?url.slice(url.indexOf('#')):''; } },
    fetch: fetchImpl, FormData, Response, URL:DownloadURL, Blob, Set, console,
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}, queueMicrotask,
    renderInstallCard:()=>'<aside>手机桌面版</aside>', initPWA() {},
    renderMilestoneProgress, renderProgressNote, renderProgressTrack,
    taskReminderSummary, approvalReminderSummary, renderMilestoneRequestCard, requestComparison, buildWeeklyReport, createWeeklyExport,
    renderProjectFlow, renderProjectPeopleSummary, renderNodeFiles, bindProjectFiles, resetProjectFiles, bindFlowCanvas() {},
    ...overrides,
  };
  const ui=runInNewContext(`(()=>{${source}\nreturn {acceptSession,loadSession,submitAuth,logout,render,authScreen,getState:()=>state,getAccount:()=>accountInfo,getActor:()=>actorId,newAccount,editAccount,accountRowActions,accountsPage,myAccountPage,settingsPage,projectsPage,resetPassword,deleteAccount,saveAccountDeletion,savePasswordReset,saveAccount,projectRow,projectWorkspace,newProject,newTask,setTaskReviewer,setMilestoneCoReviewer,signMilestone,reviewTask,reviewNodeRequest,reviewExtension,tasksPage,milestoneDetail,newMilestone,newExtension,newNodeExtension,editMilestoneContent,editTaskContent,deleteTask,deleteMilestone,deleteProject,saveEntityDeletion,saveTaskDeletion,taskDetail,taskRow,weeklyPage,approvalsPage,notificationCenter,markNotificationsRead,readEntityNotifications,openNotification,loadAccounts,addProjectMember,saveProjectMember,availableProjectAccounts,getNotifications:()=>notifications};})()`,context);
  return {ui,app,content,toast,modal,location,listeners,downloads};
}
function session(overrides={}) {
  const state=domain.createSeedState();state.users.find(user=>user.id==='u-admin').role='superadmin';
  return {state,taskReviewerIds:state.users.map(u=>u.id),milestoneReviewerOptions:[],actor:state.users.find(user=>user.id==='u-admin'),account:{id:'a-admin',login:'qa-admin',role:'superadmin',mustChangePassword:false},revision:1,...overrides};
}
function restrictedSession() {
  return {actor:{id:'u-new',name:'新员工',role:'member'},account:{id:'a-new',login:'new.employee',role:'member',mustChangePassword:true},revision:1,mustChangePassword:true,capabilities:{}};
}
function form() {
  const button={disabled:false,textContent:'登录工作空间'};
  const password={value:'disposable-example-password',focused:false,focus(){this.focused=true;}};
  const attributes=new Map();
  return {button,elements:{password},querySelector:()=>button,setAttribute:(key,value)=>attributes.set(key,value),removeAttribute:key=>attributes.delete(key),attributes,reset(){password.value='';this.resetCalled=true;}};
}
function deferred() {let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}

const notice=(id,category='tasks',entityId='qa-task',projectId='p-mower')=>({id,category,entityId,projectId,title:'新的任务动态',createdAt:'2026-10-26T08:00:00.000Z',target:'#tasks'});

function taskBox(owners=[],signers=[]) {
  return {ownerDocument:{activeElement:null},contains:()=>false,innerHTML:'',
    querySelectorAll:sel=>(sel.includes('"owners"')?owners:signers).map(value=>({value}))};
}

test('new tasks offer two empty checklists containing eligible active people',()=>{
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session(),project=data.state.projects.find(item=>item.id==='p-mower');
  data.taskReviewerIds=['u-admin','u-manager','u-qa'];ui.acceptSession(data);ui.newTask(project.id,'m-mower-2');
  assert.match(modal.innerHTML,/负责人（可多选）/);assert.match(modal.innerHTML,/验收人（可多选）/);
  assert.doesNotMatch(modal.innerHTML,/主负责人|协作成员|name="(?:ownerId|reviewerId)"| checked/);
  assert.match(modal.innerHTML,/data-roster="owners" value="u-qa"/);
  for(const id of ['u-qa','u-admin'])assert.match(modal.innerHTML,new RegExp('data-roster="signers" value="'+id+'"'));
  assert.doesNotMatch(modal.innerHTML,/value="u-design"|value="u-ops"/);
});

test('checking multiple workers and reviewers allows the same person in both roles',()=>{
  const {ui,listeners}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();data.state.projects[0].memberIds.push('u-admin');ui.acceptSession(data);
  const box=taskBox(['u-qa','u-admin'],['u-engineer','u-manager']);
  const f={dataset:{form:'createTask'},elements:{projectId:{value:'p-mower'}},querySelector:()=>box};
  listeners.get('document:change')({target:{dataset:{roster:'owners'},hasAttribute:()=>false,closest:()=>f}});
  for(const id of ['u-qa','u-admin'])assert.match(box.innerHTML,new RegExp('data-roster="owners" value="'+id+'" checked'));
  for(const id of ['u-engineer','u-manager'])assert.match(box.innerHTML,new RegExp('data-roster="signers" value="'+id+'" checked'));
  assert.doesNotMatch(box.innerHTML,/data-roster="signers" value="u-qa" disabled/);
  assert.doesNotMatch(box.innerHTML,/data-roster="signers" value="u-admin" disabled/);
});

test('the task form binds the exact open stage and never substitutes a different one',()=>{
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session(); ui.acceptSession(data);
  const stage=data.state.milestones.find(m=>m.id==='m-mower-3');
  for(const [projectId,stageId] of [[stage.projectId,undefined],['p-pcb',stage.id],['missing',stage.id],[stage.projectId,'m-mower-1']]){
    ui.newTask(projectId,stageId);assert.equal(modal.open,false);
  }
  ui.newTask(stage.projectId,stage.id);
  assert.match(modal.innerHTML,/<input type="hidden" name="projectId" value="p-mower">/);
  assert.match(modal.innerHTML,/<input type="hidden" name="milestoneId" value="m-mower-3">/);
  assert.doesNotMatch(modal.innerHTML,/所属项目|所属里程碑|<select[^>]*name="(?:projectId|milestoneId)"/);
  assert.match(modal.innerHTML,new RegExp('name="dueDate"[^>]+max="'+times.toDateTimeInput(stage.dueDate,'23:00')+'"'));
});

test('designated reviewers can accept their own tasks',()=>{
  for(const role of ['superadmin','admin','member']){
    const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});const data=session();
    data.actor.role=role;data.account.role=role;const t=data.state.tasks[0];data.state.projects[0].memberIds.push(data.actor.id);
    Object.assign(t,{ownerId:data.actor.id,reviewerId:data.actor.id,status:'review'});ui.acceptSession(data);ui.taskDetail(t.id);
    assert.equal(modal.innerHTML.includes('data-action="approve-task"'),true);
    assert.equal(ui.taskRow(t).includes('>验收</button>'),true);
    modal.close();ui.reviewTask(t.id,true);assert.equal(modal.open,true);
  }
});

test('ordinary admins cannot review by rank and super admins can review any submitted task',()=>{
  for(const role of ['admin','superadmin']){
    const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});const data=session();data.actor.role=role;data.account.role=role;
    const t=data.state.tasks[0];Object.assign(t,{reviewerId:'u-manager',ownerId:'u-qa',status:'review'});ui.acceptSession(data);ui.taskDetail(t.id);
    assert.equal(modal.innerHTML.includes('data-action="approve-task"'),role==='superadmin');
    t.reviewerId=data.actor.id;ui.taskDetail(t.id);assert.match(modal.innerHTML,/data-action="approve-task"/);
  }
});

test('self-review still requires submission and disappears once the task is accepted',()=>{
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();data.actor=data.state.users.find(user=>user.id==='u-engineer');
  const target=data.state.tasks[0];Object.assign(target,{ownerId:data.actor.id,reviewerId:data.actor.id});
  ui.acceptSession(data);
  for(const status of ['todo','doing','done']){
    target.status=status;ui.taskDetail(target.id);
    assert.doesNotMatch(modal.innerHTML,/data-action="(?:approve-task|reject-task)"/);
    if(status==='todo')assert.match(modal.innerHTML,/data-action="start-task"/);
    if(status==='doing')assert.match(modal.innerHTML,/data-action="submit-task"/);
  }
});

test('task navigation shows persistent work counts while messages retain their unread badges',()=>{
  const {ui,app,modal}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();const target=data.state.tasks[0];
  data.notifications=[notice('n1','tasks',target.id,target.projectId),notice('n2','approvals','r1',target.projectId)];
  data.notifications[0].title='<img src=x onerror=alert(1)>';
  ui.acceptSession(data);ui.render();
  assert.match(app.innerHTML,/<a href="#tasks"[^>]*>[\s\S]*?<span class="pending-task-count"/);
  assert.match(app.innerHTML,/class="notification-trigger[^>]*>[\s\S]*?class="unread-count"[^>]*>2<\/span>/);
  assert.doesNotMatch(app.innerHTML.match(/<a href="#approvals"[^>]*>[\s\S]*?<\/a>/)?.[0]||'',/data-unread-category/);
  assert.match(ui.taskRow(target),new RegExp(`data-unread-entity="${target.id}"[^>]*><span class="unread-count"`));
  ui.notificationCenter();assert.match(modal.innerHTML,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(modal.innerHTML,/<img/);
});

test('reading notifications preserves concurrent new arrivals and filters a stale refresh',async()=>{
  const pending=deferred();let sent;
  const {ui}=harness(async(path,options)=>{sent={path,body:JSON.parse(options.body)};return pending.promise;});
  ui.acceptSession(session({notifications:[notice('n1')]}));
  const reading=ui.markNotificationsRead(['n1']);
  ui.acceptSession(session({revision:2,notifications:[notice('n2'),notice('n1')]}));
  pending.resolve(Response.json({notifications:[]}));await reading;
  assert.equal(sent.path,'/api/notifications/read');assert.deepEqual(sent.body,{ids:['n1']});
  assert.equal(ui.getNotifications().map(n=>n.id).join(','),'n2');
  ui.acceptSession(session({revision:2,notifications:[notice('n2'),notice('n1')]}));
  assert.equal(ui.getNotifications().map(n=>n.id).join(','),'n2');
});

test('failed notification reads remain unread and account switching cannot leak messages',async()=>{
  const {ui,app}=harness(async()=>Response.json({error:'offline'},{status:503}));
  ui.acceptSession(session({notifications:[notice('n1')]}));
  await ui.markNotificationsRead(['n1'],{silent:true});assert.equal(ui.getNotifications().length,1);
  ui.acceptSession(session({account:{id:'a-other',login:'other',mustChangePassword:false},notifications:[]}));
  ui.render();assert.equal(ui.getNotifications().length,0);assert.doesNotMatch(app.innerHTML,/class="unread-count"/);
  ui.authScreen();assert.equal(ui.getNotifications().length,0);
});

test('large read batches keep successful receipts and leave a failed batch unread',async()=>{
  const batches=[];
  const {ui}=harness(async(_path,options)=>{batches.push(JSON.parse(options.body).ids);return batches.length===1?Response.json({notifications:[]}):Response.json({error:'offline'},{status:503});});
  const messages=Array.from({length:1001},(_,index)=>notice(`n${index}`));
  ui.acceptSession(session({notifications:messages}));
  await ui.markNotificationsRead(messages.map(n=>n.id),{silent:true});
  assert.deepEqual(batches.map(batch=>batch.length),[1000,1]);
  assert.equal(ui.getNotifications().map(n=>n.id).join(','),'n1000');
});

test('opening the retired dashboard returns to the project center without its navigation entry',()=>{
  const {ui,app,location}=harness(async()=>{throw new Error('Unexpected request');});
  ui.acceptSession(session());location.hash='#dashboard';ui.render();
  assert.equal(location.hash,'#overview');assert.doesNotMatch(app.innerHTML,/href="#dashboard"|管理后台/);
  assert.match(app.innerHTML,/href="#approvals"/);assert.match(app.innerHTML,/href="#accounts"/);
});

test('polling updates badges even when only read receipts changed and revision did not',async()=>{
  const {ui,app}=harness(async()=>Response.json(session({notifications:[]})));
  ui.acceptSession(session({notifications:[notice('n1')]}));ui.render();assert.match(app.innerHTML,/class="unread-count"/);
  await ui.loadSession(true);assert.doesNotMatch(app.innerHTML,/class="unread-count"/);
});

test('polling renders deferred changes after the file selection closes even at the same revision',async()=>{
  let selectingFiles=false;
  const fresh=session({revision:2,notifications:[notice('file-dialog-notice')]});
  fresh.state.tasks.find(task=>task.id==='t-02').title='文件选择期间更新的任务';
  const {ui,app,content,location}=harness(async()=>Response.json(fresh),{hasActiveFileOperations:()=>selectingFiles});
  location.hash='#projects/p-mower';
  ui.acceptSession(session());ui.render();
  const previous=content.innerHTML;selectingFiles=true;
  await ui.loadSession(true);
  assert.equal(content.innerHTML,previous);
  assert.doesNotMatch(app.innerHTML,/class="unread-count"/);
  selectingFiles=false;await ui.loadSession(true);
  assert.match(app.innerHTML,/class="unread-count"/);
  assert.match(content.innerHTML,/文件选择期间更新的任务/);
});

test('legacy project reviewer is absent from new-project setup and the project header',()=>{
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();data.state.projects[0].reviewerId='u-engineer';ui.acceptSession(data);ui.newProject();
  assert.doesNotMatch(modal.innerHTML,/项目验收人|name="reviewerId"/);
  assert.doesNotMatch(ui.projectWorkspace(data.state.projects[0]),/项目验收人|set-project-reviewer/);
});

test('project owners can start teammates tasks but cannot submit their deliverables',async()=>{
  const {ui,modal,listeners}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();data.actor=data.state.users.find(user=>user.id==='u-manager');data.account={...data.account,role:'member'};
  const task=data.state.tasks.find(item=>item.id==='t-02');task.status='todo';
  ui.acceptSession(data);ui.taskDetail(task.id);
  assert.match(modal.innerHTML,/data-action="start-task"/);
  task.status='doing';ui.taskDetail(task.id);
  assert.doesNotMatch(modal.innerHTML,/data-action="submit-task"/);
  modal.close();
  await clickUiAction(listeners,'submit-task',task.id);
  assert.equal(modal.open,false);
});

test('account refresh retains project context from the same revision snapshot',async()=>{
  const fresh=session({revision:8});fresh.accounts=[];
  fresh.state.projects.push({...fresh.state.projects[0],id:'p-fresh',name:'另一管理员刚建立的项目',memberIds:[]});
  const {ui}=harness(async()=>Response.json(fresh));ui.acceptSession(session());
  await ui.loadAccounts();assert.ok(ui.getState().projects.some(p=>p.id==='p-fresh'));
  assert.equal(ui.getState().projects.find(p=>p.id==='p-fresh').name,'另一管理员刚建立的项目');
});

test('adding a member keeps their other memberships and sends the account snapshot revision',async()=>{
  const fresh=session({revision:12});
  const employee={id:'u-member-qa',name:'测试成员',role:'member'};fresh.state.users.push(employee);
  fresh.state.projects[0].memberIds.push(employee.id);
  const target=fresh.state.projects[1];target.memberIds=target.memberIds.filter(id=>id!==employee.id);
  fresh.accounts=[{id:'a-member-qa',userId:employee.id,status:'active',name:employee.name,role:'member'}];
  let sent;
  const {ui,toast}=harness(async(path,options)=>{
    if(path==='/api/accounts')return Response.json(fresh);
    sent={path,body:JSON.parse(options.body)};
    const result=structuredClone(fresh);result.revision++;result.state.projects[1].memberIds.push(employee.id);return Response.json(result);
  });
  ui.acceptSession(session());await ui.loadAccounts();
  const input=form();await ui.saveProjectMember(input,{accountId:'a-member-qa'},target.id);
  assert.deepEqual(sent,{path:'/api/accounts/a-member-qa',body:{projectIds:[fresh.state.projects[0].id,target.id],revision:12}});
  assert.ok(ui.getState().projects[1].memberIds.includes(employee.id));assert.match(toast.textContent,/已加入项目/);
  assert.equal(input.button.disabled,false);assert.equal(input.attributes.has('aria-busy'),false);
});

function accountsSession() {
  const data=session();
  data.account={...data.account,userId:'u-admin'};
  data.state.users.push({id:'u-peer-admin',name:'其他管理员',role:'admin',title:'采购',department:'供应链'});
  data.accounts=[
    {...data.account,name:data.actor.name,status:'active',title:'运营总监'},
    {id:'a-peer-admin',userId:'u-peer-admin',name:'其他管理员',login:'peer.admin',role:'admin',status:'active',title:'采购',department:'供应链'},
    {id:'a-engineer',userId:'u-engineer',name:'工程师',login:'engineer',role:'member',status:'active',title:'工程师'},
  ];
  return data;
}

test('the super administrator can manage administrators and employees but cannot create another super administrator',async()=>{
  const data=accountsSession();let requests=0;
  const {ui,modal}=harness(async()=>{requests++;return Response.json(data);});
  ui.acceptSession(data);await ui.loadAccounts();
  for(const id of ['a-peer-admin','a-engineer']){
    const account=data.accounts.find(item=>item.id===id);
    assert.match(ui.accountRowActions(account),/data-action="reset-password"/);
    assert.match(ui.accountRowActions(account),/data-action="delete-account"/);
    ui.editAccount(id);
    assert.match(modal.innerHTML,/<select[^>]+name="role"/);
    assert.match(modal.innerHTML,/<select[^>]+name="status"/);
    assert.match(modal.innerHTML,/<option value="admin"/);
    ui.resetPassword(id);assert.match(modal.innerHTML,/data-form="reset-password"/);
  }
  ui.newAccount();assert.match(modal.innerHTML,/<option value="admin"/);
  assert.match(ui.accountsPage(),/总管理员/);
  assert.doesNotMatch(modal.innerHTML,/<option value="(?:superadmin|manager)"/);
  assert.equal(requests,1,'opening management forms must not submit mutations');
});

test('the current super administrator retains profile and self-password changes but cannot disable, demote or delete themselves',async()=>{
  const data=accountsSession();let requests=0;
  const {ui,modal}=harness(async()=>{requests++;return Response.json(data);});
  ui.acceptSession(data);await ui.loadAccounts();
  const own=data.accounts.find(item=>item.id==='a-admin');
  assert.match(ui.accountRowActions(own),/data-action="change-password"/);
  assert.doesNotMatch(ui.accountRowActions(own),/data-action="(?:reset-password|delete-account)"/);
  ui.editAccount(own.id);assert.doesNotMatch(modal.innerHTML,/<select[^>]+name="(?:role|status)"/);
  ui.resetPassword(own.id);assert.match(modal.innerHTML,/data-form="change-password"/);
  assert.throws(()=>ui.deleteAccount(own.id),/当前|自己|本人/);
  await assert.rejects(ui.saveAccountDeletion(own.id),/当前|自己|本人/);
  assert.equal(requests,1,'self-deletion must fail before sending any mutation');
});

test('ordinary administrators manage only employees and direct calls cannot target privileged accounts',async()=>{
  const data=accountsSession();data.actor=data.state.users.find(user=>user.id==='u-peer-admin');
  data.account={...data.accounts.find(a=>a.id==='a-peer-admin'),mustChangePassword:false};
  let requests=0;
  const {ui,modal}=harness(async()=>{requests++;return Response.json(data);});
  ui.acceptSession(data);await ui.loadAccounts();
  for(const id of ['a-admin','a-peer-admin']){
    const target=data.accounts.find(a=>a.id===id),before=modal.innerHTML;
    assert.doesNotMatch(ui.accountRowActions(target),/data-action="(?:edit-account|reset-password|delete-account)"/);
    ui.editAccount(id);assert.equal(modal.innerHTML,before);
    if(id==='a-admin'){ui.resetPassword(id);assert.equal(modal.innerHTML,before);}
    assert.throws(()=>ui.deleteAccount(id),/无权|当前/);
    await assert.rejects(ui.saveAccountDeletion(id),/无权|当前/);
    await assert.rejects(ui.saveAccount('edit-account',{title:'越权修改'},id),/无权/);
    await assert.rejects(ui.savePasswordReset({password:'unused-test-phrase',confirmPassword:'unused-test-phrase'},id),/无权/);
  }
  const employee=data.accounts.find(a=>a.id==='a-engineer');
  assert.match(ui.accountRowActions(employee),/data-action="edit-account"/);
  assert.match(ui.accountRowActions(employee),/data-action="reset-password"/);
  assert.match(ui.accountRowActions(employee),/data-action="delete-account"/);
  ui.newAccount();assert.match(modal.innerHTML,/<option value="member"/);
  assert.doesNotMatch(modal.innerHTML,/<option value="(?:admin|superadmin|manager)"/);
  ui.editAccount(employee.id);assert.doesNotMatch(modal.innerHTML,/<option value="(?:admin|superadmin|manager)"/);
  for(const role of ['admin','superadmin','manager']){
    await assert.rejects(ui.saveAccount('create-account',{role},''),/不能授予/);
    await assert.rejects(ui.saveAccount('edit-account',{role},employee.id),/不能授予/);
  }
  const candidates=ui.availableProjectAccounts({ownerId:'none',memberIds:[]});
  assert.deepEqual(Array.from(candidates,a=>a.id),['a-engineer']);
  await assert.rejects(ui.saveProjectMember(form(),{accountId:'a-admin'},'p-mower'),/无权|仅总管理员或已参与/);
  ui.resetPassword('a-peer-admin');assert.match(modal.innerHTML,/data-form="change-password"/);
  assert.equal(requests,1,'all forbidden operations stop before any mutation');
});

test('only the super administrator sees platform settings and full backup controls',()=>{
  for(const role of ['superadmin','admin','member']){
    const data=session();data.actor.role=role;data.account.role=role;
    const {ui,app,content,location}=harness(async()=>{throw new Error('Unexpected request');});
    ui.acceptSession(data);location.hash='#my-account';ui.render();
    if(role==='superadmin')assert.match(app.innerHTML,/href="#settings"/);
    else{assert.doesNotMatch(app.innerHTML,/href="#settings"/);assert.doesNotMatch(ui.myAccountPage(),/平台设置与数据备份/);}
    if(role!=='superadmin'){
      assert.doesNotMatch(ui.settingsPage(),/data-maintenance/);
      location.hash='#settings';ui.render();
      assert.match(content.innerHTML,/没有此页面的访问权限/);
    }
  }
});

test('only administrators create projects and may appoint an employee as project owner',()=>{
  for(const role of ['superadmin','admin']){
    const data=session();data.actor.role=role;data.account.role=role;
    const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
    ui.acceptSession(data);ui.newProject();
    const owners=modal.innerHTML.match(/<select[^>]+name="ownerId"[^>]*>([\s\S]*?)<\/select>/)[1];
    assert.match(owners,/<option value="u-engineer"/);
    assert.match(owners,/<option value="u-manager"/);
  }
  const data=session();data.actor=data.state.users.find(u=>u.id==='u-manager');data.actor.role='member';data.account={...data.account,role:'member'};
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});ui.acceptSession(data);
  assert.doesNotMatch(ui.projectsPage(),/data-action="new-project"/);
  assert.doesNotMatch(ui.projectWorkspace(data.state.projects[0]),/data-action="new-project"/);
  ui.newProject();assert.equal(modal.open,false);
  ui.milestoneDetail('m-mower-2');assert.match(modal.innerHTML,/data-action="set-milestone-co-reviewer"/,'employee owners keep project responsibilities');
});

test('only administrators see small-node deletion and employee owners cannot open or submit it',async()=>{
  for(const role of ['superadmin','admin','member']){
    const data=session();
    if(role==='member')data.actor=data.state.users.find(user=>user.id==='u-manager');
    data.actor.role=role;data.account={...data.account,role};
    const {ui,modal,listeners}=harness(async(path)=>{assert.match(path,/^\/api\/files\?/);return Response.json({files:[]});});
    ui.acceptSession(data);ui.taskDetail('t-02');
    if(role==='member'){
      assert.doesNotMatch(modal.innerHTML,/data-action="delete-task"/);modal.close();
      await ui.deleteTask('t-02');assert.equal(modal.open,false);
      await clickUiAction(listeners,'delete-task','t-02');assert.equal(modal.open,false);
      await assert.rejects(ui.saveTaskDeletion({confirm:true},'t-02'),/仅管理员/);
    }else{
      assert.match(modal.innerHTML,/data-action="delete-task"/);await ui.deleteTask('t-02');
      assert.match(modal.innerHTML,/data-form="deleteTask"/);
      assert.match(modal.innerHTML,/<input type="checkbox" name="confirm" required/);
      assert.match(modal.innerHTML,/附件|完成率|延期申请/);
      await assert.rejects(ui.saveTaskDeletion({},'t-02'),/勾选确认/);
    }
  }
});

test('small-node deletion waits for server success and sends explicit confirmation with the current revision',async()=>{
  const data=session({revision:21}),after=structuredClone(data),pending=deferred();
  after.revision=22;after.state.tasks=after.state.tasks.filter(task=>task.id!=='t-02');
  let sent;
  const {ui,modal,toast}=harness(async(path,options)=>{if(path.startsWith('/api/files?'))return Response.json({files:[]});sent={path,body:JSON.parse(options.body)};return pending.promise;});
  ui.acceptSession(data);await ui.deleteTask('t-02');
  const saving=ui.saveTaskDeletion({confirm:'on'},'t-02');
  assert.equal(modal.open,true);assert.ok(ui.getState().tasks.some(task=>task.id==='t-02'));
  assert.deepEqual(sent,{path:'/api/command',body:{action:'deleteTask',payload:{id:'t-02',confirm:true},revision:21}});
  pending.resolve(Response.json(after));await saving;
  assert.equal(modal.open,false);assert.ok(!ui.getState().tasks.some(task=>task.id==='t-02'));
  assert.match(toast.textContent,/已删除/);
});

test('a rejected small-node deletion keeps its confirmation and task available for review',async()=>{
  for(const status of [403,503]){
    const data=session();let commands=0;
    const {ui,modal,toast}=harness(async(path)=>{
      if(path==='/api/command'){commands++;return Response.json({error:'删除未获批准'},{status});}
      if(path.startsWith('/api/files?'))return Response.json({files:[]});
      return Response.json(data);
    });
    ui.acceptSession(data);await ui.deleteTask('t-02');const before=modal.innerHTML;
    await assert.rejects(ui.saveTaskDeletion({confirm:true},'t-02'),/删除未获批准/);
    assert.equal(commands,1);assert.equal(modal.open,true);assert.equal(modal.innerHTML,before);
    assert.ok(ui.getState().tasks.some(task=>task.id==='t-02'));
    assert.doesNotMatch(toast.textContent||'',/已删除/);
  }
});

test('major-node confirmation counts its tasks, direct and child files, and only affected pending applications',async()=>{
  const data=session(),id='m-mower-2';data.actor.role='admin';data.account.role='admin';
  const children=data.state.tasks.filter(task=>task.milestoneId===id);
  data.state.milestoneRequests=[{id:'mr-pending',projectId:'p-mower',milestoneId:id,status:'pending'},{id:'mr-history',projectId:'p-mower',milestoneId:id,status:'approved'}];
  data.state.extensions=[{id:'ex-task',projectId:'p-mower',status:'pending',affectedTasks:[{id:children[0].id}]},{id:'ex-node',projectId:'p-mower',status:'pending',affectedMilestones:[{id}]},{id:'ex-unrelated',projectId:'p-mower',status:'pending',affectedTasks:[{id:'other-task'}]}];
  const files=[{projectId:'p-mower',entityType:'milestone',entityId:id},{projectId:'p-mower',entityType:'task',entityId:children[0].id},{projectId:'p-mower',entityType:'milestone',entityId:'m-mower-3'},{projectId:'p-pcb',entityType:'milestone',entityId:id}];
  const {ui,modal}=harness(async()=>Response.json({files}));ui.acceptSession(data);ui.milestoneDetail(id);
  assert.match(modal.innerHTML,/data-action="delete-milestone"/);
  await ui.deleteMilestone(id);
  assert.match(modal.innerHTML,new RegExp(`1 个大节点、${children.length} 项任务及全部附件（当前 2 个）`));
  assert.match(modal.innerHTML,/3 项关联待审批申请会取消/);
  assert.match(modal.innerHTML,/data-form="deleteMilestone"/);
  assert.match(modal.innerHTML,/已审批历史和删除操作记录保留/);
});

test('only the super administrator can delete a whole project and successful deletion returns to all projects',async()=>{
  for(const role of ['admin','member']){
    const data=session();data.actor.role=role;data.account.role=role;
    const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});ui.acceptSession(data);
    assert.doesNotMatch(ui.projectWorkspace(data.state.projects[0]),/data-action="delete-project"/);
    await ui.deleteProject('p-mower');assert.equal(modal.open,false);
    await assert.rejects(ui.saveEntityDeletion('deleteProject',{confirm:true},'p-mower'),/仅总管理员/);
  }
  const data=session(),after=structuredClone(data),id='p-mower';
  const tasks=data.state.tasks.filter(t=>t.projectId===id),milestones=data.state.milestones.filter(m=>m.projectId===id);
  after.revision++;for(const collection of ['projects','tasks','milestones','milestoneRequests','extensions'])after.state[collection]=after.state[collection].filter(item=>collection==='projects'?item.id!==id:item.projectId!==id);
  let sent;
  const {ui,modal,location}=harness(async(path,options)=>{if(path.startsWith('/api/files?'))return Response.json({files:[{projectId:id,entityType:'task',entityId:tasks[0].id}]});sent=JSON.parse(options.body);return Response.json(after);});
  ui.acceptSession(data);assert.match(ui.projectWorkspace(data.state.projects[0]),/data-action="delete-project"/);
  await ui.deleteProject(id);
  assert.match(modal.innerHTML,new RegExp(`${milestones.length} 个大节点、${tasks.length} 项任务及全部附件（当前 1 个）`));
  assert.match(modal.innerHTML,/申请及项目记录一并删除/);
  await ui.saveEntityDeletion('deleteProject',{confirm:true},id);
  assert.equal(sent.action,'deleteProject');assert.deepEqual(sent.payload,{id,confirm:true});
  assert.equal(location.hash,'#projects');assert.equal(modal.open,false);
  assert.ok(!ui.getState().projects.some(p=>p.id===id));
});

test('file-count failures do not display zero files or enable destructive confirmation',async()=>{
  const {ui,modal}=harness(async()=>Response.json({error:'文件服务暂不可用'},{status:503}));ui.acceptSession(session());
  await ui.deleteMilestone('m-mower-2');
  assert.match(modal.innerHTML,/无法核对文件数量/);
  assert.doesNotMatch(modal.innerHTML,/name="confirm"|当前 0 个|data-form="deleteMilestone"/);
  assert.match(modal.innerHTML,/重新核对/);
  await assert.rejects(ui.saveEntityDeletion('deleteMilestone',{confirm:true},'m-mower-2'),/重新打开/);
});

test('deletion sends the reviewed revision and a conflict reloads counts with a fresh confirmation',async()=>{
  const data=session({revision:21}),fresh=structuredClone(data),id='m-mower-2';fresh.revision=22;
  fresh.state.tasks.push({...fresh.state.tasks.find(t=>t.milestoneId===id),id:'new-during-confirmation',title:'确认期间新增的任务'});
  let sent;
  const {ui,modal}=harness(async(path,options)=>{
    if(path.startsWith('/api/files?'))return Response.json({files:[]});
    if(path==='/api/session')return Response.json(fresh);
    sent=JSON.parse(options.body);return Response.json({error:'数据已变化'},{status:409});
  });
  ui.acceptSession(data);await ui.deleteMilestone(id);ui.acceptSession(fresh);
  await assert.rejects(ui.saveEntityDeletion('deleteMilestone',{confirm:true},id),/重新核对并确认/);
  assert.equal(sent.revision,21,'background session updates cannot silently broaden the confirmed deletion');
  assert.match(modal.innerHTML,new RegExp(`${fresh.state.tasks.filter(t=>t.milestoneId===id).length} 项任务`));
  assert.match(modal.innerHTML,/<input type="checkbox" name="confirm" required>/);
  assert.doesNotMatch(modal.innerHTML,/name="confirm"[^>]*checked/);
});

test('a late deletion preview cannot replace another modal or reopen a dismissed confirmation',async()=>{
  const pending=deferred(),{ui,modal}=harness(async()=>pending.promise);ui.acceptSession(session());
  const preview=ui.deleteProject('p-mower');assert.match(modal.innerHTML,/正在核对/);
  ui.newTask('p-mower','m-mower-2');const taskForm=modal.innerHTML;
  pending.resolve(Response.json({files:[]}));await preview;
  assert.equal(modal.innerHTML,taskForm);
  await assert.rejects(ui.saveEntityDeletion('deleteProject',{confirm:true},'p-mower'),/重新打开/);
});

test('deleted-project notifications return to the project center without opening missing project details',async()=>{
  const data=session({notifications:[{...notice('removed-project','projects','removed','removed'),action:'deleteProject',target:'#overview'}]});
  const {ui,location,toast}=harness(async()=>Response.json({notifications:[]}));ui.acceptSession(data);
  await ui.openNotification('removed-project');
  assert.equal(location.hash,'#overview');assert.doesNotMatch(toast.textContent||'',/不可查看/);
});

test('deleting another account requires confirmation and sends DELETE with the current account revision',async()=>{
  const data=accountsSession();data.revision=14;
  const after=structuredClone(data);after.revision=15;after.accounts=after.accounts.filter(item=>item.id!=='a-peer-admin');
  let sent;const requests=[];
  const {ui,modal,toast}=harness(async(path,options)=>{
    requests.push({path,method:options?.method||'GET'});
    if(options?.method==='DELETE'){sent={path,body:JSON.parse(options.body)};return Response.json(after);}
    return Response.json(data);
  });
  ui.acceptSession(data);await ui.loadAccounts();ui.deleteAccount('a-peer-admin');
  assert.equal(modal.open,true);
  assert.match(modal.innerHTML,/data-form="delete-account" data-id="a-peer-admin"/);
  assert.match(modal.innerHTML,/其他管理员/);
  assert.match(modal.innerHTML,/peer.admin/);
  assert.match(modal.innerHTML,/保留/);
  assert.equal(requests.filter(request=>request.method==='DELETE').length,0,'opening confirmation cannot delete');
  await ui.saveAccountDeletion('a-peer-admin');
  assert.deepEqual(sent,{path:'/api/accounts/a-peer-admin',body:{revision:14}});
  assert.equal(modal.open,false);
  assert.doesNotMatch(ui.accountsPage(),/peer\.admin/);
  assert.deepEqual(ui.getState().projects,data.state.projects);
  assert.deepEqual(ui.getState().tasks,data.state.tasks);
  assert.ok(ui.getState().users.some(user=>user.id==='u-peer-admin'),'business identity survives account deletion');
  assert.match(toast.textContent,/删除/);
});

test('failed account deletion preserves the account list, business data and confirmation for retry',async()=>{
  const data=accountsSession();let deletes=0;
  const {ui,modal}=harness(async(_path,options)=>{
    if(options?.method==='DELETE'){deletes++;return Response.json({error:'删除暂未完成，请重试。'},{status:503});}
    return Response.json(data);
  });
  ui.acceptSession(data);await ui.loadAccounts();ui.deleteAccount('a-engineer');
  await assert.rejects(ui.saveAccountDeletion('a-engineer'),/删除暂未完成/);
  assert.equal(deletes,1);
  assert.equal(modal.open,true);
  assert.match(ui.accountsPage(),/engineer/);
  assert.deepEqual(ui.getState().projects,data.state.projects);
  assert.deepEqual(ui.getState().tasks,data.state.tasks);
});

test('job title choices remain independent from account roles when changed and saved',async()=>{
  const data=accountsSession();let sent;
  const {ui,modal,listeners}=harness(async(path,options)=>{
    if(options?.method==='PATCH')sent={path,body:JSON.parse(options.body)};
    return Response.json(data);
  });
  ui.acceptSession(data);await ui.loadAccounts();ui.newAccount();
  for(const title of ['工程师','管理员','销售','采购','人力'])assert.match(modal.innerHTML,new RegExp(`<option value="${title}"></option>`));
  assert.match(modal.innerHTML,/<input[^>]+name="title"[^>]+list="job-title-options"/);
  const editForm={dataset:{form:'create-account'},elements:{role:{value:'member'},title:{value:'管理员'}}};
  listeners.get('document:change')({target:{name:'title',value:'管理员',dataset:{},hasAttribute:()=>false,closest:()=>editForm}});
  assert.equal(editForm.elements.role.value,'member');
  await ui.saveAccount('edit-account',{role:'member',title:'管理员',department:'行政'},'a-engineer');
  assert.equal(sent.path,'/api/accounts/a-engineer');
  assert.equal(sent.body.role,'member');assert.equal(sent.body.title,'管理员');assert.equal(sent.body.department,'行政');
});

test('opening a new member from a project retains context without membership controls',()=>{
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  ui.acceptSession(session());ui.newAccount('p-mower');
  assert.match(modal.innerHTML,/开通新成员/);
  assert.match(modal.innerHTML,/data-form="create-account" data-id="p-mower"/);
  assert.doesNotMatch(modal.innerHTML,/name="(?:projectIds|existingUserId)"|关联项目成员|<legend>参与项目/);
  assert.match(modal.innerHTML,/开通后加入/);
  assert.match(modal.innerHTML,/开通并加入项目/);
});

test('reading messages leaves persistent task badges visible through submission until acceptance',async()=>{
  const data=session();data.actor=data.state.users.find(user=>user.id==='u-engineer');
  data.account={id:'a-engineer',login:'engineer',role:'member',mustChangePassword:false};
  data.state=sanitizeStateForActor(data.state,data.actor.id);
  const task=data.state.tasks.find(item=>item.ownerId===data.actor.id);
  data.state.tasks=[task];task.status='todo';data.state.extensions=[];data.state.milestoneRequests=[];
  data.notifications=[notice('new-task','tasks',task.id,task.projectId)];
  const {ui,app}=harness(async()=>Response.json({notifications:[]}));
  ui.acceptSession(data);ui.render();
  assert.match(app.innerHTML,/class="pending-task-count"[^>]+>1<\/span>/);
  assert.match(ui.taskRow(task),/class="pending-task-dot"/);
  await ui.markNotificationsRead(['new-task']);ui.render();
  assert.doesNotMatch(app.innerHTML,/class="unread-count"/);
  for(const status of ['todo','doing','review']){
    task.status=status;ui.render();
    assert.match(app.innerHTML,/class="pending-task-count"[^>]+>1<\/span>/);
    assert.match(ui.taskRow(task),/class="pending-task-dot"/);
  }
  task.status='done';ui.render();
  assert.doesNotMatch(app.innerHTML,/class="pending-task-count"/);
  assert.doesNotMatch(ui.taskRow(task),/class="pending-task-dot"/);
});

test('weekly export buttons download real Excel and Word packages for the displayed week',async()=>{
  const {ui,location,listeners,downloads}=harness(async()=>{throw new Error('Unexpected request');});
  ui.acceptSession(session());location.hash='#weekly';
  const html=ui.weeklyPage();
  assert.match(html,/data-action="export-week" data-id="xlsx"[^>]*>[\s\S]*?导出 Excel/);
  assert.match(html,/data-action="export-week" data-id="docx"[^>]*>[\s\S]*?导出 Word/);
  const click=async(action,id)=>{
    const button={dataset:{action,id},type:'button',closest:()=>null};
    await listeners.get('document:click')({target:{closest:selector=>selector==='[data-action]'?button:null},preventDefault(){}});
  };
  await click('previous-week');
  const selectedWeek=domain.weekRange(domain.addDays(domain.today(),-7));
  for(const format of ['xlsx','docx'])await click('export-week',format);
  assert.equal(downloads.length,2);
  for(const [index,format] of ['xlsx','docx'].entries()){
    const download=downloads[index];
    assert.match(download.filename,new RegExp(`\\.${format}$`));
    assert.ok(download.filename.includes(selectedWeek.start));
    assert.ok(download.filename.includes(selectedWeek.end));
    assert.equal(download.blob.type,format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const bytes=new Uint8Array(await download.blob.arrayBuffer());
    assert.deepEqual(Array.from(bytes.slice(0,4)),[0x50,0x4b,0x03,0x04]);
    assert.ok(bytes.length>1000);
  }
});

test('mandatory password change clears previous business data and cannot render project routes',()=>{
  const {ui,app,location,listeners}=harness(async()=>{throw new Error('Unexpected request');});
  ui.acceptSession(session());
  assert.ok(ui.getState().projects.length>0);
  assert.equal(ui.acceptSession(restrictedSession()),false);
  assert.equal(ui.getState(),null);
  assert.equal(ui.getAccount().login,'new.employee');
  assert.match(app.innerHTML,/先设置你的新密码/);
  assert.doesNotMatch(app.innerHTML,/app-shell|p-mower|管理后台|账号管理/);
  location.hash='#dashboard';listeners.get('window:hashchange')();
  assert.match(app.innerHTML,/先设置你的新密码/);
  assert.doesNotMatch(app.innerHTML,/app-shell/);
});

test('a failed login clears the submitted password and restores the form to a retryable state',async()=>{
  let sent;
  const {ui,toast}=harness(async(path,options)=>{sent={path,options};return Response.json({error:'账号或密码不正确。'},{status:401});});
  const target=form();
  await assert.rejects(ui.submitAuth(target,{login:' qa.member ',password:target.elements.password.value},'login'),/账号或密码不正确/);
  assert.equal(sent.path,'/api/auth/login');
  assert.deepEqual(JSON.parse(sent.options.body),{login:'qa.member',password:'disposable-example-password'});
  assert.equal(target.elements.password.value,'');
  assert.equal(target.elements.password.focused,true);
  assert.equal(target.button.disabled,false);
  assert.equal(target.button.textContent,'登录工作空间');
  assert.equal(target.attributes.has('aria-busy'),false);
  assert.equal(toast.hidden,true);
  assert.equal(ui.getState(),null);
});

test('mismatched and unchanged new passwords cannot send a password mutation',async()=>{
  let requests=0;
  const {ui}=harness(async()=>{requests++;throw new Error('Unexpected request');});
  const target=form();
  await assert.rejects(ui.submitAuth(target,{currentPassword:'temporary-password',newPassword:'updated-password-one',confirmPassword:'updated-password-two'},'change-password'),/不一致/);
  await assert.rejects(ui.submitAuth(target,{currentPassword:'temporary-password',newPassword:'temporary-password',confirmPassword:'temporary-password'},'change-password'),/不能与当前密码相同/);
  assert.equal(requests,0);
  assert.equal(target.button.disabled,false);
});

test('successful first login renders only the mandatory password form and clears submitted secrets',async()=>{
  const {ui,app}=harness(async()=>Response.json(restrictedSession()));
  const target=form();
  await ui.submitAuth(target,{login:'new.employee',password:target.elements.password.value},'login');
  assert.equal(target.resetCalled,true);
  assert.equal(ui.getState(),null);
  assert.match(app.innerHTML,/保存并进入工作空间/);
  assert.doesNotMatch(app.innerHTML,/disposable-example-password|app-shell/);
});

test('logout clears account data and a late session refresh cannot bring the workspace back',async()=>{
  const pending=deferred();const requests=[];
  const {ui,app,location}=harness(async(path,options)=>{
    requests.push({path,options});
    if(path==='/api/session')return pending.promise;
    if(path==='/api/auth/logout')return Response.json({ok:true});
    throw new Error(`Unexpected endpoint ${path}`);
  });
  ui.acceptSession(session());
  const refresh=ui.loadSession(true);
  await ui.logout();
  assert.equal(ui.getState(),null);
  assert.equal(ui.getAccount(),null);
  assert.equal(ui.getActor(),'');
  assert.equal(location.hash,'');
  pending.resolve(Response.json(session()));await refresh;
  assert.equal(ui.getState(),null);
  assert.match(app.innerHTML,/你已退出当前账号/);
  assert.doesNotMatch(app.innerHTML,/app-shell|signout-with|signin-with/);
  const logoutRequest=requests.find(item=>item.path==='/api/auth/logout');
  assert.equal(logoutRequest.options.method,'POST');
  assert.equal(logoutRequest.options.body,'{}');
  assert.equal(logoutRequest.options.credentials,'same-origin');
});

test('failed logout does not report success or silently clear the authenticated workspace',async()=>{
  const {ui,app}=harness(async()=>{throw new Error('Network unavailable');});
  ui.acceptSession(session());
  await assert.rejects(ui.logout(),/退出未完成/);
  assert.ok(ui.getState().projects.length>0);
  assert.doesNotMatch(app.innerHTML,/你已退出/);
});


test('a password change unlocks the scoped employee workspace without requiring an email identity',async()=>{
  const ready=session();
  ready.actor=ready.state.users.find(user=>user.id==='u-engineer');
  ready.state=sanitizeStateForActor(ready.state,ready.actor.id);
  ready.account={id:'a-engineer',login:'employee.phone',role:'member',mustChangePassword:false};
  let sent;
  const {ui,app,location,toast}=harness(async(path,options)=>{sent={path,options};return Response.json(ready);});
  ui.acceptSession(restrictedSession());location.hash='#dashboard';
  const target=form();
  await ui.submitAuth(target,{currentPassword:'temporary-password',newPassword:'new-personal-password',confirmPassword:'new-personal-password',username:'employee.phone'},'change-password');
  assert.equal(sent.path,'/api/auth/password');
  assert.deepEqual(JSON.parse(sent.options.body),{currentPassword:'temporary-password',newPassword:'new-personal-password'});
  assert.equal(location.hash,'#overview');
  assert.equal(ui.getAccount().login,'employee.phone');
  assert.equal(ui.getAccount().email,undefined);
  assert.match(app.innerHTML,/employee-workspace/);
  assert.doesNotMatch(app.innerHTML,/href="#dashboard"|href="#accounts"|new-personal-password|temporary-password/);
  assert.match(toast.textContent,/新密码已保存/);
});

test('an incorrect current password keeps the restricted session available for correction',async()=>{
  const {ui,app}=harness(async()=>Response.json({code:'INVALID_CURRENT_PASSWORD',error:'当前密码不正确'},{status:400}));
  ui.acceptSession(restrictedSession());
  await assert.rejects(ui.submitAuth(form(),{currentPassword:'incorrect-password',newPassword:'new-personal-password',confirmPassword:'new-personal-password'},'change-password'),/当前密码不正确/);
  assert.equal(ui.getAccount().mustChangePassword,true);
  assert.equal(ui.getState(),null);
  assert.match(app.innerHTML,/先设置你的新密码/);
});


test('account creation and editing omit legacy member association and project selection sections',async()=>{
  const data=accountsSession();
  const {ui,modal}=harness(async()=>Response.json(data));
  ui.acceptSession(data);await ui.loadAccounts();
  for(const open of [()=>ui.newAccount(),()=>ui.newAccount('p-mower'),()=>ui.editAccount('a-engineer')]){
    open();assert.equal(modal.open,true);
    assert.doesNotMatch(modal.innerHTML,/关联项目成员|<legend>参与项目|name="(?:projectIds|existingUserId)"|id="account-project-memberships"/);
    assert.match(modal.innerHTML,/name="title"/);
  }
});

test('saving account profile omits project updates and preserves all current memberships',async()=>{
  const data=accountsSession();let sent;
  const before=data.state.projects.filter(p=>p.memberIds.includes('u-engineer')||p.ownerId==='u-engineer').map(p=>p.id);
  const {ui}=harness(async(path,options)=>{
    if(options?.method==='PATCH'){
      sent={path,body:JSON.parse(options.body)};
      assert.equal(Object.hasOwn(sent.body,'projectIds'),false,'editing a profile must not send an empty membership list');
      assert.equal(Object.hasOwn(sent.body,'existingUserId'),false);
    }
    return Response.json(data);
  });
  ui.acceptSession(data);await ui.loadAccounts();
  await ui.saveAccount('edit-account',{title:'销售',department:'业务部',role:'member',status:'active'},'a-engineer');
  assert.equal(sent.path,'/api/accounts/a-engineer');
  assert.deepEqual(ui.getState().projects.filter(p=>p.memberIds.includes('u-engineer')||p.ownerId==='u-engineer').map(p=>p.id),before);
});

test('project-based account creation sends only its current project while global creation assigns no projects',async()=>{
  const data=accountsSession(),sent=[];
  const {ui}=harness(async(path,options)=>{
    if(options?.method==='POST')sent.push({path,body:JSON.parse(options.body)});
    return Response.json(data);
  });
  ui.acceptSession(data);await ui.loadAccounts();
  const fields={login:'new.worker',password:'test-only-password',name:'新员工',role:'member',title:'工程师'};
  await ui.saveAccount('create-account',{...fields},'p-mower');
  assert.equal(sent[0].path,'/api/accounts');
  assert.deepEqual(sent[0].body.projectIds,['p-mower']);
  assert.equal(Object.hasOwn(sent[0].body,'existingUserId'),false);
  await ui.saveAccount('create-account',{...fields,login:'other.worker'},'');
  assert.equal(Object.hasOwn(sent[1].body,'projectIds'),false);
  assert.equal(Object.hasOwn(sent[1].body,'existingUserId'),false);
});

function approvalFixture() {
  const data=session();data.state.tasks=[];
  data.state.milestoneRequests=[{id:'node-pending',kind:'create',projectId:'p-mower',applicantId:'u-engineer',status:'pending',createdAt:'2026-11-03T08:00:00.000Z',proposed:{title:'待审批的新节点',dueDate:'2026-11-06T18:00:00+08:00'},reason:''}];
  data.state.extensions=[{id:'extension-pending',projectId:'p-mower',applicantId:'u-manager',status:'pending',createdAt:'2026-11-03T08:01:00.000Z',originalDueDate:'2026-11-06T18:00:00+08:00',newDueDate:'2026-11-08T18:00:00+08:00',plan:'完成交付',impact:'顺延两天',reason:''}];
  data.notifications=[notice('node-notice','approvals','node-pending'),notice('extension-notice','approvals','extension-pending')];
  return data;
}
const approvalNav = app => app.innerHTML.match(/<a href="#approvals"[^>]*>[\s\S]*?<\/a>/)?.[0]||'';

test('approval navigation remains red after all messages are read and a fresh session is loaded',async()=>{
  const data=approvalFixture();
  const {ui,app}=harness(async(path)=>Response.json(path==='/api/notifications/read'?{notifications:[]}:{...data,notifications:[]}));
  ui.acceptSession(data);ui.render();
  assert.match(approvalNav(app),/class="pending-task-count"[^>]*>2<\/span>/);
  await ui.markNotificationsRead(data.notifications.map(n=>n.id));ui.render();
  assert.equal(ui.getNotifications().length,0);
  assert.match(approvalNav(app),/class="pending-task-count"[^>]*>2<\/span>/);
  await ui.loadSession();
  assert.match(approvalNav(app),/class="pending-task-count"[^>]*>2<\/span>/);
  const reopened=harness(async()=>Response.json({...data,notifications:[]}));
  reopened.ui.acceptSession({...data,notifications:[]});reopened.ui.render();
  assert.match(approvalNav(reopened.app),/class="pending-task-count"[^>]*>2<\/span>/);
});

test('pending approvals have persistent type and record reminders until approved or rejected',async()=>{
  const data=approvalFixture();data.notifications=[];
  const {ui,app,listeners}=harness(async()=>Response.json({notifications:[]}));
  ui.acceptSession(data);ui.render();
  const click=async(action,id)=>{
    const button={dataset:{action,id},type:'button',closest:()=>null};
    await listeners.get('document:click')({target:{closest:selector=>selector==='[data-action]'?button:null},preventDefault(){}});
  };
  let page=ui.approvalsPage();
  for(const id of ['nodes','extensions']){
    const tab=page.match(new RegExp(`<button[^>]+data-action="approval-kind" data-id="${id}"[^>]*>[\\s\\S]*?<\\/button>`))?.[0]||'';
    assert.match(tab,/class="pending-task-count"[^>]*>1<\/span>/);
  }
  assert.match(page.match(/<article[\s\S]*?<\/article>/)?.[0]||'',/class="pending-approval-dot"/);
  await click('approval-kind','extensions');page=ui.approvalsPage();
  assert.match(page.match(/<article[\s\S]*?<\/article>/)?.[0]||'',/class="pending-approval-dot"/);
  data.state.milestoneRequests[0].status='approved';ui.render();
  assert.match(approvalNav(app),/class="pending-task-count"[^>]*>1<\/span>/);
  data.state.extensions[0].status='rejected';ui.render();
  assert.doesNotMatch(approvalNav(app),/pending-task-count/);
  await click('approval-filter','all');
  assert.doesNotMatch(ui.approvalsPage().match(/<article[\s\S]*?<\/article>/)?.[0]||'',/class="pending-approval-dot"/);
});

test('project cards and flow summaries agree as tasks finish before milestone confirmation',()=>{
  const {ui}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();
  const project=data.state.projects.find(item=>item.id==='p-mower');
  data.state.projects=[project];
  data.state.milestones=data.state.milestones.filter(item=>item.projectId===project.id);
  data.state.milestones.forEach(item=>{item.status='pending';item.acceptedAt=null;});
  data.state.tasks=data.state.tasks.filter(item=>item.projectId===project.id).slice(0,2);
  data.state.tasks[0].status='done';
  data.state.tasks[1].status='review';
  ui.acceptSession(data);
  for(const expected of [50,100]) {
    if(expected===100)ui.getState().tasks[1].status='done';
    for(const html of [ui.projectRow(project),ui.projectWorkspace(project)]) {
      assert.match(html,new RegExp(`任务完成率[\\s\\S]*?<strong>${expected}%</strong>`));
      assert.match(html,new RegExp(`aria-label="任务完成率"[^>]+aria-valuenow="${expected}"`));
      assert.doesNotMatch(html,/milestone-progress-step is-done|个节点完成/);
    }
    assert.equal(domain.projectProgress(ui.getState(),project.id),0);
    assert.doesNotMatch(ui.projectRow(project),/class="status green">已完成/);
  }
});

test('empty project progress displays a dash across project cards and flow summaries',()=>{
  const {ui}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();
  const project=data.state.projects[0];
  data.state.projects=[project];
  data.state.tasks=[];
  data.state.milestones=[];
  ui.acceptSession(data);
  for(const html of [ui.projectRow(project),ui.projectWorkspace(project)]) {
    assert.match(html,/任务完成率[\s\S]*?<strong>—<\/strong>/);
    assert.match(html,/aria-label="任务完成率"[^>]+aria-valuenow="0"/);
    assert.doesNotMatch(html,/NaN|Infinity|milestone-progress-dot/);
  }
});


test('only administrators can open direct milestone content editing and descriptions are escaped',()=>{
  const data=session(),target=data.state.milestones.find(item=>item.id==='m-mower-2');
  target.title='阶段 "方案"';target.description='第一行\n</p><img src=x onerror=alert(1)>';
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  ui.acceptSession(data);ui.milestoneDetail(target.id);
  assert.match(modal.innerHTML,/data-action="edit-milestone-content"/);
  assert.match(modal.innerHTML,/第一行\n&lt;\/p&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(modal.innerHTML,/<img/);
  ui.editMilestoneContent(target.id);
  assert.match(modal.innerHTML,/data-form="editMilestoneContent"/);
  assert.match(modal.innerHTML,/name="title"[^>]+value="阶段 &quot;方案&quot;"/);
  assert.match(modal.innerHTML,/<textarea[^>]+name="description"[^>]*>第一行\n&lt;\/p&gt;&lt;img src=x onerror=alert\(1\)&gt;<\/textarea>/);
  assert.doesNotMatch(modal.innerHTML,/name="(?:dueDate|status)"|<img/);
  for(const actorId of ['u-engineer','u-design']){
    const peer=harness(async()=>{throw new Error('Unexpected request');});
    const view=session();view.actor=view.state.users.find(user=>user.id===actorId);view.account={...view.account,role:view.actor.role};
    peer.ui.acceptSession(view);peer.ui.milestoneDetail(target.id);
    assert.doesNotMatch(peer.modal.innerHTML,/data-action="edit-milestone-content"/);
    peer.modal.close();const previous=peer.modal.innerHTML;
    peer.ui.editMilestoneContent(target.id);
    assert.equal(peer.modal.open,false);
    assert.equal(peer.modal.innerHTML,previous);
  }
});

test('ordinary members cannot edit a peer small task content and project owners may edit it',()=>{
  for(const id of ['u-engineer','u-manager']){
    const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});const data=session();
    data.actor=data.state.users.find(u=>u.id===id);data.account.role=data.actor.role;const target=data.state.tasks.find(t=>t.id==='t-02');ui.acceptSession(data);
    ui.taskDetail(target.id);assert.equal(modal.innerHTML.includes('data-action="edit-task-content"'),id==='u-manager');
    modal.close();ui.editTaskContent(target.id);assert.equal(modal.open,id==='u-manager');
  }
});

test('task content editors lock submitted acceptance criteria and escape text in forms and details',()=>{
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session(),target=data.state.tasks.find(item=>item.id==='t-03');
  target.title='任务 "版本"';target.description='工作说明\n</textarea><img src=x onerror=alert(1)>';
  target.acceptance='保留标准 <img src=y onerror=alert(2)>';
  ui.acceptSession(data);
  for(const status of ['todo','doing','review','done']){
    target.status=status;ui.editTaskContent(target.id);
    assert.match(modal.innerHTML,/name="title"[^>]+value="任务 &quot;版本&quot;"/);
    assert.match(modal.innerHTML,/<textarea[^>]+name="description"[^>]*>工作说明\n&lt;\/textarea&gt;&lt;img src=x onerror=alert\(1\)&gt;<\/textarea>/);
    assert.doesNotMatch(modal.innerHTML,/<img/);
    if(['todo','doing'].includes(status))assert.match(modal.innerHTML,/<textarea[^>]+name="acceptance"[^>]*required[^>]*>保留标准 &lt;img src=y onerror=alert\(2\)&gt;<\/textarea>/);
    else{
      assert.doesNotMatch(modal.innerHTML,/name="acceptance"/);
      assert.match(modal.innerHTML,/<p class="preserve-space">保留标准 &lt;img src=y onerror=alert\(2\)&gt;<\/p>/);
      assert.match(modal.innerHTML,/已提交验收的标准保持不变/);
    }
    ui.taskDetail(target.id);
    assert.match(modal.innerHTML,/工作说明\n&lt;\/textarea&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(modal.innerHTML,/<img/);
  }
});


async function clickUiAction(listeners,action,id) {
  const button={dataset:{action,id},type:'button',closest:()=>null};
  await listeners.get('document:click')({target:{closest:selector=>selector==='[data-action]'?button:null},preventDefault(){}});
}

test('the project owner can approve both application kinds but not their own requests',async()=>{
  for(const actorId of ['u-manager']){
    const {ui,modal,listeners}=harness(async()=>{throw new Error('Unexpected request');});
    const data=approvalFixture();data.notifications=[];
    const project=data.state.projects.find(item=>item.id==='p-mower');project.reviewerId='u-engineer';
    data.actor=data.state.users.find(user=>user.id===actorId);data.account={...data.account,role:data.actor.role};
    const node=data.state.milestoneRequests[0],extension=data.state.extensions[0];node.applicantId='u-qa';extension.applicantId='u-qa';
    ui.acceptSession(data);
    assert.match(ui.approvalsPage(),/data-action="approve-node-request"/);
    assert.match(ui.approvalsPage(),/data-action="reject-node-request"/);
    ui.reviewNodeRequest(node.id,true);assert.match(modal.innerHTML,/data-form="approveMilestoneRequest"/);
    await clickUiAction(listeners,'approval-kind','extensions');
    assert.match(ui.approvalsPage(),/data-action="approve-extension"/);
    assert.match(ui.approvalsPage(),/data-action="reject-extension"/);
    ui.reviewExtension(extension.id,true);assert.match(modal.innerHTML,/data-form="approveExtension"/);
    node.applicantId=actorId;extension.applicantId=actorId;
    assert.doesNotMatch(ui.approvalsPage(),/data-action="(?:approve|reject)-extension"/);
    await clickUiAction(listeners,'approval-kind','nodes');
    assert.doesNotMatch(ui.approvalsPage(),/data-action="(?:approve|reject)-node-request"/);
    modal.close();const previous=modal.innerHTML;
    for(const approve of [true,false]){ui.reviewNodeRequest(node.id,approve);ui.reviewExtension(extension.id,approve);}
    assert.equal(modal.open,false);assert.equal(modal.innerHTML,previous);
  }
});

test('an administrator may approve nodes but cannot approve another project’s extension',async()=>{
  const {ui,modal,listeners}=harness(async()=>{throw new Error('Unexpected request');});
  const data=approvalFixture();data.notifications=[];data.actor.role='admin';data.account.role='admin';
  data.state.projects.find(item=>item.id==='p-mower').reviewerId='u-engineer';
  ui.acceptSession(data);
  assert.match(ui.approvalsPage(),/待审批的新节点/);
  assert.match(ui.approvalsPage(),/data-action="(?:approve|reject)-node-request"/);
  await clickUiAction(listeners,'approval-kind','extensions');
  assert.match(ui.approvalsPage(),/完成交付/);
  assert.doesNotMatch(ui.approvalsPage(),/data-action="(?:approve|reject)-extension"/);
  ui.reviewNodeRequest('node-pending',true);assert.equal(modal.open,true);modal.close();
  ui.reviewExtension('extension-pending',true);assert.equal(modal.open,false);
});

test('project owners and administrators can manage node staff',()=>{
  for(const [actorId,role] of [['u-admin','superadmin'],['u-admin','admin'],['u-manager','member'],['u-engineer','member']]){
    const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});const data=session();
    data.actor=data.state.users.find(u=>u.id===actorId);data.actor.role=role;data.account.role=role;
    data.state.projects[0].reviewerId='u-engineer';
    data.companyMembers=[...data.state.users,{id:'second-admin',name:'管理员乙'}];ui.acceptSession(data);
    const allowed=role!=='member'||actorId==='u-manager';
    ui.setMilestoneCoReviewer('m-mower-2');assert.equal(modal.open,allowed);
    if(allowed){assert.equal(modal.innerHTML.includes('value="second-admin"'),role==='superadmin');assert.doesNotMatch(modal.innerHTML,/data-roster="reviewers" value="u-manager"/);assert.match(modal.innerHTML,/必签/);modal.close();}
    ui.setTaskReviewer('t-02');assert.equal(modal.open,allowed);
    if(allowed){assert.match(modal.innerHTML,/data-form="setTaskReviewer"/);assert.match(modal.innerHTML,/data-roster="owners" value="u-qa" checked/);assert.doesNotMatch(modal.innerHTML,/data-roster="signers" value="u-qa" disabled/);}
  }
});

test('ordinary project members can create tasks for teammates without gaining project management actions',()=>{
  const {ui,modal,toast}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();data.actor=data.state.users.find(user=>user.id==='u-engineer');data.account={...data.account,role:'member'};
  const project=data.state.projects.find(item=>item.id==='p-mower');project.reviewerId=null;
  ui.acceptSession(data);
  assert.doesNotMatch(ui.tasksPage(),/data-action="new-task"/);
  assert.match(ui.tasksPage(),/href="#overview">前往项目中心/);
  const page=ui.projectWorkspace(project);
  assert.match(page,/data-action="new-task"/);
  assert.doesNotMatch(page,/data-action="(?:new-project|set-project-reviewer|add-project-member)"/);
  ui.milestoneDetail('m-mower-2');
  assert.match(modal.innerHTML,/data-action="new-task"/);
  assert.doesNotMatch(modal.innerHTML,/data-action="(?:complete-milestone|edit-milestone-content)"/);
  ui.newTask(project.id,'m-mower-2');
  assert.match(modal.innerHTML,/data-form="createTask"/);
  assert.match(modal.innerHTML,/data-roster="owners" value="u-qa"/);
  assert.match(modal.innerHTML,/data-roster="owners" value="u-engineer"/);
  assert.match(modal.innerHTML,/<input type="hidden" name="milestoneId" value="m-mower-2">/);
  assert.doesNotMatch(modal.innerHTML,/value="p-site"/);
  modal.close();const previous=modal.innerHTML;
  ui.newProject();assert.equal(modal.open,false);assert.equal(modal.innerHTML,previous);
  assert.match(toast.textContent,/仅管理员可以创建项目/);
});

class ReviewFormData extends FormData {
  constructor(form){super();for(const [key,value] of Object.entries(form.fields))this.set(key,value);}
}
async function submitReviewForm(listeners,action,id,fields){
  const error={hidden:true,textContent:'',scrollIntoView(){}};
  const form={dataset:{form:action,id},fields,isConnected:true,querySelector:selector=>selector==='.form-error'?error:null};
  await listeners.get('document:submit')({target:{closest:()=>form},preventDefault(){}});
  return error.textContent;
}
test('disabled co-reviewer options cannot silently remove the second signature requirement',async()=>{
  const data=session(),m=data.state.milestones.find(x=>x.id==='m-mower-2');m.coReviewerId='inactive';
  data.milestoneReviewerOptions=[];let sent;
  const {ui,modal,listeners}=harness(async(_path,options)=>{sent=JSON.parse(options.body);return Response.json(data);},{FormData:ReviewFormData});
  ui.acceptSession(data);ui.setMilestoneCoReviewer(m.id);
  assert.match(modal.innerHTML,/data-roster="reviewers" value="inactive" checked/);
  assert.match(modal.innerHTML,/原选人员已不可用（可取消）/);
  assert.equal(sent,undefined);
});

test('the stage detail, canvas and confirmation enforce distinct signatures even after all child tasks pass',async()=>{
  const data=session(),m=data.state.milestones.find(x=>x.id==='m-mower-2'),p=data.state.projects[0];
  data.actor=data.state.users.find(u=>u.id===p.ownerId);data.account.role=data.actor.role;
  m.coReviewerId='u-qa';data.state.users.find(u=>u.id==='u-qa').role='admin';
  for(const child of data.state.tasks.filter(t=>t.milestoneId===m.id)){child.status='done';child.ownerId=p.ownerId;}
  const requests=[];
  const {ui,modal,listeners}=harness(async(path,options)=>{
    assert.equal(path,'/api/command');const body=JSON.parse(options.body);requests.push(body);
    data.state=domain.transact(data.state,body.action,body.payload,data.actor.id);data.revision++;
    return Response.json(data);
  },{FormData:ReviewFormData});
  ui.acceptSession(data);
  assert.match(ui.projectWorkspace(p),new RegExp('data-action="complete-milestone" data-id="'+m.id+'"'));
  ui.signMilestone(m.id);assert.match(modal.innerHTML,/name="as" value="owner"/);
  assert.equal(await submitReviewForm(listeners,'completeMilestone',m.id,{as:'owner'}),'');
  ui.milestoneDetail(m.id);assert.match(modal.innerHTML,/阶段签字 1 \/ 2/);assert.match(modal.innerHTML,/已签/);assert.match(modal.innerHTML,/待签字/);
  assert.doesNotMatch(modal.innerHTML,/data-action="complete-milestone"/);
  assert.match(await submitReviewForm(listeners,'completeMilestone',m.id,{as:'coReviewer'}),/不能签署/);
  assert.equal(requests.length,1);
  data.actor=data.state.users.find(u=>u.id==='u-qa');data.account={...data.account,id:'co',role:'admin'};
  ui.acceptSession(data);ui.signMilestone(m.id);assert.match(modal.innerHTML,/name="as" value="coReviewer"/);
  assert.equal(await submitReviewForm(listeners,'completeMilestone',m.id,{as:'coReviewer'}),'');
  ui.milestoneDetail(m.id);assert.match(modal.innerHTML,/阶段签字 2 \/ 2/);assert.match(modal.innerHTML,/已达成/);
  assert.equal(data.state.milestones.find(item=>item.id===m.id).status,'done');
});

test('super administrator can approve their own applications and sign one current open stage seat',async()=>{
  const data=approvalFixture(),id=data.actor.id;
  data.state.milestoneRequests[0].applicantId=id;data.state.extensions[0].applicantId=id;
  data.state.projects[0].reviewerId='u-engineer';data.notifications=[];
  const m=data.state.milestones.find(x=>x.id==='m-mower-2');m.coReviewerId='u-qa';
  data.state.tasks=[{id:'child',projectId:m.projectId,milestoneId:m.id,status:'done',ownerId:id}];
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});ui.acceptSession(data);
  ui.reviewNodeRequest('node-pending',true);assert.match(modal.innerHTML,/data-form="approveMilestoneRequest"/);
  ui.reviewExtension('extension-pending',false);assert.match(modal.innerHTML,/data-form="rejectExtension"/);
  ui.signMilestone(m.id);assert.match(modal.innerHTML,/<input type="hidden" name="as"/);
  assert.doesNotMatch(modal.innerHTML,/value="owner"/);assert.match(modal.innerHTML,/value="coReviewer"/);
  m.signatures=[{as:'coReviewer',actorId:id,at:new Date().toISOString()}];modal.close();ui.signMilestone(m.id);
  assert.equal(modal.open,false);
  data.actor=data.state.users.find(u=>u.id==='u-engineer');data.account.role=data.actor.role;ui.acceptSession(data);
  ui.reviewNodeRequest('node-pending',true);ui.reviewExtension('extension-pending',false);assert.equal(modal.open,false);
});

test('node details expose a scoped extension form and completed nodes do not offer postponement',async()=>{
  const {ui,modal,listeners}=harness(async()=>Response.json({})),data=session();data.state.extensions=[];ui.acceptSession(data);
  ui.taskDetail('t-03');assert.match(modal.innerHTML,/data-action="extend-task" data-id="t-03"/);
  await clickUiAction(listeners,'extend-task','t-03');
  assert.match(modal.innerHTML,/申请小节点延期/);assert.match(modal.innerHTML,/name="targetId" value="t-03"/);
  assert.match(modal.innerHTML,/name="targetType" value="task"/);assert.doesNotMatch(modal.innerHTML,/<select|name="taskIds"|name="milestoneIds"/);
  assert.match(modal.innerHTML,/id="extension-preview"/);
  ui.milestoneDetail('m-mower-2');assert.match(modal.innerHTML,/data-action="extend-milestone"/);
  await clickUiAction(listeners,'extend-milestone','m-mower-2');assert.match(modal.innerHTML,/申请大节点延期/);
  assert.match(modal.innerHTML,/name="targetId" value="m-mower-2"/);
  data.state.tasks.find(t=>t.id==='t-03').status='done';ui.taskDetail('t-03');assert.doesNotMatch(modal.innerHTML,/data-action="extend-task"/);
  ui.milestoneDetail('m-mower-1');assert.doesNotMatch(modal.innerHTML,/data-action="extend-milestone"/);
});

test('administrator creation has a direct command and project extension is outside the more menu',()=>{
  for(const role of ['admin','superadmin','member']){
    const {ui,modal}=harness(async()=>Response.json({})),data=session();data.actor.role=role;data.account.role=role;data.state.projects.find(p=>p.id==='p-mower').memberIds.push(data.actor.id);ui.acceptSession(data);
    const page=ui.projectWorkspace(data.state.projects[0]);
    assert.match(page,/data-action="new-extension"/);
    const more=page.match(/<details class="project-more">[\s\S]*?<\/details>/)?.[0]||'';
    assert.doesNotMatch(more,/new-extension/);
    ui.newMilestone('p-mower');
    assert.match(modal.innerHTML,new RegExp(`data-form="${role==='member'?'requestMilestone':'createMilestone'}"`));
    if(role!=='member'){assert.match(modal.innerHTML,/创建大节点/);assert.doesNotMatch(modal.innerHTML,/name="reason"/);}
  }
});

test('pending extensions show a persistent link in node details and block duplicate applications',()=>{
  const {ui,modal,toast}=harness(async()=>Response.json({})),data=session();
  data.state.extensions.push({id:'node-delay',projectId:'p-mower',targetType:'task',targetId:'t-03',status:'pending',applicantId:'u-engineer'});
  ui.acceptSession(data);ui.taskDetail('t-03');assert.match(modal.innerHTML,/查看待审批的延期/);
  assert.doesNotMatch(modal.innerHTML,/data-action="extend-task"/);
  const before=modal.innerHTML;ui.newNodeExtension('task','t-03');assert.equal(modal.innerHTML,before);assert.match(toast.textContent,/已有待审批/);
});

test('project participant management is limited to super admins and participating admins',async()=>{
  for(const [role,participation,allowed] of [['superadmin','outside',true],['admin','member',true],['admin','owner',true],['admin','outside',false],['member','owner',false],['member','member',false]]) {
    const data=accountsSession(),p=data.state.projects.find(p=>p.id==='p-site');
    data.actor.role=data.account.role=role;
    p.ownerId=participation==='owner'?data.actor.id:'u-ops';
    p.memberIds=p.memberIds.filter(id=>![data.actor.id,'u-engineer'].includes(id));
    if(participation==='member')p.memberIds.push(data.actor.id);
    let mutations=0,requests=0;
    const {ui,modal}=harness(async(path,options)=>{requests++;if(options?.method==='PATCH')mutations++;return Response.json(data);});
    ui.acceptSession(data);await ui.loadAccounts();
    const page=ui.projectWorkspace(p);
    assert.equal(page.includes('data-action="add-project-member"'),allowed,`${role} ${participation}`);
    await ui.addProjectMember(p.id);
    if(allowed){
      assert.match(modal.innerHTML,/添加项目参与人|加入项目/);
      assert.match(modal.innerHTML,/选择公司成员/);
      assert.doesNotMatch(modal.innerHTML,/开通新成员|name="password"/);
    } else {
      assert.equal(modal.open,false);assert.equal(requests,role==='member'?0:1);
      await assert.rejects(ui.saveProjectMember(form(),{accountId:'a-engineer'},p.id),/仅总管理员或已参与该项目/);
      ui.newAccount(p.id);assert.equal(modal.open,false);
      await assert.rejects(ui.saveAccount('create-account',{login:'not-sent',role:'member'},p.id),/仅管理员|仅总管理员或已参与该项目/);
    }
    assert.equal(mutations,0);
  }
});

test('node staffing cannot offer new project participants to an outside admin or employee',()=>{
  for(const [role,participating,canAdd] of [['superadmin',false,true],['admin',true,true],['admin',false,false],['member',true,false]]) {
    const data=session(),p=data.state.projects.find(p=>p.id==='p-mower');
    data.actor.role=data.account.role=role;p.memberIds=p.memberIds.filter(id=>id!==data.actor.id&&id!=='u-ops');
    if(participating)p.memberIds.push(data.actor.id);
    const {ui,modal}=harness(async()=>Response.json(data));ui.acceptSession(data);
    ui.newTask(p.id,'m-mower-2');
    assert.equal(modal.innerHTML.includes('data-roster="owners" value="u-ops"'),canAdd);
    assert.match(modal.innerHTML,/data-roster="owners" value="u-engineer"/);
  }
});
