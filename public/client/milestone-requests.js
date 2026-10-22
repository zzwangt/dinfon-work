import { formatDateTime } from './time.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => formatDateTime(value);
export function requestComparison(request) {
  const rows = [['节点名称','title'],['截止时间','dueDate']];
  const value = (key, entry) => key === 'dueDate' ? date(entry) : entry;
  if (request.kind === 'create') {
    return `<dl class="node-proposed-details">${rows.map(([label,key])=>`<div><dt>${label}</dt><dd>${escape(value(key,request.proposed?.[key]))}</dd></div>`).join('')}</dl>`;
  }
  return `<div class="node-change-table"><table><caption class="sr-only">大节点申请变更对照</caption><thead><tr><th scope="col">调整内容</th><th scope="col">当前计划</th><th scope="col">申请方案</th></tr></thead><tbody>${rows.map(([label,key])=>{const before=request.before?.[key],after=request.proposed?.[key];return `<tr><th scope="row">${label}</th><td>${escape(value(key,before))}</td><td class="${before!==after?'is-changed':''}">${escape(value(key,after))}</td></tr>`;}).join('')}</tbody></table></div>`;
}
export function renderMilestoneRequestCard(state, request, {admin=false}={}) {
  const p=state.projects.find(p=>p.id===request.projectId),person=id=>state.users.find(u=>u.id===id)?.name||'未关联人员';
  const pending=request.status==='pending';
  const labels={pending:'待审批',approved:'已批准',rejected:'已驳回'},colors={pending:'amber',approved:'green',rejected:'gray'};
  return `<article class="approval-card node-request-card"><div class="approval-head"><div><div><a class="approval-project" href="#projects/${escape(request.projectId)}">${escape(p?.name||'项目')}</a><p class="cell-subtext node-request-meta"><span>${escape(person(request.applicantId))} · ${request.kind==='create'?'新增大节点':'修改大节点'}</span><span>申请于 ${escape(date(request.createdAt))}</span></p></div></div><span class="status ${colors[request.status]||'gray'}">${labels[request.status]||'未知状态'}</span></div><div class="approval-body">${requestComparison(request)}<div class="approval-reason"><span>申请原因</span><p>${escape(request.reason)}</p></div>${request.comment?`<div class="approval-comment"><strong>${escape(person(request.reviewerId))} 的审批意见</strong><p>${escape(request.comment)}</p></div>`:''}</div><div class="approval-footer"><span class="muted">${pending?'批准后生效':`审批于 ${escape(date(request.reviewedAt))}`}</span>${pending&&admin?`<div class="approval-buttons"><button type="button" class="button secondary" data-action="reject-node-request" data-id="${escape(request.id)}">驳回</button><button type="button" class="button primary" data-action="approve-node-request" data-id="${escape(request.id)}">批准申请</button></div>`:''}</div></article>`;
}
