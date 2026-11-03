import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as domain from '../public/client/domain.js';
import * as times from '../public/client/time.js';
import { canAccessRoute, sanitizeStateForActor } from '../public/client/access.js';
import { renderMilestoneProgress } from '../public/client/milestone-progress.js';
import { renderProjectFlow } from '../public/client/flow.js';
import * as noticeUI from '../public/client/notifications.js';
import { renderProjectPeopleSummary } from '../public/client/project-team.js';
import { renderProgressNote, renderProgressTrack } from '../public/client/progress.js';
import { taskReminderSummary } from '../public/client/task-reminders.js';
import { buildWeeklyReport, createWeeklyExport } from '../public/client/weekly-export.js';

// Exercise the browser controller with controlled network timing. No credentials are real.
const source = (await readFile(new URL('../public/client/app.js', import.meta.url), 'utf8'))
  .replace(/^import .+;\n/gm, '')
  .replace(/^await loadSession\(\);$/m, '');
function harness(fetchImpl) {
  const app = { innerHTML: '' }, content = { innerHTML: '' };
  const downloads=[], objectUrls=new Map();
  class DownloadURL extends URL {
    static createObjectURL(blob) { const id=`blob:test-${objectUrls.size}`;objectUrls.set(id,blob);return id; }
    static revokeObjectURL(id) { objectUrls.delete(id); }
  }
  const toast = { hidden: true, textContent: '', classList: { toggle() {} } };
  const modal = { innerHTML: '', open: false, close() { this.open=false; }, showModal() { this.open=true; }, querySelector() { return null; }, addEventListener() {} };
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
    ...domain, ...times, ...noticeUI, canAccessRoute, document, location,
    window: { addEventListener:(name,fn)=>listeners.set(`window:${name}`,fn), scrollTo() {} },
    history: { replaceState(_state,_unused,url) { location.hash=url.includes('#')?url.slice(url.indexOf('#')):''; } },
    fetch: fetchImpl, FormData, Response, URL:DownloadURL, Blob, Set, console,
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}, queueMicrotask,
    renderInstallCard:()=>'<aside>手机桌面版</aside>', initPWA() {},
    renderMilestoneProgress, renderProgressNote, renderProgressTrack,
    taskReminderSummary, buildWeeklyReport, createWeeklyExport,
    renderProjectFlow, renderProjectPeopleSummary, bindFlowCanvas() {},
  };
  const ui=runInNewContext(`(()=>{${source}\nreturn {acceptSession,loadSession,submitAuth,logout,render,authScreen,getState:()=>state,getAccount:()=>accountInfo,getActor:()=>actorId,accountProjectFields,selectedAccountProjects,newAccount,editAccount,accountRowActions,accountsPage,resetPassword,saveAccount,projectRow,projectWorkspace,taskRow,weeklyPage,notificationCenter,markNotificationsRead,readEntityNotifications,openNotification,loadAccounts,addProjectMember,saveProjectMember,availableProjectAccounts,getNotifications:()=>notifications};})()`,context);
  return {ui,app,content,toast,modal,location,listeners,downloads};
}
function session(overrides={}) {
  const state=domain.createSeedState();
  return {state,actor:state.users.find(user=>user.id==='u-admin'),account:{id:'a-admin',login:'qa-admin',role:'admin',mustChangePassword:false},revision:1,...overrides};
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

test('task navigation shows persistent work counts while messages retain their unread badges',()=>{
  const {ui,app,modal}=harness(async()=>{throw new Error('Unexpected request');});
  const data=session();const target=data.state.tasks[0];
  data.notifications=[notice('n1','tasks',target.id,target.projectId),notice('n2','approvals','r1',target.projectId)];
  data.notifications[0].title='<img src=x onerror=alert(1)>';
  ui.acceptSession(data);ui.render();
  assert.match(app.innerHTML,/<a href="#tasks"[^>]*>[\s\S]*?<span class="pending-task-count"/);
  assert.match(app.innerHTML,/class="notification-trigger[^>]*>[\s\S]*?class="unread-count"[^>]*>2<\/span>/);
  assert.match(app.innerHTML,/data-unread-category="approvals"[^>]*><span class="unread-count"[^>]*>1<\/span>/);
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

test('account refresh supplies project options from the same revision snapshot',async()=>{
  const fresh=session({revision:8});fresh.accounts=[];
  fresh.state.projects.push({...fresh.state.projects[0],id:'p-fresh',name:'另一管理员刚建立的项目',memberIds:[]});
  const {ui}=harness(async()=>Response.json(fresh));ui.acceptSession(session());
  await ui.loadAccounts();assert.ok(ui.getState().projects.some(p=>p.id==='p-fresh'));
  assert.match(ui.accountProjectFields(),/另一管理员刚建立的项目/);
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

function accountsSession(isSuperAdmin=false) {
  const data=session();
  data.account={...data.account,userId:'u-admin',isSuperAdmin};
  data.state.users.push({id:'u-peer-admin',name:'其他管理员',role:'admin',title:'采购',department:'供应链'});
  data.accounts=[
    {...data.account,name:data.actor.name,status:'active',title:'运营总监'},
    {id:'a-peer-admin',userId:'u-peer-admin',name:'其他管理员',login:'peer.admin',role:'admin',isSuperAdmin:false,status:'active',title:'采购',department:'供应链'},
    {id:'a-engineer',userId:'u-engineer',name:'工程师',login:'engineer',role:'member',isSuperAdmin:false,status:'active',title:'工程师'},
  ];
  if(!isSuperAdmin){
    data.state.users.push({id:'u-super-admin',name:'总管理员',role:'admin'});
    data.accounts.push({id:'a-super-admin',userId:'u-super-admin',name:'总管理员',login:'owner',role:'admin',isSuperAdmin:true,status:'active'});
  }
  return data;
}

test('ordinary administrators can manage employees but cannot reset or edit administrator security',async()=>{
  const data=accountsSession();let requests=0;
  const {ui,modal}=harness(async()=>{requests++;return Response.json(data);});
  ui.acceptSession(data);await ui.loadAccounts();
  for(const id of ['a-peer-admin','a-super-admin']){
    const account=data.accounts.find(item=>item.id===id);
    assert.doesNotMatch(ui.accountRowActions(account),/data-action="reset-password"/);
    ui.editAccount(id);
    assert.doesNotMatch(modal.innerHTML,/<select[^>]+name="(?:role|status)"/);
    assert.match(modal.innerHTML,/<input[^>]+name="title"/);
    assert.throws(()=>ui.resetPassword(id),/总管理员/);
  }
  const employee=data.accounts.find(item=>item.id==='a-engineer');
  assert.match(ui.accountRowActions(employee),/data-action="reset-password"/);
  ui.editAccount(employee.id);
  assert.match(modal.innerHTML,/<select[^>]+name="status"/);
  assert.doesNotMatch(modal.innerHTML,/<option value="admin"/);
  ui.newAccount();assert.doesNotMatch(modal.innerHTML,/<option value="admin"/);
  assert.equal(requests,1,'opening security forms must not submit mutations');
});

test('the super administrator can manage peer administrators while their own security remains protected',async()=>{
  const data=accountsSession(true);
  const {ui,modal}=harness(async()=>Response.json(data));
  ui.acceptSession(data);await ui.loadAccounts();
  const peer=data.accounts.find(item=>item.id==='a-peer-admin');
  assert.match(ui.accountRowActions(peer),/data-action="reset-password"/);
  ui.editAccount(peer.id);
  assert.match(modal.innerHTML,/<select[^>]+name="role"/);
  assert.match(modal.innerHTML,/<select[^>]+name="status"/);
  ui.resetPassword(peer.id);assert.match(modal.innerHTML,/data-form="reset-password"/);
  ui.newAccount();assert.match(modal.innerHTML,/<option value="admin"/);
  const own=data.accounts.find(item=>item.id==='a-admin');
  assert.match(ui.accountRowActions(own),/data-action="change-password"/);
  assert.doesNotMatch(ui.accountRowActions(own),/data-action="reset-password"/);
  ui.editAccount(own.id);assert.doesNotMatch(modal.innerHTML,/<select[^>]+name="(?:role|status)"/);
  ui.resetPassword(own.id);assert.match(modal.innerHTML,/data-form="change-password"/);
  assert.match(ui.accountsPage(),/总管理员/);
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

test('opening a new member from a project preselects that project',()=>{
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  ui.acceptSession(session());ui.newAccount('p-mower');
  assert.match(modal.innerHTML,/开通新成员/);
  assert.match(modal.innerHTML,/data-form="create-account" data-id="p-mower"/);
  assert.match(modal.innerHTML,/<input[^>]+name="projectIds"[^>]+value="p-mower"[^>]* checked/);
  assert.match(modal.innerHTML,/开通并加入项目/);
});

test('reading messages leaves persistent task badges visible through submission until acceptance',async()=>{
  const data=session();data.actor=data.state.users.find(user=>user.id==='u-engineer');
  data.account={id:'a-engineer',login:'engineer',role:'member',mustChangePassword:false};
  data.state=sanitizeStateForActor(data.state,data.actor.id);
  const task=data.state.tasks.find(item=>item.ownerId===data.actor.id);
  data.state.tasks=[task];task.status='todo';
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


test('account project choices reflect existing participation and lock project owner access',()=>{
  const {ui,modal}=harness(async()=>{throw new Error('Unexpected request');});
  ui.acceptSession(session());
  const selections=(html)=>[...html.matchAll(/<input[^>]+name="projectIds"[^>]+>/g)].map(([input])=>({id:input.match(/value="([^"']+)"/)[1],checked:/ checked/.test(input),disabled:/ disabled/.test(input)}));
  assert.deepEqual(selections(ui.accountProjectFields()).filter(item=>item.checked),[]);
  assert.deepEqual(selections(ui.accountProjectFields('u-engineer')).filter(item=>item.checked).map(item=>item.id),['p-mower','p-pcb']);
  const ownerChoices=selections(ui.accountProjectFields('u-manager'));
  assert.deepEqual(ownerChoices.filter(item=>item.disabled).map(item=>item.id),['p-mower','p-pcb','p-site']);
  assert.ok(ownerChoices.filter(item=>item.disabled).every(item=>item.checked));
  assert.equal(ownerChoices.find(item=>item.id==='p-delivery').disabled,false);
  ui.newAccount();
  assert.equal(modal.open,true);
  assert.match(modal.innerHTML,/参与项目/);
  assert.match(modal.innerHTML,/已有任务负责人不会自动更换/);
  const adminChoices=ui.accountProjectFields('u-manager','admin');
  assert.match(adminChoices,/不限制管理员权限/);
  assert.deepEqual(selections(adminChoices),ownerChoices);
});

test('project submission includes locked owned projects and deduplicates checked choices',()=>{
  const {ui}=harness(async()=>{throw new Error('Unexpected request');});
  ui.acceptSession(session());
  const choices=new FormData();choices.append('projectIds','p-delivery');choices.append('projectIds','p-delivery');
  assert.deepEqual(Array.from(ui.selectedAccountProjects(choices,'u-manager')),['p-delivery','p-mower','p-pcb','p-site']);
  assert.deepEqual(Array.from(ui.selectedAccountProjects(new FormData(),'u-manager')),['p-mower','p-pcb','p-site']);
  assert.deepEqual(Array.from(ui.selectedAccountProjects(new FormData(),'u-engineer')),[]);
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
