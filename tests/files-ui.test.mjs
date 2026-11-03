import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState } from '../public/client/domain.js';
import { renderProjectFlow } from '../public/client/flow.js';
import { renderProjectFiles, renderNodeFiles, renderFileRows, renderFileGroups, bindProjectFiles, resetProjectFiles, hasActiveFileOperations } from '../public/client/files.js';

function fixture() {
  const state=createSeedState(),project=state.projects.find(item=>item.id==='p-mower');
  const task=state.tasks.find(item=>item.projectId===project.id);
  const file={id:'file-a',projectId:project.id,entityType:'task',entityId:task.id,name:'测试报告.pdf',size:4096,mimeType:'application/pdf',uploadedBy:'u-engineer',uploadedAt:'2026-11-03T09:00:00.000Z',canDelete:true};
  return {state,project,task,file};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Element {
  constructor(dataset={}) {this.dataset=dataset;this.listeners=new Map();this.isConnected=true;this.innerHTML='';this.textContent='';this.value='';this.disabled=false;this.classList={toggle(){},add(){},remove(){}};}
  addEventListener(name,handler){this.listeners.set(name,handler);}
  matches(){return false;}
  querySelector(selector){return this.elements?.[selector]||null;}
  querySelectorAll(){return [];}
  contains(node){return node===this;}
  setAttribute(name,value){(this.attributes ||= {})[name]=value;}
  focus(){this.focused=true;}
  showModal(){this.open=true;}
  close(){this.open=false;this.dispatch('close');}
  remove(){this.isConnected=false;}
  dispatch(name,target=this,extra={}){return this.listeners.get(name)?.({target,preventDefault(){},stopPropagation(){},...extra});}
}
function mounted(f=fixture(),{node=false}={}) {
  const host=new Element({projectId:f.project.id,...(node?{entityType:'task',entityId:f.task.id}:{})});
  host.elements=Object.fromEntries(['[data-file-status]','[data-file-pick]','[data-file-input]','[data-file-drop]','[data-file-list]','[data-file-refresh]','[data-file-total]'].map(key=>[key,new Element()]));
  if(!node)host.elements['[data-file-search]']=new Element();
  const root=new Element();root.querySelectorAll=selector=>selector==='[data-project-files]'?[host]:[];
  let state=f.state,actorId='u-engineer';
  const context={getState:()=>state,getActorId:()=>actorId};
  return {host,root,context,changeIdentity(){state=null;actorId='';resetProjectFiles();},element:selector=>host.elements[selector]};
}

function browser(t) {
  const oldDocument=globalThis.document,oldWindow=globalThis.window,dialogs=[],events=new Map();
  globalThis.window={addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name,fn)=>{if(events.get(name)===fn)events.delete(name);},confirm:()=>true};
  globalThis.document={activeElement:new Element(),body:{append(dialog){dialogs.push(dialog);dialog.isConnected=true;}},createElement(tag){assert.equal(tag,'dialog');const dialog=new Element();dialog.elements=Object.fromEntries(['[data-file-target-select]','[data-file-target-error]','[data-file-target-note]'].map(key=>[key,new Element()]));return dialog;}};
  t.after(()=>{resetProjectFiles();if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;});
  return {dialogs,events,get dialog(){return dialogs.findLast(dialog=>dialog.isConnected);},choose(id){const dialog=this.dialog;assert.ok(dialog,'file-target dialog is open');dialog.querySelector('[data-file-target-select]').value=id;dialog.querySelector('[data-file-target-select]').dispatch('change');dialog.dispatch('submit');},cancel(){this.dialog.dispatch('cancel');}};
}

