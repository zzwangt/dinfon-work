import { formatDateTime } from './time.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const DEFAULT_LIMIT = 20 * 1024 * 1024;
const hosts = new Map();
const uploads = new Set();
const selections = new Set();
let generation = 0, selectionId = 0;
const uploadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg>';
const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 14h8M8 17h5"/></svg>';
export const formatFileSize = size => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const projectMilestones = (state, projectId) => (state?.milestones || []).filter(node => node.projectId === projectId);
const picker = () => `<button type="button" class="button secondary" data-file-pick>${uploadIcon}选择文件</button><input type="file" multiple class="sr-only" tabindex="-1" data-file-input aria-label="选择要上传的文件"><p class="file-upload-hint">选择文件后指定大节点，每个文件不超过 20 MB。</p>`;

export function renderProjectFiles(state, project) {
  const milestones = projectMilestones(state, project.id);
  return `<section class="project-files" data-project-files data-project-id="${escape(project.id)}" aria-label="${escape(project.name)}的文件管理中心"><div class="file-center-heading"><div><h2>文件管理中心</h2><p>${escape(project.name)} · <span data-file-total>正在加载</span></p></div><button type="button" class="button ghost small" data-file-refresh>刷新文件</button></div><div class="file-center-tools"><label class="file-search"><span class="sr-only">搜索项目文件</span><input type="search" data-file-search placeholder="搜索文件名、上传人…" autocomplete="off"></label></div><div class="file-dropzone" data-file-drop><span class="file-upload-symbol">${uploadIcon}</span><div><strong data-file-target-label>${milestones.length?'拖入或选择文件':'项目添加大节点后即可上传文件'}</strong>${picker()}</div></div><p class="file-operation-status" data-file-status role="status" aria-live="polite"></p><div data-file-list aria-live="polite"><p class="file-empty">正在加载项目文件…</p></div></section>`;
}

export function renderNodeFiles(projectId, entityType, entityId) {
  return `<section class="node-files" data-project-files data-project-id="${escape(projectId)}" data-entity-type="${escape(entityType)}" data-entity-id="${escape(entityId)}" aria-label="节点文件"><div class="file-center-heading"><h4>文件 <span class="file-node-count" data-file-total></span></h4><button type="button" class="button ghost small" data-file-refresh>刷新</button></div><div class="file-dropzone" data-file-drop>${picker()}</div><p class="file-operation-status" data-file-status role="status" aria-live="polite"></p><div data-file-list aria-live="polite"><p class="file-empty">正在加载文件…</p></div></section>`;
}

export function renderFileRows(files, state, { query = '', node = '', compact = false } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  const matching = files.filter(file => {
    const uploader = file.uploaderName || state.users.find(user => user.id === file.uploadedBy)?.name || '已移除成员';
    return (!node || `${file.entityType}:${file.entityId}` === node) && (!needle || `${file.name} ${uploader}`.toLocaleLowerCase().includes(needle));
  });
  if (!matching.length) return `<div class="file-empty">${files.length?'没有符合条件的文件':'暂无文件，上传后会显示在这里。'}</div>`;
  return `<div class="project-file-list">${matching.map(file => {
    const entity = (file.entityType === 'task' ? state.tasks : state.milestones).find(item => item.id === file.entityId && item.projectId === file.projectId);
    const uploader = file.uploaderName || state.users.find(user => user.id === file.uploadedBy)?.name || '已移除成员';
    return `<article class="project-file-row"><span class="project-file-symbol">${fileIcon}</span><div class="project-file-description"><a class="project-file-name" href="/api/files/${encodeURIComponent(file.id)}/download" download="${escape(file.name)}">${escape(file.name)}</a>${!compact?`<span class="project-file-node">${file.entityType==='task'?'任务':'大节点'} · ${escape(entity?.title || '原节点')}</span>`:''}<span class="project-file-meta">${escape(formatFileSize(file.size))} · ${escape(uploader)} · ${escape(formatDateTime(file.uploadedAt))}</span></div><div class="project-file-actions"><a class="button ghost small" href="/api/files/${encodeURIComponent(file.id)}/download" download="${escape(file.name)}" aria-label="下载 ${escape(file.name)}">下载</a>${file.canDelete?`<button type="button" class="button ghost small file-delete" data-file-delete="${escape(file.id)}" aria-label="删除 ${escape(file.name)}">删除</button>`:''}</div></article>`;
  }).join('')}</div>`;
}

