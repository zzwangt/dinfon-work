import test from 'node:test';
import assert from 'node:assert/strict';
import { bindMaintenancePanel, maintenanceIsBusy, renderMaintenanceContent, renderMaintenancePanel, resetMaintenance } from '../public/client/maintenance.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const fixture=()=>({settings:{enabled:true,time:'02:00',retention:14},nextBackup:'2026-11-03T18:00:00.000Z',lastBackup:{createdAt:'2026-11-03T09:00:00.000Z'},backups:[{id:'backup-1',createdAt:'2026-11-03T09:00:00.000Z',reason:'scheduled',size:1048576}],upgrade:{supported:true,currentVersion:'1.0.0',currentBuild:'build-old',status:'idle',staged:{id:'stage-current',version:'1.1.0',buildId:'build-new',files:90,size:524288}}});
function mounted(t,{timers=false}={}) {
  resetMaintenance();t.after(resetMaintenance);
  const host={dataset:{},isConnected:true,innerHTML:'',listeners:new Map(),addEventListener(name,callback){this.listeners.set(name,callback);}};
  const root={querySelector:selector=>selector==='[data-maintenance-root]'?host:null};
  const errors=[],pendingTimers=[];let reloads=0;
  const oldWindow=globalThis.window;
  globalThis.window={location:{reload(){reloads+=1;}}};
  t.after(()=>{if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;});
  if(timers)t.mock.method(globalThis,'setTimeout',(callback,ms)=>{assert.equal(ms,1500);pendingTimers.push(callback);return pendingTimers.length;});
  return {
    host,errors,pendingTimers,get reloads(){return reloads;},
    bind(){bindMaintenancePanel({root,onError:error=>errors.push(error)});},
    submit(kind,elements){return host.listeners.get('submit')({target:{dataset:{maintenanceForm:kind},elements,matches:selector=>selector==='[data-maintenance-form]'},preventDefault(){},stopPropagation(){}});},
    click(action,stageId='stage-current'){return host.listeners.get('click')({target:{closest:()=>({dataset:{maintenanceAction:action,stageId}})}});},
    async advance(){assert.ok(pendingTimers.length,'a restart check is scheduled');pendingTimers.shift()();await tick();await tick();},
  };
}

test('maintenance forms and backup history expose status and escape untrusted display data',()=>{
  const data=fixture();const attack='<img src=x onerror=alert(1)>';
  data.backupError=attack;data.upgrade.lastError=attack;data.upgrade.currentVersion=attack;data.upgrade.staged.version=attack;data.upgrade.staged.id='x" onclick="alert(1)';data.backups[0].id='b" onclick="alert(1)';
  const html=renderMaintenanceContent(data,{busy:true,message:attack});
  assert.match(renderMaintenancePanel(),/正在读取备份与升级设置/);
  assert.match(html,/name="enabled" checked disabled/);assert.match(html,/name="time" value="02:00" required disabled/);assert.match(html,/name="retention" value="14" min="1" max="90" required disabled/);
  assert.match(html,/自动备份/);assert.match(html,/2026\.11\.03 17:00/);assert.match(html,/1.0 MB/);
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/ onclick="/);
  assert.match(html,/\/api\/maintenance\/backups\/b%22%20onclick%3D%22alert\(1\)\/download/);
  const unsupported=renderMaintenanceContent({...data,upgrade:{supported:false}});
  assert.match(unsupported,/当前启动方式不支持自动重启/);assert.doesNotMatch(unsupported,/data-maintenance-form="prepare"/);
});

test('saving backup settings sends typed values once and keeps busy feedback until confirmed',async t=>{
  const view=mounted(t),data=fixture(),pending=deferred(),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return path.endsWith('/settings')?pending.promise:Response.json(data);});
  view.bind();await tick();
  view.submit('settings',{enabled:{checked:false},time:{value:'04:30'},retention:{value:'7'}});
  assert.equal(maintenanceIsBusy(),true);assert.match(view.host.innerHTML,/正在处理/);assert.doesNotMatch(view.host.innerHTML,/自动备份设置已保存/);
  view.click('backup');assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
  const settings=calls.find(call=>call.path.endsWith('/settings'));
  assert.deepEqual(JSON.parse(settings.options.body),{enabled:false,time:'04:30',retention:7});assert.equal(settings.options.headers['Content-Type'],'application/json');
  data.settings={enabled:false,time:'04:30',retention:7};pending.resolve(Response.json({ok:true}));await tick();await tick();
  assert.equal(maintenanceIsBusy(),false);assert.match(view.host.innerHTML,/自动备份设置已保存/);assert.match(view.host.innerHTML,/name="time" value="04:30"/);
});