test('file center follows 我的任务 and opens project-only files without a flow canvas',()=>{
  const f=fixture();
  const flow=renderProjectFlow(f.state,f.project,{actorId:'u-engineer'});
  assert.match(flow,/data-id="mine"[^>]*>我的任务<\/button><button[^>]*data-id="files"[^>]*>文件管理中心/);
  const files=renderProjectFlow(f.state,f.project,{actorId:'u-engineer',scope:'files'});
  assert.match(files,/data-id="files" aria-pressed="true"/);
  assert.match(files,/data-project-files data-project-id="p-mower"/);
  assert.doesNotMatch(files,/data-flow-canvas/);
  assert.doesNotMatch(files,/全部节点与任务|data-file-node|<select/);
  assert.match(files,/拖入或选择文件/);
  for(const task of f.state.tasks.filter(item=>item.projectId!==f.project.id))assert.ok(!files.includes(`value="task:${task.id}"`));
});

test('files remain reachable before a project has any nodes',()=>{
  const f=fixture();f.state.milestones=[];f.state.tasks=[];
  const flow=renderProjectFlow(f.state,f.project);
  assert.match(flow,/文件管理中心/);
  assert.match(renderProjectFiles(f.state,f.project),/项目添加大节点后即可上传文件/);
});

test('milestone and task cards expose correct drop targets and dialogs provide file picker alternatives',()=>{
  const f=fixture();
  const flow=renderProjectFlow(f.state,f.project,{expandedIds:f.state.milestones.map(item=>item.id)});
  assert.match(flow,new RegExp(`data-node-file-drop data-file-project="${f.project.id}" data-file-type="task" data-file-id="${f.task.id}"`));
  assert.match(flow,/data-node-file-drop data-file-project="p-mower" data-file-type="milestone"/);
  const panel=renderNodeFiles(f.project.id,'task',f.task.id);
  assert.match(panel,/type="button"[^>]*data-file-pick/);
  assert.match(panel,/type="file" multiple/);
  assert.match(panel,/data-entity-type="task"/);
});

test('file rows escape names, show ownership and time, filter nodes and expose only allowed delete actions',()=>{
  const f=fixture();f.file.name='<img src=x onerror=alert(1)>.pdf';
  const readonly={...f.file,id:'file-b',name:'另一份报告.docx',canDelete:false,entityType:'milestone',entityId:f.state.milestones[0].id};
  const html=renderFileRows([f.file,readonly],f.state);
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
  assert.match(html,/\/api\/files\/file-a\/download/);assert.match(html,/data-file-delete="file-a"/);assert.doesNotMatch(html,/data-file-delete="file-b"/);
  assert.match(html,/2026\.11\.03 17:00/);assert.match(html,/4.0 KB/);
  assert.doesNotMatch(renderFileRows([f.file,readonly],f.state,{node:`task:${f.task.id}`}),/另一份报告/);
  assert.match(renderFileRows([f.file,readonly],f.state,{query:'无匹配'}),/没有符合条件/);
});

test('project file loading scopes requests and filtering does not refetch other projects',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const f=fixture(),view=mounted(f),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json({files:[f.file],maxFileBytes:20*1024*1024});});
  bindProjectFiles(view.root,view.context);await tick();
  assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/files?projectId=p-mower');
  assert.match(view.element('[data-file-list]').innerHTML,/测试报告/);
  assert.equal(view.element('[data-file-pick]').disabled,false,'files can be picked before the target chooser');
  view.element('[data-file-search]').value='无匹配';view.element('[data-file-search]').dispatch('input');
  assert.match(view.element('[data-file-list]').innerHTML,/没有符合条件/);assert.equal(calls.length,1);
});

test('node upload sends multipart association, preserves bytes, and refreshes its file list',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const b=browser(t),f=fixture(),view=mounted(f,{node:true}),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json(options.method==='POST'?{file:f.file}:{files:[],maxFileBytes:20*1024*1024});});
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['known-content'],'hello.txt',{type:'text/plain'})];input.dispatch('change');await tick();
  assert.ok(b.dialog);assert.equal(calls.filter(call=>call.options.method==='POST').length,0);
  b.choose(f.task.milestoneId);await tick();await tick();
  const upload=calls.find(call=>call.options.method==='POST');assert.ok(upload);
  assert.ok(upload.options.body instanceof FormData);assert.equal(upload.options.headers,undefined,'browser sets multipart boundary');
  assert.equal(upload.options.body.get('entityId'),f.task.id);assert.equal(upload.options.body.get('entityType'),'task');assert.equal(upload.options.body.get('projectId'),f.project.id);
  assert.equal(await upload.options.body.get('file').text(),'known-content');
  assert.equal(calls.filter(call=>!call.options.method).length,2);
  assert.match(view.element('[data-file-status]').textContent,/已上传 1 个文件/);
});