const uploaderName = (file, state) => file.uploaderName || state.users.find(user => user.id === file.uploadedBy)?.name || '已移除成员';
const matchesFile = (file, state, query) => !query || `${file.name} ${uploaderName(file,state)}`.toLocaleLowerCase().includes(query);
const fileMilestone = (file, state) => {
  const id = file.entityType === 'milestone' ? file.entityId : state.tasks.find(task => task.id === file.entityId && task.projectId === file.projectId)?.milestoneId;
  return state.milestones.find(node => node.id === id && node.projectId === file.projectId);
};
export function renderFileGroups(files, state, projectId, {query = ''} = {}) {
  const scoped = files.filter(file => file.projectId === projectId), needle = query.trim().toLocaleLowerCase();
  const groups = projectMilestones(state,projectId).map(node => ({id:node.id,title:node.title,files:scoped.filter(file => fileMilestone(file,state)?.id === node.id)}));
  const orphaned = scoped.filter(file => !fileMilestone(file,state));
  if(orphaned.length) groups.push({id:'',title:'原未归属节点',files:orphaned});
  const visible = groups.map(group => ({...group,matching:group.files.filter(file => matchesFile(file,state,needle))})).filter(group => !needle || group.matching.length);
  if(!visible.length) return `<div class="file-empty">${needle?'没有符合条件的文件':'项目添加大节点后，文件会按大节点显示。'}</div>`;
  return `<div class="project-file-groups">${visible.map(group => `<section class="project-file-group" data-file-milestone="${escape(group.id)}"><div class="file-group-heading"><h3>${escape(group.title)}</h3><span>${needle?`${group.matching.length} / ${group.files.length}`:group.files.length} 个文件</span></div>${group.matching.length?renderFileRows(group.matching,state):'<p class="file-group-empty">暂无文件</p>'}</section>`).join('')}</div>`;
}

export function hasActiveFileOperations() {
  return selections.size > 0 || uploads.size > 0 || [...hosts.values()].some(record => record.busy);
}