test('update package preparation uploads the file as multipart with its bytes unchanged',async t=>{
  const view=mounted(t),data=fixture(),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json(path.endsWith('/prepare')?{ok:true}:data);});
  view.bind();await tick();
  const archive=new File(['package-content'],'dinfon-update.zip',{type:'application/zip'});
  view.submit('prepare',{archive:{files:[archive]}});await tick();await tick();
  const upload=calls.find(call=>call.path==='/api/maintenance/upgrade/prepare');assert.ok(upload);
  assert.equal(upload.options.method,'POST');assert.equal(upload.options.headers,undefined,'browser owns the multipart boundary');assert.ok(upload.options.body instanceof FormData);
  assert.equal(upload.options.body.get('archive').name,archive.name);assert.equal(await upload.options.body.get('archive').text(),'package-content');
  assert.match(view.host.innerHTML,/更新包已检查，可以开始升级/);assert.equal(view.reloads,0);
});

test('logout aborts maintenance operations and ignores their late successful responses',async t=>{
  const view=mounted(t),data=fixture(),pending=deferred();let requestSignal;
  t.mock.method(globalThis,'fetch',async(path,options)=>{if(path.endsWith('/backup')){requestSignal=options.signal;return pending.promise;}return Response.json(data);});
  view.bind();await tick();view.click('backup');assert.equal(maintenanceIsBusy(),true);
  resetMaintenance();view.host.innerHTML='';assert.equal(requestSignal.aborted,true);assert.equal(maintenanceIsBusy(),false);
  pending.resolve(Response.json({ok:true}));await tick();await tick();
  assert.equal(view.host.innerHTML,'');assert.equal(view.reloads,0);assert.equal(maintenanceIsBusy(),false);
});

test('an explicit failed upgrade stops polling and shows any server error without claiming completion',async t=>{
  const view=mounted(t,{timers:true}),data=fixture();let reads=0;
  t.mock.method(globalThis,'fetch',async(path)=>{
    if(path.endsWith('/apply'))return Response.json({ok:true});
    reads+=1;return Response.json(reads===1?data:{...data,upgrade:{...data.upgrade,status:'failed',lastError:'磁盘校验错误'}});
  });
  view.bind();await tick();view.click('apply');await tick();await tick();
  assert.match(view.host.innerHTML,/正在升级，请稍候/);assert.equal(maintenanceIsBusy(),true);
  await view.advance();
  assert.match(view.host.innerHTML,/磁盘校验错误/);assert.doesNotMatch(view.host.innerHTML,/升级完成，正在刷新/);assert.equal(view.reloads,0);assert.equal(view.pendingTimers.length,0);assert.equal(maintenanceIsBusy(),false);
});

test('restart polling ignores older or uncorrelated success and reloads only for this stage',async t=>{
  const view=mounted(t,{timers:true}),data=fixture();let reads=0;
  const results=[data,{...data,upgrade:{status:'succeeded',lastResult:{stageId:'stage-old'}}},{...data,upgrade:{status:'succeeded',lastResult:{}}},{...data,upgrade:{status:'succeeded',lastResult:{stageId:'stage-current'}}}];
  t.mock.method(globalThis,'fetch',async(path)=>path.endsWith('/apply')?Response.json({ok:true}):Response.json(results[reads++]));
  view.bind();await tick();view.click('apply');await tick();await tick();
  await view.advance();assert.equal(view.reloads,0);assert.doesNotMatch(view.host.innerHTML,/升级完成，正在刷新/);
  await view.advance();assert.equal(view.reloads,0);assert.doesNotMatch(view.host.innerHTML,/升级完成，正在刷新/);
  await view.advance();assert.equal(view.reloads,1);assert.match(view.host.innerHTML,/升级完成，正在刷新/);assert.equal(view.pendingTimers.length,0);
});

test('failed backup requests retain an error and never display a saved-backup message',async t=>{
  const view=mounted(t),data=fixture();
  t.mock.method(globalThis,'fetch',async(path)=>path.endsWith('/backup')?Response.json({error:'备份目录不可写'},{status:503}):Response.json(data));
  view.bind();await tick();view.click('backup');await tick();await tick();
  assert.match(view.host.innerHTML,/备份目录不可写/);assert.doesNotMatch(view.host.innerHTML,/完整备份已保存，包含/);assert.equal(maintenanceIsBusy(),false);
});