test('oversize files are rejected before upload and failed requests show server errors',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const b=browser(t),f=fixture(),view=mounted(f,{node:true}),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json(options.method==='POST'?{error:'文件无法保存'}:{files:[],maxFileBytes:2},{status:options.method==='POST'?503:200});});
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['big'],'too-big.txt')];input.dispatch('change');await tick();
  assert.match(view.element('[data-file-status]').textContent,/超过/);assert.equal(calls.length,1);
  input.files=[new File(['a'],'valid.txt')];input.dispatch('change');await tick();b.choose(f.task.milestoneId);await tick();await tick();
  assert.match(view.element('[data-file-status]').textContent,/文件无法保存/);
});

test('late file responses after logout cannot restore the previous account file list',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const f=fixture(),view=mounted(f);let resolve;
  const pending=new Promise(done=>resolve=done);
  t.mock.method(globalThis,'fetch',()=>pending);
  bindProjectFiles(view.root,view.context);view.changeIdentity();
  resolve(Response.json({files:[f.file]}));await tick();
  assert.equal(view.element('[data-file-list]').innerHTML,'');
});

test('direct node file drops stop canvas navigation and post the target association',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const b=browser(t),f=fixture(),node=new Element({fileProject:f.project.id,fileType:'task',fileId:f.task.id}),root=new Element(),calls=[];
  root.querySelectorAll=selector=>selector==='[data-node-file-drop]'?[node]:[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json({file:f.file});});
  bindProjectFiles(root,{getState:()=>f.state,getActorId:()=> 'u-engineer'});
  let prevented=false,stopped=false;
  node.dispatch('drop',node,{dataTransfer:{types:['Files'],files:[new File(['drop'],'drop.txt')]},preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});await tick();await tick();
  assert.ok(prevented&&stopped);assert.equal(calls.length,0);assert.ok(b.dialog);b.choose(f.task.milestoneId);await tick();await tick();assert.equal(calls.length,1);assert.equal(calls[0].options.body.get('entityId'),f.task.id);
});


test('active file uploads suspend polling renders until their requests and refresh finish',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const b=browser(t),f=fixture(),view=mounted(f,{node:true});let completeUpload;
  t.mock.method(globalThis,'fetch',async(path,options)=>options.method==='POST'?new Promise(resolve=>{completeUpload=resolve;}):Response.json({files:[],maxFileBytes:20*1024*1024}));
  assert.equal(hasActiveFileOperations(),false);
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['content'],'pending.txt')];input.dispatch('change');
  assert.equal(hasActiveFileOperations(),true);
  b.choose(f.task.milestoneId);await tick();
  completeUpload(Response.json({file:f.file}));await tick();await tick();
  assert.equal(hasActiveFileOperations(),false);
});


test('project uploads require an explicit major-node choice, allow cancellation, and never post on a blank choice',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const b=browser(t),f=fixture(),view=mounted(f),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json(options.method==='POST'?{file:f.file}:{files:[],maxFileBytes:20*1024*1024});});
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['file content'],'selected.txt')];input.dispatch('change');await tick();
  assert.ok(b.dialog.open);assert.match(b.dialog.innerHTML,/已选择 1 个文件/);assert.match(b.dialog.innerHTML,/data-file-target-select required/);assert.equal(b.dialog.querySelector('[data-file-target-select]').value,'');
  b.choose('');await tick();assert.match(b.dialog.querySelector('[data-file-target-error]').textContent,/请选择/);assert.equal(calls.length,1);
  b.cancel();await tick();assert.equal(b.dialog,undefined);assert.equal(calls.length,1);assert.equal(hasActiveFileOperations(),false);
  input.dispatch('change');await tick();b.choose(f.task.milestoneId);await tick();await tick();
  const posted=calls.find(call=>call.options.method==='POST');assert.equal(posted.options.body.get('entityType'),'milestone');assert.equal(posted.options.body.get('entityId'),f.task.milestoneId);
});