export function resetProjectFiles() {
  generation += 1;
  for (const selection of [...selections]) selection.cancel();
  for (const record of hosts.values()) record.abort.abort();
  for (const controller of uploads) controller.abort();
  uploads.clear();
  hosts.clear();
}
const accessible = (context, projectId) => {
  const state = context.getState();
  const actorId = context.getActorId();
  const actor = state?.users.find(user => user.id === actorId);
  const project = state?.projects.find(project => project.id === projectId);
  return Boolean(project && actor && (actor.role === 'admin' || project.ownerId === actorId || project.memberIds.includes(actorId)));
};
async function request(path, options = {}) {
  const response = await fetch(path, { credentials:'same-origin', cache:'no-store', ...options });
  const data = await response.json().catch(() => ({ error:'文件服务暂时不可用，请重试。' }));
  if (!response.ok) { const error = new Error(data.error || '操作未成功，请重试。'); error.status = response.status; throw error; }
  return data;
}
const targetExists = (context, target) => {
  if (!accessible(context, target.projectId)) return false;
  const state = context.getState();
  return (target.entityType==='task'?state.tasks:target.entityType==='milestone'?state.milestones:[]).some(node => node.id===target.entityId && node.projectId===target.projectId);
};
const hostTarget = host => ({projectId:host.dataset.projectId,entityType:host.dataset.entityType || '',entityId:host.dataset.entityId || ''});
const canChooseTarget = (context, origin) => accessible(context,origin.projectId) && projectMilestones(context.getState(),origin.projectId).length > 0 && (!origin.entityId || targetExists(context,origin));
const belongsToHost = (file, host, state) => file.projectId === host.dataset.projectId && (!host.dataset.entityId || (host.dataset.entityType==='milestone' ? fileMilestone(file,state)?.id === host.dataset.entityId : file.entityType==='task'&&file.entityId===host.dataset.entityId));
function validateFiles(files, max) {
  for(const file of files){if(file.size>max)throw new Error(`“${file.name}”超过 ${formatFileSize(max)}。`);if(!file.size)throw new Error(`“${file.name}”是空文件，请重新选择。`);}
}
function chooseMilestone(files, origin, context, {signal, isPresent = () => true} = {}) {
  const epoch=generation, actor=context.getActorId();
  const valid=()=>!signal?.aborted&&epoch===generation&&context.getActorId()===actor&&isPresent()&&canChooseTarget(context,origin);
  if(!valid())return Promise.resolve(null);
  for(const selection of [...selections])selection.cancel();
  return new Promise(resolve => {
    const dialog=document.createElement('dialog'),id=`file-target-${++selectionId}`,previousFocus=document.activeElement;
    const milestones=projectMilestones(context.getState(),origin.projectId);
    dialog.className='file-target-dialog';dialog.setAttribute('aria-labelledby',`${id}-title`);
    dialog.innerHTML=`<form data-file-target-form><h2 id="${id}-title">选择所属大节点</h2><p class="file-target-summary">已选择 ${files.length} 个文件</p><ul class="file-target-names">${files.slice(0,5).map(file=>`<li>${escape(file.name)}</li>`).join('')}${files.length>5?`<li>另有 ${files.length-5} 个文件</li>`:''}</ul><label for="${id}-select">所属大节点</label><select id="${id}-select" data-file-target-select required><option value="">请选择大节点</option>${milestones.map(node=>`<option value="${escape(node.id)}">${escape(node.title)}</option>`).join('')}</select><p class="file-target-note" data-file-target-note>确认后开始上传，文件会归入所选大节点。</p><p class="file-target-error" data-file-target-error role="alert" hidden></p><div class="file-target-actions"><button type="button" class="button secondary" data-file-target-cancel>取消上传</button><button type="submit" class="button primary">确认并上传</button></div></form>`;
    const select=dialog.querySelector('[data-file-target-select]'),error=dialog.querySelector('[data-file-target-error]');
    let settled=false,timer;
    const selection={valid,cancel:()=>finish(null)};
    const finish=target=>{if(settled)return;settled=true;clearInterval(timer);signal?.removeEventListener('abort',selection.cancel);window.removeEventListener('hashchange',selection.cancel);selections.delete(selection);if(dialog.open)dialog.close();dialog.remove();if(previousFocus?.isConnected)previousFocus.focus?.();resolve(target);};
    const chosenTarget=()=>{
      const node=projectMilestones(context.getState(),origin.projectId).find(item=>item.id===select.value);
      if(!node)return null;
      const task=origin.entityType==='task'&&context.getState().tasks.find(item=>item.id===origin.entityId&&item.projectId===origin.projectId);
      return task?.milestoneId===node.id ? {...origin} : {projectId:origin.projectId,entityType:'milestone',entityId:node.id};
    };
    select.addEventListener('change',()=>{
      const target=valid()&&chosenTarget(),task=target?.entityType==='task'&&context.getState().tasks.find(item=>item.id===target.entityId);
      dialog.querySelector('[data-file-target-note]').textContent=task?`文件归入所选大节点，并保留在任务“${task.title}”中。`:'确认后开始上传，文件会归入所选大节点。';
      error.hidden=true;
    });
    dialog.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();if(!valid()){finish(null);return;}const target=chosenTarget();if(!target){error.hidden=false;error.textContent='请选择一个有效的大节点。';select.focus();return;}finish(target);});
    dialog.addEventListener('click',event=>{if(event.target.closest('[data-file-target-cancel]'))finish(null);});
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
    dialog.addEventListener('close',()=>finish(null));
    selections.add(selection);signal?.addEventListener('abort',selection.cancel,{once:true});window.addEventListener('hashchange',selection.cancel);
    document.body.append(dialog);dialog.showModal();select.focus();
    timer=setInterval(()=>{if(!valid())finish(null);},250);timer.unref?.();
  });
}
const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');

