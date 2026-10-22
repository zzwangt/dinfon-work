import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as domain from '../public/client/domain.js';
import * as times from '../public/client/time.js';
import { canAccessRoute, sanitizeStateForActor } from '../public/client/access.js';

// Exercise the browser controller with controlled network timing. No credentials are real.
const source = (await readFile(new URL('../public/client/app.js', import.meta.url), 'utf8'))
  .replace(/^import .+;\n/gm, '')
  .replace(/^await loadSession\(\);$/m, '');
function harness(fetchImpl) {
  const app = { innerHTML: '' }, content = { innerHTML: '' };
  const toast = { hidden: true, textContent: '', classList: { toggle() {} } };
  const modal = { innerHTML: '', open: false, close() { this.open=false; }, showModal() { this.open=true; }, querySelector() { return null; }, addEventListener() {} };
  const location = { hash: '#tasks', pathname: '/', search: '' }, listeners = new Map();
  const document = {
    title: '', hidden: false,
    querySelector: (selector) => ({ '#app':app, '#content':content, '#modal':modal, '#toast':toast }[selector]),
    querySelectorAll: () => [],
    addEventListener: (name,fn) => listeners.set(`document:${name}`,fn),
  };
  const context = {
    ...domain, ...times, canAccessRoute, document, location,
    window: { addEventListener:(name,fn)=>listeners.set(`window:${name}`,fn), scrollTo() {} },
    history: { replaceState(_state,_unused,url) { location.hash=url.includes('#')?url.slice(url.indexOf('#')):''; } },
    fetch: fetchImpl, FormData, Response, URL, Blob, Set, console,
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}, queueMicrotask,
    renderInstallCard:()=>'<aside>手机桌面版</aside>', initPWA() {},
    renderMilestoneProgress:()=>'', renderProgressNote:()=>'', renderProgressTrack:()=>'', bindFlowCanvas() {},
  };
  const ui=runInNewContext(`(()=>{${source}\nreturn {acceptSession,loadSession,submitAuth,logout,render,authScreen,getState:()=>state,getAccount:()=>accountInfo,getActor:()=>actorId,accountProjectFields,selectedAccountProjects,newAccount};})()`,context);
  return {ui,app,content,toast,modal,location,listeners};
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
  assert.equal(location.hash,'#tasks');
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
