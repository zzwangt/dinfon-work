import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeedState } from '../public/client/domain.js';
import { renderProjectFlow } from '../public/client/flow.js';
import { renderProjectFiles, renderNodeFiles, renderFileRows, bindProjectFiles, resetProjectFiles, hasActiveFileOperations } from '../public/client/files.js';

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
  dispatch(name,target=this,extra={}){return this.listeners.get(name)?.({target,preventDefault(){},stopPropagation(){},...extra});}
}
function mounted(f=fixture(),{node=false}={}) {
  const host=new Element({projectId:f.project.id,...(node?{entityType:'task',entityId:f.task.id}:{})});
  host.elements=Object.fromEntries(['[data-file-status]','[data-file-pick]','[data-file-input]','[data-file-drop]','[data-file-list]','[data-file-refresh]','[data-file-total]'].map(key=>[key,new Element()]));
  if(!node){host.elements['[data-file-search]']=new Element();host.elements['[data-file-node]']=new Element();host.elements['[data-file-node]'].options=[{textContent:'全部节点与任务'},{textContent:`任务 · ${f.task.title}`}];host.elements['[data-file-node]'].selectedIndex=0;}
  const root=new Element();root.querySelectorAll=selector=>selector==='[data-project-files]'?[host]:[];
  let state=f.state,actorId='u-engineer';
  const context={getState:()=>state,getActorId:()=>actorId};
  return {host,root,context,changeIdentity(){state=null;actorId='';resetProjectFiles();},element:selector=>host.elements[selector]};
}

test('file center follows 我的任务 and opens project-only files without a flow canvas',()=>{
  const f=fixture();
  const flow=renderProjectFlow(f.state,f.project,{actorId:'u-engineer'});
  assert.match(flow,/data-id="mine"[^>]*>我的任务<\/button><button[^>]*data-id="files"[^>]*>文件管理中心/);
  const files=renderProjectFlow(f.state,f.project,{actorId:'u-engineer',scope:'files'});
  assert.match(files,/data-id="files" aria-pressed="true"/);
  assert.match(files,/data-project-files data-project-id="p-mower"/);
  assert.doesNotMatch(files,/data-flow-canvas/);
  assert.match(files,/<option value="">全部节点与任务<\/option>/);
  for(const task of f.state.tasks.filter(item=>item.projectId!==f.project.id))assert.ok(!files.includes(`value="task:${task.id}"`));
});

test('files remain reachable before a project has any nodes',()=>{
  const f=fixture();f.state.milestones=[];f.state.tasks=[];
  const flow=renderProjectFlow(f.state,f.project);
  assert.match(flow,/文件管理中心/);
  assert.match(renderProjectFiles(f.state,f.project),/项目添加节点后即可上传文件/);
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
  assert.equal(view.element('[data-file-pick]').disabled,true,'project uploads require choosing a target');
  view.element('[data-file-search]').value='无匹配';view.element('[data-file-search]').dispatch('input');
  assert.match(view.element('[data-file-list]').innerHTML,/没有符合条件/);assert.equal(calls.length,1);
});

test('node upload sends multipart association, preserves bytes, and refreshes its file list',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const f=fixture(),view=mounted(f,{node:true}),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json(options.method==='POST'?{file:f.file}:{files:[],maxFileBytes:20*1024*1024});});
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['known-content'],'hello.txt',{type:'text/plain'})];input.dispatch('change');await tick();await tick();
  const upload=calls.find(call=>call.options.method==='POST');assert.ok(upload);
  assert.ok(upload.options.body instanceof FormData);assert.equal(upload.options.headers,undefined,'browser sets multipart boundary');
  assert.equal(upload.options.body.get('entityId'),f.task.id);assert.equal(upload.options.body.get('entityType'),'task');assert.equal(upload.options.body.get('projectId'),f.project.id);
  assert.equal(await upload.options.body.get('file').text(),'known-content');
  assert.equal(calls.filter(call=>!call.options.method).length,2);
  assert.match(view.element('[data-file-status]').textContent,/已上传 1 个文件/);
});

test('oversize files are rejected before upload and failed requests show server errors',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const f=fixture(),view=mounted(f,{node:true}),calls=[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json(options.method==='POST'?{error:'文件无法保存'}:{files:[],maxFileBytes:2},{status:options.method==='POST'?503:200});});
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['big'],'too-big.txt')];input.dispatch('change');await tick();
  assert.match(view.element('[data-file-status]').textContent,/超过/);assert.equal(calls.length,1);
  input.files=[new File(['a'],'valid.txt')];input.dispatch('change');await tick();await tick();
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
  const f=fixture(),node=new Element({fileProject:f.project.id,fileType:'task',fileId:f.task.id}),root=new Element(),calls=[];
  root.querySelectorAll=selector=>selector==='[data-node-file-drop]'?[node]:[];
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});return Response.json({file:f.file});});
  bindProjectFiles(root,{getState:()=>f.state,getActorId:()=> 'u-engineer'});
  let prevented=false,stopped=false;
  node.dispatch('drop',node,{dataTransfer:{types:['Files'],files:[new File(['drop'],'drop.txt')]},preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});await tick();await tick();
  assert.ok(prevented&&stopped);assert.equal(calls.length,1);assert.equal(calls[0].options.body.get('entityId'),f.task.id);
});


test('active file uploads suspend polling renders until their requests and refresh finish',async t=>{
  resetProjectFiles();t.after(resetProjectFiles);
  const f=fixture(),view=mounted(f,{node:true});let completeUpload;
  t.mock.method(globalThis,'fetch',async(path,options)=>options.method==='POST'?new Promise(resolve=>{completeUpload=resolve;}):Response.json({files:[],maxFileBytes:20*1024*1024}));
  assert.equal(hasActiveFileOperations(),false);
  bindProjectFiles(view.root,view.context);await tick();
  const input=view.element('[data-file-input]');input.files=[new File(['content'],'pending.txt')];input.dispatch('change');
  assert.equal(hasActiveFileOperations(),true);
  completeUpload(Response.json({file:f.file}));await tick();await tick();
  assert.equal(hasActiveFileOperations(),false);
});