/** File requests are view-local; changing accounts invalidates every pending response. */
export function bindProjectFiles(container, context) {
  for (const selection of [...selections]) if (!selection.valid()) selection.cancel();
  for (const [host, record] of hosts) if (!host.isConnected) { record.abort.abort(); hosts.delete(host); }
  const panels = container.matches?.('[data-project-files]') ? [container] : (container.querySelectorAll?.('[data-project-files]') || []);
  for (const host of panels) {
    if (hosts.has(host)) continue;
    const epoch = generation, actor = context.getActorId(), abort = new AbortController();
    const record = {abort,files:[],busy:false,maxFileBytes:DEFAULT_LIMIT,load:null,loadId:0};
    hosts.set(host, record);
    const valid = () => host.isConnected && epoch === generation && context.getActorId() === actor && accessible(context, host.dataset.projectId);
    const status = (text, error=false) => { if(!valid())return;const area=host.querySelector('[data-file-status]');area.textContent=text;area.classList.toggle('is-error',error); };
    const updatePicker = () => {
      const canUpload = canChooseTarget(context,hostTarget(host));
      host.querySelector('[data-file-pick]').disabled = record.busy || !canUpload;
      host.querySelector('[data-file-input]').disabled = record.busy || !canUpload;
      host.querySelector('[data-file-drop]').classList.toggle('is-disabled',!canUpload);
      const label=host.querySelector('[data-file-target-label]');
      if(label)label.textContent=canUpload?'拖入或选择文件':'项目添加大节点后即可上传文件';
    };
    const draw = () => {
      if(!valid())return;
      host.querySelector('[data-file-list]').innerHTML=host.dataset.entityId?renderFileRows(record.files,context.getState(),{compact:host.dataset.entityType==='task'}):renderFileGroups(record.files,context.getState(),host.dataset.projectId,{query:host.querySelector('[data-file-search]')?.value||''});
      const total=host.querySelector('[data-file-total]');if(total)total.textContent=`${record.files.length} 个文件`;
      updatePicker();
    };
    record.load = async () => {
      if(!valid())return;
      const loadId=++record.loadId;
      const refresh=host.querySelector('[data-file-refresh]');refresh.disabled=true;
      const query=new URLSearchParams({projectId:host.dataset.projectId});
      if(host.dataset.entityId){query.set('entityType',host.dataset.entityType);query.set('entityId',host.dataset.entityId);if(host.dataset.entityType==='milestone')query.set('includeTaskFiles','true');}
      try {const data=await request(`/api/files?${query}`,{signal:abort.signal});if(!valid()||loadId!==record.loadId)return;record.files=(data.files||[]).filter(file=>belongsToHost(file,host,context.getState()));record.maxFileBytes=data.maxFileBytes||DEFAULT_LIMIT;draw();}
      catch(error){if(error.name==='AbortError'||!valid()||loadId!==record.loadId)return;record.files=[];draw();status(error.message,true);if([401,403].includes(error.status))context.onUnauthorized?.();}
      finally{if(valid()&&loadId===record.loadId)refresh.disabled=false;}
    };
    const upload = async files => {
      if(!files.length||!valid()||record.busy)return;
      const origin=hostTarget(host);
      if(!canChooseTarget(context,origin)){status('项目添加大节点后即可上传文件。',true);return;}
      record.busy=true;updatePicker();
      try{
        validateFiles(files,record.maxFileBytes);
        const target=await chooseMilestone(files,origin,context,{signal:abort.signal,isPresent:()=>host.isConnected});
        if(!target){if(valid())status('已取消上传。');return;}
        if(!valid())return;
        await uploadFiles(files,target,context,{signal:abort.signal,max:record.maxFileBytes,onProgress:message=>status(message)});
      }
      catch(error){if(error.name!=='AbortError'&&valid())status(error.message,true);}
      finally{record.busy=false;if(valid())updatePicker();}
    };
    host.addEventListener('click',async event=>{
      const pick=event.target.closest('[data-file-pick]');if(pick){host.querySelector('[data-file-input]').click();return;}
      if(event.target.closest('[data-file-refresh]')){status('');return record.load();}
      const deletion=event.target.closest('[data-file-delete]');if(!deletion||record.busy||!valid())return;
      const file=record.files.find(file=>file.id===deletion.dataset.fileDelete);if(!file?.canDelete)return;
      if(!window.confirm(`删除文件“${file.name}”？此操作不能撤销。`))return;
      deletion.disabled=true;
      try{await request(`/api/files/${encodeURIComponent(file.id)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:'{}',signal:abort.signal});if(valid()){status('文件已删除。');await refreshProjectFiles(file.projectId);}}
      catch(error){if(valid()&&error.name!=='AbortError'){status(error.message,true);deletion.disabled=false;}}
    });
    host.querySelector('[data-file-input]').addEventListener('change',event=>{const files=Array.from(event.target.files||[]);event.target.value='';void upload(files);});
    host.querySelector('[data-file-search]')?.addEventListener('input',draw);
    const drop=host.querySelector('[data-file-drop]');
    bindDrop(drop,files=>void upload(files));
    updatePicker();void record.load();
  }
  for (const node of (container.querySelectorAll?.('[data-node-file-drop]') || [])) {
    if(node.dataset.fileDropBound)continue;node.dataset.fileDropBound='true';
    bindDrop(node, async files => {
      if(node.dataset.fileUploading)return;
      const origin={projectId:node.dataset.fileProject,entityType:node.dataset.fileType,entityId:node.dataset.fileId};
      if(!files.length||!canChooseTarget(context,origin))return;
      node.dataset.fileUploading='true';
      try{
        validateFiles(files,DEFAULT_LIMIT);
        const target=await chooseMilestone(files,origin,context,{isPresent:()=>node.isConnected});
        if(!target)return;
        node.classList.add('is-file-uploading');
        await uploadFiles(files,target,context,{onProgress:message=>context.notify?.(message)});
      }
      catch(error){if(error.name!=='AbortError')context.notify?.(error.message,true);}
      finally{delete node.dataset.fileUploading;node.classList.remove('is-file-uploading');}
    });
  }
}
function bindDrop(node, upload) {
  node.addEventListener('dragover',event=>{if(!hasFiles(event))return;event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='copy';node.classList.add('is-file-dragover');});
  node.addEventListener('dragleave',event=>{if(!node.contains(event.relatedTarget))node.classList.remove('is-file-dragover');});
  node.addEventListener('drop',event=>{if(!hasFiles(event))return;event.preventDefault();event.stopPropagation();node.classList.remove('is-file-dragover');void upload(Array.from(event.dataTransfer.files||[]));});
}
async function refreshProjectFiles(projectId) {
  await Promise.all([...hosts].filter(([host])=>host.isConnected&&host.dataset.projectId===projectId).map(([,record])=>record.load()));
}
async function uploadFiles(files, target, context, { signal, max=DEFAULT_LIMIT, onProgress } = {}) {
  if(!files.length)return;
  const epoch=generation, actor=context.getActorId(), abort=new AbortController();
  uploads.add(abort);
  const cancel=()=>abort.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)abort.abort();
  const valid=()=>!abort.signal.aborted&&epoch===generation&&context.getActorId()===actor&&targetExists(context,target);
  let completed=0;
  try {
    for(const file of files){
      if(!valid())throw new DOMException('请求已取消','AbortError');
      if(file.size>max)throw new Error(`“${file.name}”超过 ${formatFileSize(max)}。${completed?`已上传 ${completed} 个文件。`:''}`);
      onProgress?.(`正在上传 ${completed+1} / ${files.length}：${file.name}`);
      const data=new FormData();data.set('file',file);data.set('projectId',target.projectId);data.set('entityType',target.entityType);data.set('entityId',target.entityId);
      try{await request('/api/files',{method:'POST',body:data,signal:abort.signal});}
      catch(error){if(valid()&&[401,403].includes(error.status))context.onUnauthorized?.();if(completed&&error.name!=='AbortError')error.message+=` 已上传 ${completed} 个文件，其余尚未上传。`;throw error;}
      if(!valid())throw new DOMException('请求已取消','AbortError');
      completed+=1;
    }
    if(valid())onProgress?.(`已上传 ${completed} 个文件。`);
  } finally {
    if(completed&&valid())await refreshProjectFiles(target.projectId);
    signal?.removeEventListener('abort',cancel);uploads.delete(abort);
  }
}
