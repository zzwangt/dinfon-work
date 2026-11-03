import { formatDateTime } from './time.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
const DEFAULT_LIMIT = 20 * 1024 * 1024;
const hosts = new Map();
const uploads = new Set();
let generation = 0;
const uploadIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg>';
const fileIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 14h8M8 17h5"/></svg>';
export const formatFileSize = size => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const nodeOptions = (state, projectId) => [
  ...state.milestones.filter(node => node.projectId === projectId).map(node => ({ type:'milestone', id:node.id, title:`大节点 · ${node.title}` })),
  ...state.tasks.filter(node => node.projectId === projectId).map(node => ({ type:'task', id:node.id, title:`任务 · ${node.title}` })),
];
const picker = () => `<button type="button" class="button secondary" data-file-pick>${uploadIcon}选择文件</button><input type="file" multiple class="sr-only" tabindex="-1" data-file-input aria-label="选择要上传的文件"><p class="file-upload-hint">拖入文件或点击选择，每个文件不超过 20 MB。</p>`;

export function renderProjectFiles(state, project) {
  const nodes = nodeOptions(state, project.id);
  return `<section class="project-files" data-project-files data-project-id="${escape(project.id)}" aria-label="${escape(project.name)}的文件管理中心"><div class="file-center-heading"><div><h2>文件管理中心</h2><p>${escape(project.name)} · <span data-file-total>正在加载</span></p></div><button type="button" class="button ghost small" data-file-refresh>刷新文件</button></div><div class="file-center-tools"><label class="file-search"><span class="sr-only">搜索项目文件</span><input type="search" data-file-search placeholder="搜索文件名、上传人…" autocomplete="off"></label><label class="file-node-filter"><span class="sr-only">筛选所属节点</span><select data-file-node><option value="">全部节点与任务</option>${nodes.map(node=>`<option value="${escape(`${node.type}:${node.id}`)}">${escape(node.title)}</option>`).join('')}</select></label></div><div class="file-dropzone" data-file-drop><span class="file-upload-symbol">${uploadIcon}</span><div><strong data-file-target-label>${nodes.length?'选择所属节点后上传文件':'项目添加节点后即可上传文件'}</strong>${picker()}</div></div><p class="file-operation-status" data-file-status role="status" aria-live="polite"></p><div data-file-list aria-live="polite"><p class="file-empty">正在加载项目文件…</p></div></section>`;
}

export function renderNodeFiles(projectId, entityType, entityId) {
  return `<section class="node-files" data-project-files data-project-id="${escape(projectId)}" data-entity-type="${escape(entityType)}" data-entity-id="${escape(entityId)}" aria-label="节点文件"><div class="file-center-heading"><h4>文件</h4><button type="button" class="button ghost small" data-file-refresh>刷新</button></div><div class="file-dropzone" data-file-drop>${picker()}</div><p class="file-operation-status" data-file-status role="status" aria-live="polite"></p><div data-file-list aria-live="polite"><p class="file-empty">正在加载文件…</p></div></section>`;
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

export function hasActiveFileOperations() {
  return uploads.size > 0 || [...hosts.values()].some(record => record.busy);
}

export function resetProjectFiles() {
  generation += 1;
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
const selectedTarget = host => {
  const choice = host.querySelector('[data-file-node]')?.value;
  const separator = choice?.indexOf(':');
  return {projectId:host.dataset.projectId,entityType:host.dataset.entityType || (separator>0?choice.slice(0,separator):''),entityId:host.dataset.entityId || (separator>0?choice.slice(separator+1):'')};
};
const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');

/** File requests are view-local; changing accounts invalidates every pending response. */
export function bindProjectFiles(container, context) {
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
      const target = selectedTarget(host), canUpload = targetExists(context,target);
      host.querySelector('[data-file-pick]').disabled = record.busy || !canUpload;
      host.querySelector('[data-file-input]').disabled = record.busy || !canUpload;
      host.querySelector('[data-file-drop]').classList.toggle('is-disabled',!canUpload);
      const label=host.querySelector('[data-file-target-label]');
      if(label){const selected=host.querySelector('[data-file-node]');label.textContent=canUpload?`上传到 ${selected.options[selected.selectedIndex].textContent}`:'选择所属节点后上传文件';}
    };
    const draw = () => {
      if(!valid())return;
      host.querySelector('[data-file-list]').innerHTML=renderFileRows(record.files,context.getState(),{query:host.querySelector('[data-file-search]')?.value||'',node:host.querySelector('[data-file-node]')?.value||'',compact:!!host.dataset.entityId});
      const total=host.querySelector('[data-file-total]');if(total)total.textContent=`${record.files.length} 个文件`;
      updatePicker();
    };
    record.load = async () => {
      if(!valid())return;
      const loadId=++record.loadId;
      const refresh=host.querySelector('[data-file-refresh]');refresh.disabled=true;
      const query=new URLSearchParams({projectId:host.dataset.projectId});
      if(host.dataset.entityId){query.set('entityType',host.dataset.entityType);query.set('entityId',host.dataset.entityId);}
      try {const data=await request(`/api/files?${query}`,{signal:abort.signal});if(!valid()||loadId!==record.loadId)return;record.files=(data.files||[]).filter(file=>file.projectId===host.dataset.projectId&&(!host.dataset.entityId||(file.entityType===host.dataset.entityType&&file.entityId===host.dataset.entityId)));record.maxFileBytes=data.maxFileBytes||DEFAULT_LIMIT;draw();}
      catch(error){if(error.name==='AbortError'||!valid()||loadId!==record.loadId)return;record.files=[];draw();status(error.message,true);if([401,403].includes(error.status))context.onUnauthorized?.();}
      finally{if(valid()&&loadId===record.loadId)refresh.disabled=false;}
    };
    const upload = async files => {
      const target=selectedTarget(host);if(!valid()||record.busy)return;
      if(!targetExists(context,target)){status('请先选择文件所属的大节点或任务。',true);return;}
      record.busy=true;updatePicker();
      try{await uploadFiles(files,target,context,{signal:abort.signal,max:record.maxFileBytes,onProgress:message=>status(message)});}
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
    host.querySelector('[data-file-node]')?.addEventListener('change',()=>{status('');draw();});
    const drop=host.querySelector('[data-file-drop]');
    bindDrop(drop,files=>void upload(files));
    updatePicker();void record.load();
  }
  for (const node of (container.querySelectorAll?.('[data-node-file-drop]') || [])) {
    if(node.dataset.fileDropBound)continue;node.dataset.fileDropBound='true';
    bindDrop(node, async files => {
      if(node.dataset.fileUploading)return;
      const target={projectId:node.dataset.fileProject,entityType:node.dataset.fileType,entityId:node.dataset.fileId};
      if(!targetExists(context,target))return;
      node.dataset.fileUploading='true';node.classList.add('is-file-uploading');
      try{await uploadFiles(files,target,context,{onProgress:message=>context.notify?.(message)});}
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