test('task uploads can select another major node explicitly without misfiling under the original task',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const b=browser(t),f=fixture(),view=mounted(f,{node:true}),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json(options.method==='POST'?{file:f.file}:{files:[]});});
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['a'],'move.txt')];input.dispatch('change');await tick();
  const other=f.state.milestones.find(node=>node.projectId===f.project.id&&node.id!==f.task.milestoneId);b.choose(other.id);await tick();await tick();
  const post=calls.find(call=>call.options.method==='POST');assert.equal(post.options.body.get('entityType'),'milestone');assert.equal(post.options.body.get('entityId'),other.id);
});

test('major-node groups include direct files and child-task files, retain orphans, and exclude other projects',()=>{
  const f=fixture(),milestone=f.state.milestones.find(node=>node.id===f.task.milestoneId);
  const direct={...f.file,id:'direct',entityType:'milestone',entityId:milestone.id,name:'大节点资料.docx'};
  const orphan={...f.file,id:'old',entityId:'removed-task',name:'历史文件.txt'};
  const external={...f.file,id:'secret',projectId:'p-site',name:'别的项目机密.txt'};
  const html=renderFileGroups([f.file,direct,orphan,external],f.state,f.project.id);
  const group=html.split(`data-file-milestone="${milestone.id}">`)[1].split('</section>')[0];
  assert.match(group,/2 个文件/);assert.match(group,/测试报告.pdf/);assert.match(group,/大节点资料.docx/);assert.match(html,/原未归属节点/);assert.match(html,/历史文件.txt/);assert.doesNotMatch(html,/别的项目机密/);
  assert.equal((html.match(/data-file-milestone=/g)||[]).length,f.state.milestones.filter(node=>node.projectId===f.project.id).length+1);
  assert.match(renderFileGroups([f.file,direct],f.state,f.project.id,{query:'大节点资料'}),/1 \/ 2 个文件/);
});

test('major-node detail fetches its child-task files and filters out mismatched server results',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const f=fixture(),view=mounted(f,{node:true}),calls=[];
  view.host.dataset.entityType='milestone';view.host.dataset.entityId=f.task.milestoneId;
  const direct={...f.file,id:'direct',entityType:'milestone',entityId:f.task.milestoneId,name:'阶段附件.pdf'};
  const unrelated={...f.file,id:'elsewhere',entityId:f.state.tasks.find(task=>task.projectId!==f.project.id).id,name:'不属于该节点.txt'};
  t.mock.method(globalThis,'fetch',async path=>{calls.push(path);return Response.json({files:[f.file,direct,unrelated]});});
  bindProjectFiles(view.root,view.context);await tick();
  assert.match(calls[0],/includeTaskFiles=true/);assert.match(view.element('[data-file-list]').innerHTML,/测试报告/);assert.match(view.element('[data-file-list]').innerHTML,/阶段附件/);assert.doesNotMatch(view.element('[data-file-list]').innerHTML,/不属于该节点/);assert.equal(view.element('[data-file-total]').textContent,'2 个文件');
});

test('logout, removed project access and navigation cancel a pending choice without uploading',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const b=browser(t),f=fixture(),view=mounted(f),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json({files:[]});});
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['a'],'private.txt')];input.dispatch('change');await tick();
  f.project.memberIds=f.project.memberIds.filter(id=>id!=='u-engineer');b.choose(f.task.milestoneId);await tick();assert.equal(b.dialog,undefined);assert.equal(calls.length,1);
  f.project.memberIds.push('u-engineer');input.dispatch('change');await tick();b.events.get('hashchange')();await tick();assert.equal(b.dialog,undefined);assert.equal(calls.length,1);
  input.dispatch('change');await tick();view.changeIdentity();await tick();assert.equal(b.dialog,undefined);assert.equal(hasActiveFileOperations(),false);assert.equal(calls.length,1);
});
