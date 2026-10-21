import { renderProjectFlow, bindFlowCanvas } from './flow.js';
import { today, addDays, weekRange, projectProgress, memberStats } from './domain.js';
import { canAccessRoute } from './access.js';
import { renderMilestoneRequestCard, requestComparison } from './milestone-requests.js';
import { renderProjectTeam, renderProjectPeopleSummary } from './project-team.js';

const LEGACY_KEY = 'dinfon.management.v1';
const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const toastEl = document.querySelector('#toast');
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e = escapeHTML;
const currentDay = () => today();
const shift = (date, days) => addDays(date, days);
let state = null, actorId = '', revision = 0, accountInfo = null, accountsData = null, accountsLoading = false;
let storageIssue = '', toastTimer, weekOffset = 0, taskFilter = 'mine', projectFilter = 'all', approvalFilter = 'pending', approvalKind = 'nodes', searchTerm = '', flowProjectId = '', projectView = 'flow', flowScope = 'all', expandedFlowIds = new Set(), saving = false;
async function api(path, options = {}) {
  const response = await fetch(path, {credentials:'same-origin', cache:'no-store', ...options, headers:{'Content-Type':'application/json', ...(options.headers||{})}});
  const data = await response.json().catch(()=>({error:'服务器响应异常，请稍后重试。'}));
  if(!response.ok){const error=new Error(data.error || data.message || '操作未成功，请重试。');error.status=response.status;throw error;}
  return data;
}
function acceptSession(data) { state=data.state; state.milestoneRequests ||= []; actorId=data.actor.id; revision=data.revision; accountInfo=data.account; }
function authScreen(message='', denied=false) {
  state=null;actorId='';accountsData=null;modal.close();
  app.innerHTML=`<main class="auth-page"><div class="auth-brand">鼎峰<span>协同管理平台</span></div><section class="auth-card"><span class="account-eyebrow">${denied?'访问权限':'团队工作空间'}</span><h1>${denied?'账号尚未获准访问':'使用你的账号进入工作空间'}</h1><p>${e(message||'管理员与员工使用各自的 ChatGPT 账号登录，平台会自动进入对应的工作台。')}</p><div class="auth-role-explainer"><div><strong>管理端</strong><span>项目安排 · 全局统计 · 延期审批 · 账号管理</span></div><div><strong>员工端</strong><span>我的任务 · 成果提交 · 项目流程 · 周计划</span></div></div><a class="button primary" href="${denied?'/signout-with-chatgpt?return_to=/':'/signin-with-chatgpt?return_to=/'}" target="_top">${denied?'退出并更换账号':'使用 ChatGPT 登录'}</a><button class="button ghost" data-action="reload-session">重新检查</button><small>账号权限由管理员分配。无法访问时，请将登录邮箱告知公司管理员。</small></section></main>`;
}
async function loadSession(silent=false) {
  try{ const data=await api('/api/session'); const wasReady=!!state,changed=data.revision!==revision; acceptSession(data); storageIssue=''; if(!wasReady&&!location.hash)history.replaceState(null,'',isAdmin()?'#overview':'#tasks'); if(!silent||(changed&&!modal.open))render(); }
  catch(error){if(error.status===401)authScreen();else if(error.status===403)authScreen(error.message,true);else if(!state)authScreen(error.message);else if(!silent)toast(error.message,true);}
}
const user = id => state?.users.find(u => u.id === id);
const actor = () => user(actorId);
const project = id => state.projects.find(p => p.id === id);
const task = id => state.tasks.find(t => t.id === id);
const milestone = id => state.milestones.find(m => m.id === id);
const isAdmin = () => actor()?.role === 'admin';
const canManage = p => isAdmin() || p?.ownerId === actorId;
const visibleProjects = () => state.projects.filter(p => isAdmin() || p.ownerId === actorId || p.memberIds.includes(actorId));
const visibleTasks = () => state.tasks.filter(t => visibleProjects().some(p => p.id === t.projectId));
const visibleMilestones = () => state.milestones.filter(m => visibleProjects().some(p => p.id === m.projectId));
const visibleExtensions = () => state.extensions.filter(x => visibleProjects().some(p => p.id === x.projectId));
const visibleNodeRequests = () => (state.milestoneRequests||[]).filter(x => visibleProjects().some(p => p.id === x.projectId));
const overdue = t => t.status !== 'done' && t.dueDate < currentDay();
const canReview = t => t.ownerId !== actorId && (isAdmin() || t.reviewerId === actorId);
const canOperate = t => t.ownerId === actorId || isAdmin() || project(t.projectId)?.ownerId === actorId;
function range() {
  const d = shift(currentDay(), weekOffset * 7);
  const result = weekRange(d);
  return Array.isArray(result) ? {start: result[0], end: result[1]} : result;
}
const inRange = (date, r = range()) => date && date.slice(0,10) >= r.start && date.slice(0,10) <= r.end;
const localDate = date => date?.includes('T') ? new Date(Date.parse(date) + 8 * 60 * 60 * 1000).toISOString().slice(0,10) : date;
const dateLabel = value => { const date=localDate(value); return date ? `${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日` : '未设置'; };
const shortDate = date => date ? date.slice(5).replace('-', '/') : '—';
const fullDate = date => date ? localDate(date).replaceAll('-', '.') : '—';
const roleLabel = role => ({admin:'管理员',manager:'项目负责人',member:'项目成员'}[role] || role);
const statusLabel = status => ({todo:'未开始',doing:'进行中',review:'待验收',done:'已完成',overdue:'已逾期',pending:'待审批',approved:'已批准',rejected:'已驳回'}[status] || status);
const statusClass = status => ({todo:'gray',doing:'blue',review:'purple',done:'green',overdue:'red',pending:'amber',approved:'green',rejected:'gray'}[status] || 'gray');
const statusPill = (status, text) => `<span class="status ${statusClass(status)}">${e(text || statusLabel(status))}</span>`;
const iconPaths = {
  home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  task:'<rect x="4" y="4" width="16" height="17" rx="2"/><path d="M9 4V2h6v2M8 10l2 2 5-5M8 17h8"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2M8 18h2"/>',
  approval:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 14l3 3 5-5"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 21v-2a6 6 0 0 0-4-5.65"/>',
  settings:'<path d="m9 3-.6 3-2 .9-2.5-1.2-2 3.5 2.1 1.9v2.1L1.9 15l2 3.5 2.5-1.2 2 .9L9 21h4l.6-2.8 2-.9 2.5 1.2 2-3.5-2.1-1.8v-2.1l2.1-1.9-2-3.5-2.5 1.2-2-.9L13 3z"/><circle cx="11" cy="12" r="3"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  alert:'<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>',
  file:'<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
  logout:'<path d="M9 4H4v16h5M10 12h11m-4-4 4 4-4 4"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.grid}</svg>`;
const avatar = (id, extra = '') => { const u = user(id); return `<span class="avatar ${extra}" title="${e(u?.name || '未分配')}" style="--avatar-color:${safeColor(u?.color)}">${e(u?.name?.slice(-2) || '?')}</span>`; };
const safeColor = value => /^#[0-9a-f]{3,8}$/i.test(value || '') ? value : '#34776f';
const person = id => `<span class="person-cell">${avatar(id)}<span><span class="person-name">${e(user(id)?.name || '未分配')}</span></span></span>`;
const button = (label, action, id = '', className = 'secondary', iconName = '') => `<button type="button" class="button ${className}" data-action="${action}"${id ? ` data-id="${e(id)}"` : ''}>${iconName ? icon(iconName) : ''}${label}</button>`;
const empty = (title, text, action = '') => `<div class="empty-state">${icon('check')}<h3>${title}</h3><p>${text}</p>${action}</div>`;
const progress = p => { const value = projectProgress(state, p.id); return `<div class="project-progress"><div class="progress-label"><span>完成进度</span><strong>${value}%</strong></div><div class="progress-track" role="progressbar" aria-label="${e(p.name)}完成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><span style="width:${value}%"></span></div></div>`; };
function projectStatus(p) {
  if (projectProgress(state,p.id) >= 100) return statusPill('done');
  if (state.extensions.some(x => x.projectId === p.id && x.status === 'pending')) return statusPill('pending', '延期审批中');
  if (p.dueDate < currentDay()) return statusPill('overdue');
  if (p.dueDate > p.originalDueDate) return statusPill('approved', '已批准延期');
  return statusPill('doing');
}
const projectMark = p => `<span class="project-symbol" style="--project-color:${safeColor(p.color)}">${icon('grid')}</span>`;
function toast(message, error = false) {
  clearTimeout(toastTimer); toastEl.hidden = false; toastEl.classList.toggle('error', error); toastEl.textContent = message;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}
async function commit(action, payload, message) {
  if(saving)return;
  saving=true; const submit=modal.querySelector('[type="submit"]');if(submit)submit.disabled=true;
  try {const data=await api('/api/command',{method:'POST',body:JSON.stringify({action,payload,revision})});acceptSession(data);storageIssue='';modal.close();render();toast(message);}
  catch(error){if(error.status===409){await loadSession(true);error.message+=' 已刷新最新数据，请核对后重试。';}if(error.status===401||error.status===403)await loadSession(true);throw error;}
  finally{saving=false;if(submit)submit.disabled=false;}
}
const routes = [{id:'overview',name:'项目流程',icon:'grid'},{id:'dashboard',name:'管理后台',icon:'home'},{id:'projects',name:'项目管理',icon:'grid'},{id:'tasks',name:'我的任务',icon:'task'},{id:'weekly',name:'周计划与汇总',icon:'calendar'},{id:'approvals',name:'审批中心',icon:'approval'},{id:'team',name:'团队与效能',icon:'users'},{id:'accounts',name:'账号管理',icon:'users'},{id:'my-account',name:'我的账号',icon:'settings'}];
function route() { return (location.hash.slice(1) || (isAdmin()?'overview':'tasks')).split('/'); }
function navigationRoutes() {const list=routes.filter(r=>canAccessRoute(actor(),r.id));return isAdmin()?list:list.sort((a,b)=>['tasks','overview','projects','weekly','approvals','my-account'].indexOf(a.id)-['tasks','overview','projects','weekly','approvals','my-account'].indexOf(b.id)).map(r=>r.id==='approvals'?{...r,name:'申请记录'}:r);}
function render() {
  if(!state)return;
  const [page] = route(), a = actor(), nav=navigationRoutes();
  const pending = [...visibleExtensions(),...visibleNodeRequests()].filter(x => x.status === 'pending').length;
  const mobile=(isAdmin()?[routes.find(r=>r.id==='overview'),routes.find(r=>r.id==='dashboard'),routes.find(r=>r.id==='tasks'),routes.find(r=>r.id==='accounts'),routes.find(r=>r.id==='my-account')]:nav.filter(r=>r.id!=='approvals'));
  const navLink=r=>`<a href="#${r.id}" class="nav-item ${page===r.id?'active':''}" ${page===r.id?'aria-current="page"':''}>${icon(r.icon)}<span class="nav-label">${r.name}</span>${r.id==='approvals'&&pending?`<span class="nav-count">${pending}</span>`:''}</a>`;
  app.innerHTML = `<div class="app-shell ${isAdmin()?'admin-workspace':'employee-workspace'}"><aside class="sidebar"><a href="#${isAdmin()?'overview':'tasks'}" class="brand" aria-label="鼎峰工作台首页"><span class="brand-symbol">${icon('grid')}</span><span class="brand-word">鼎峰<span class="brand-subtitle">协同管理平台</span></span></a><div class="workspace-switch">${isAdmin()?'管理工作台':'员工工作台'}</div><div class="nav-section-label">${isAdmin()?'工作空间':'我的工作'}</div><nav aria-label="主导航">${nav.filter(r=>r.id!=='my-account').map(navLink).join('')}</nav><div class="sidebar-bottom">${isAdmin()?`<a href="#settings" class="nav-item ${page==='settings'?'active':''}">${icon('settings')}<span class="nav-label">平台设置</span></a>`:''}${navLink(routes.find(r=>r.id==='my-account'))}<div class="sync-note"><span class="demo-dot"></span>云端保存 · 独立账号</div></div></aside><div class="shell-main"><header class="topbar"><div class="breadcrumb"><strong>${routes.find(r=>r.id===page)?.name||'平台设置'}</strong></div><div class="topbar-actions"><label class="searchbox">${icon('search')}<input type="search" id="global-search" placeholder="搜索项目、任务…" aria-label="搜索项目和任务" value="${e(searchTerm)}" autocomplete="off"><kbd>⌘ K</kbd></label><button class="button ghost small" data-action="reload-session" aria-label="刷新最新数据">刷新</button><a href="#my-account" class="signed-account" aria-label="我的账号">${avatar(a.id)}<span><strong>${e(a.name)}</strong><small>${roleLabel(a.role)}</small></span></a><a href="/signout-with-chatgpt?return_to=/" target="_top" class="signout-link" aria-label="退出登录">${icon('logout')}</a></div></header><main id="content" class="content" tabindex="-1"></main><nav class="mobile-nav" aria-label="移动端导航">${mobile.map(r=>`<a href="#${r.id}" class="nav-item ${page===r.id?'active':''}">${icon(r.icon)}<span class="nav-label">${({overview:'流程',dashboard:'总览',tasks:'任务',projects:'项目',weekly:'周计划',accounts:'账号','my-account':'我的'})[r.id]}</span></a>`).join('')}</nav></div></div>`;
  renderContent();
}
function renderContent() {
  const [page,id] = route();
  if(!canAccessRoute(actor(),page)){document.title='无访问权限 · 鼎峰协同管理';document.querySelector('#content').innerHTML=empty('当前账号没有此页面的访问权限','管理员与员工使用不同工作台。','<a class="button primary" href="#tasks">返回我的任务</a>');return;}
  let html;
  if (searchTerm.trim()) html = searchPage();
  else if (page === 'projects' && id) html = projectDetail(id);
  else html = ({overview:overviewPage,dashboard:dashboardPage,projects:projectsPage,tasks:tasksPage,weekly:weeklyPage,approvals:approvalsPage,team:teamPage,settings:settingsPage,accounts:accountsPage,'my-account':myAccountPage}[page] || overviewPage)();
  document.querySelector('#content').innerHTML = (storageIssue ? `<div class="notice warning">${icon('alert')}<span>${e(storageIssue)}</span></div>` : '') + html;
  document.querySelectorAll('[data-project-flow]').forEach(bindFlowCanvas);
  document.title = `${searchTerm ? '搜索' : routes.find(r => r.id === page)?.name || '平台设置'} · 鼎峰协同管理`;
}
function heading(title, subtitle, actions = '') { return `<div class="page-heading"><div><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`; }
function projectRow(p) {
  const tasks = state.tasks.filter(t => t.projectId === p.id);
  return `<a class="project-row" href="#projects/${e(p.id)}">${projectMark(p)}<div class="project-main"><h3>${e(p.name)}</h3><div class="project-meta"><span>${e(p.code || '项目')}</span><span>${e(user(p.ownerId)?.name)}负责</span><span>${dateLabel(p.dueDate)}截止</span></div></div>${progress(p)}<div class="project-side">${projectStatus(p)}<span class="cell-subtext">${tasks.filter(t => t.status === 'done').length} / ${tasks.length} 项任务</span></div>${icon('chevron')}</a>`;
}
function weeklyRequiredPanel(projects, period=weekRange(currentDay())) {
  const ids=new Set(projects.map(p=>p.id));
  const required=state.milestones.filter(m=>ids.has(m.projectId)&&m.status!=='done'&&m.dueDate<=period.end).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const isCurrent=period.start===weekRange(currentDay()).start;
  return `<section class="panel weekly-required-panel"><div class="panel-header"><div><h2>${isCurrent?'本周必须完成的大节点':'所选周待完成的大节点'} <span class="count">${required.length}</span></h2><p class="panel-subtitle">${fullDate(period.start)} — ${fullDate(period.end)} · 包含之前遗留的未完成节点</p></div><a class="text-link" href="#weekly">周汇总 ${icon('arrow')}</a></div>${required.length?`<div class="weekly-required-list">${required.map(m=>{const p=project(m.projectId),tasks=state.tasks.filter(t=>t.milestoneId===m.id),late=m.dueDate<currentDay();return `<button type="button" class="weekly-required-row ${late?'is-late':''}" data-action="milestone-detail" data-id="${e(m.id)}"><span class="weekly-required-icon">${icon(late?'alert':'calendar')}</span><span class="weekly-required-title"><strong>${e(m.title)}</strong><small>${e(p.name)} · ${e(user(p.ownerId)?.name)}负责</small></span><span class="weekly-required-progress">${tasks.filter(t=>t.status==='done').length} / ${tasks.length}<small>任务已验收</small></span><span class="weekly-required-due"><strong>${dateLabel(m.dueDate)}</strong><small>${late?'已逾期 · 本周补齐':'本周必须完成'}</small></span>${icon('chevron')}</button>`}).join('')}</div>`:empty('本周节点已全部达成','后续阶段仍可在项目流程中查看。')}</section>`;
}
function adminProjectTable(projects) {
  const w=weekRange(currentDay());
  return `<section class="panel admin-data-panel"><div class="panel-header"><div><h2>${isAdmin()?'全部项目数据':'可见项目数据'}</h2><p class="panel-subtitle">点击项目名称打开流程，查看每个大小节点</p></div><a class="text-link" href="#projects">项目管理 ${icon('arrow')}</a></div><div class="table-wrap"><table class="data-table"><thead><tr><th>项目 / 负责人</th><th>总进度</th><th>大节点达成</th><th>任务已验收</th><th>本周必达</th><th>逾期任务</th><th>当前截止 / 原计划</th><th>延期申请</th></tr></thead><tbody>${projects.map(p=>{const ts=state.tasks.filter(t=>t.projectId===p.id),ms=state.milestones.filter(m=>m.projectId===p.id),xs=state.extensions.filter(x=>x.projectId===p.id);return `<tr><td><a class="admin-project-link" href="#projects/${e(p.id)}">${e(p.name)}</a><span class="cell-subtext">${e(user(p.ownerId)?.name)} · ${e(p.code)}</span></td><td><strong>${projectProgress(state,p.id)}%</strong></td><td>${ms.filter(m=>m.status==='done').length} / ${ms.length}</td><td>${ts.filter(t=>t.status==='done').length} / ${ts.length}</td><td><span class="${ms.some(m=>m.status!=='done'&&m.dueDate<=w.end)?'weekly-count-warn':''}">${ms.filter(m=>m.status!=='done'&&m.dueDate<=w.end).length}</span></td><td>${ts.filter(overdue).length}</td><td>${fullDate(p.dueDate)}<span class="cell-subtext">原定 ${fullDate(p.originalDueDate)}</span></td><td>${xs.filter(x=>x.status==='pending').length} 待审批<span class="cell-subtext">${xs.filter(x=>x.status==='approved').length} 已批准 · ${xs.filter(x=>x.status==='rejected').length} 已驳回</span></td></tr>`}).join('')||'<tr><td colspan="8">暂无项目，创建后会自动汇总在此处。</td></tr>'}</tbody></table></div></section>`;
}
function dashboardPage() {
  const projects=visibleProjects(),tasks=visibleTasks(),w=weekRange(currentDay());
  const nodes=visibleMilestones(),required=nodes.filter(m=>m.status!=='done'&&m.dueDate<=w.end),pending=[...visibleExtensions(),...visibleNodeRequests()].filter(x=>x.status==='pending');
  const logs=state.logs.filter(l=>isAdmin()||projects.some(p=>p.id===l.projectId)).slice().sort((a,b)=>b.at.localeCompare(a.at)).slice(0,10);
  return heading('管理后台',isAdmin()?'全公司项目、节点、人员与审批数据，在这里统一汇总。':'当前显示与你相关的项目数据；管理员可查看全公司数据。',button(isAdmin()?'导出全部项目数据':'导出可见项目数据','export-data','','secondary','download'))+`<div class="metrics"><a class="metric" href="#projects"><div class="metric-label">项目总数 ${icon('grid')}</div><div class="metric-value">${projects.length}<span class="metric-unit">个</span></div><div class="metric-foot">${projects.filter(p=>projectProgress(state,p.id)>=100).length} 个已完成 · ${tasks.length} 项任务</div></a><a class="metric" href="#weekly"><div class="metric-label">本周待完成大节点 ${icon('calendar')}</div><div class="metric-value metric-warning">${required.length}<span class="metric-unit">个</span></div><div class="metric-foot">${required.filter(m=>m.dueDate<currentDay()).length} 个已逾期，需优先处理</div></a><button type="button" class="metric" data-action="show-overdue"><div class="metric-label">逾期任务 ${icon('clock')}</div><div class="metric-value">${tasks.filter(overdue).length}<span class="metric-unit">项</span></div><div class="metric-foot">另有 ${tasks.filter(t=>t.status==='review').length} 项成果待验收</div></button><a class="metric" href="#approvals"><div class="metric-label">待审批申请 ${icon('approval')}</div><div class="metric-value">${pending.length}<span class="metric-unit">项</span></div><div class="metric-foot">批准前，原执行计划继续生效</div></a></div><div class="admin-quicklinks"><a href="#team">${icon('users')}人员完成率与工作量 ${icon('arrow')}</a><a href="#weekly">${icon('calendar')}周节点与汇总 ${icon('arrow')}</a><a href="#approvals">${icon('approval')}节点、延期与审批记录 ${icon('arrow')}</a></div>${weeklyRequiredPanel(projects)}${adminProjectTable(projects)}<section class="panel admin-data-panel"><div class="panel-header"><div><h2>全局操作记录</h2><p class="panel-subtitle">任务、节点、计划变更与审批均可追溯 · 最近 10 条</p></div></div><div class="activity-list">${logs.map(l=>`<div class="activity-item"><span class="activity-dot"></span><div class="activity-body"><p><strong>${e(user(l.actorId)?.name||'系统')}</strong> ${e(l.message)}</p><span class="activity-time">${fullDate(l.at)}${l.projectId?` · ${e(project(l.projectId)?.name)}`:''}</span></div></div>`).join('')||'<p class="muted">暂无操作记录。</p>'}</div></section>`;
}
function projectsPage() {
  let projects = visibleProjects();
  const count = projects.length;
  if (projectFilter === 'active') projects = projects.filter(p => projectProgress(state,p.id) < 100);
  if (projectFilter === 'complete') projects = projects.filter(p => projectProgress(state,p.id) >= 100);
  if (projectFilter === 'delayed') projects = projects.filter(p => p.dueDate < currentDay() || p.dueDate > p.originalDueDate || state.extensions.some(x => x.projectId === p.id && x.status === 'pending'));
  return heading('项目管理','将目标拆解为清晰的计划，与团队一起推进。', actor().role !== 'member' ? button('新建项目','new-project','','primary','plus') : '') + `<div class="filters"><div class="filter-tabs">${[['all',`全部项目 ${count}`],['active','进行中'],['delayed','延期关注'],['complete','已完成']].map(([id,label])=>`<button class="filter-tab ${projectFilter===id?'active':''}" data-action="project-filter" data-id="${id}">${label}</button>`).join('')}</div><span class="muted">${projects.length} 个项目</span></div><div class="project-grid">${projects.map(p => `<a class="project-card" href="#projects/${e(p.id)}"><div class="project-card-head">${projectMark(p)}${projectStatus(p)}</div><div class="project-card-title"><span class="cell-subtext">${e(p.code || p.category || '项目')}</span><h2>${e(p.name)}</h2></div><p class="project-card-description">${e(p.description || '暂无项目说明')}</p>${progress(p)}<div class="project-card-footer"><div class="member-stack">${[...new Set([p.ownerId,...p.memberIds])].slice(0,4).map(id=>avatar(id)).join('')}</div><span>${dateLabel(p.dueDate)}截止</span></div></a>`).join('')}</div>${!projects.length ? empty('这里还没有项目','调整筛选条件，或创建一个新的项目。',actor().role !== 'member'?button('新建项目','new-project','','primary','plus'):'') : ''}`;
}
function taskRow(t, showProject = true) {
  return `<div class="task-row"><button class="task-state ${t.status === 'done'?'is-done':''}" data-action="task-detail" data-id="${e(t.id)}" aria-label="查看任务 ${e(t.title)}">${icon(t.status==='done'?'check':t.status==='review'?'approval':'task')}</button><div class="task-main"><button class="task-title ${t.status==='done'?'is-done':''}" data-action="task-detail" data-id="${e(t.id)}">${e(t.title)}</button><div class="task-meta">${showProject?`<span>${e(project(t.projectId)?.name)}</span>`:''}<span>${e(user(t.ownerId)?.name)}</span><span class="${overdue(t)?'overdue-text':''}">${dateLabel(t.dueDate)}截止${overdue(t)?' · 已逾期':''}</span>${t.priority==='high'?'<span class="priority-high">高优先级</span>':''}</div></div><div class="task-actions">${statusPill(t.status)}${t.status==='review' && canReview(t)?button('验收','task-detail',t.id,'small secondary'):t.ownerId===actorId && t.status==='doing'?button('提交成果','submit-task',t.id,'small secondary'):button('详情','task-detail',t.id,'small ghost')}</div></div>`;
}
function overviewPage() {
  const ps = visibleProjects();
  const p = ps.find(item=>item.id===flowProjectId) || ps[0];
  if(!p) return heading('项目流程','从一个项目开始，把目标拆成可交付的大小节点。',actor().role!=='member'?button('新建项目','new-project','','primary','plus'):'')+empty('创建第一个项目流程','先确定项目组，再添加阶段节点和具体任务。');
  flowProjectId=p.id;
  return projectWorkspace(p,true);
}
function projectDetail(id) {
  const p=visibleProjects().find(item=>item.id===id);
  if(!p)return empty('无法查看此项目','当前身份没有访问权限，或项目不存在。','<a class="button secondary" href="#projects">返回项目列表</a>');
  flowProjectId=p.id;
  return `<a class="back-link" href="#projects">${icon('arrow')} 返回项目列表</a>`+projectWorkspace(p,false);
}
function projectWorkspace(p,home=false) {
  const ts=state.tasks.filter(t=>t.projectId===p.id),ms=state.milestones.filter(m=>m.projectId===p.id).sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  const xs=state.extensions.filter(x=>x.projectId===p.id),pending=xs.find(x=>x.status==='pending'),approved=xs.filter(x=>x.status==='approved');
  const logs=state.logs.filter(l=>l.projectId===p.id).slice().sort((a,b)=>b.at.localeCompare(a.at)).slice(0,20);
  const pct=projectProgress(state,p.id),done=ts.filter(t=>t.status==='done').length;
  const actions=`${button('申请大节点','new-milestone',p.id,canManage(p)?'secondary':'primary','plus')}${canManage(p)?`${button('添加任务','new-task',p.id,'primary','plus')}<details class="project-more"><summary class="button secondary">更多 ${icon('chevron')}</summary><div class="project-more-menu">${button('申请项目延期','new-extension',p.id,'ghost','clock')}</div></details>`:''}`;
  const projectHeader=`<div class="flow-project-heading"><div><div class="flow-project-label">${projectStatus(p)}<span>${e(p.code)} · ${e(p.category)}</span></div>${home?`<h1 class="sr-only">项目流程</h1><label class="flow-inline-selector"><span class="sr-only">当前项目</span><select id="flow-project-select" aria-label="当前项目">${visibleProjects().map(item=>`<option value="${e(item.id)}" ${item.id===p.id?'selected':''}>${e(item.name)}</option>`).join('')}</select></label>`:`<h1>${e(p.name)}</h1>`}</div><div class="heading-actions">${actions}</div></div>`;
  const summary=`<div class="flow-summary-bar"><div class="flow-summary-progress"><span>项目进度</span><strong>${pct}%</strong><div class="progress-track" role="progressbar" aria-label="项目完成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div><small>${ms.filter(m=>m.status==='done').length} / ${ms.length} 个大节点完成</small></div><div><span>任务完成</span><strong>${done}<small> / ${ts.length}</small></strong></div><div class="flow-deadline"><span>截止</span><strong>${fullDate(p.dueDate)}</strong>${p.dueDate!==p.originalDueDate?`<small>原定 ${fullDate(p.originalDueDate)}</small>`:''}</div></div>`;
  const extension=pending?`<div class="notice warning flow-extension-note">${icon('clock')}<span>延期审批中：申请调整至 ${fullDate(pending.newDueDate)}，批准前仍执行 ${fullDate(p.dueDate)}。</span><a href="#approvals" class="text-link">查看申请</a></div>`:approved.length?`<div class="flow-approved-note">${icon('approval')}<span>已批准延期 ${approved.length} 次 · 累计 ${Math.round((Date.parse(p.dueDate)-Date.parse(p.originalDueDate))/86400000)} 天</span><a href="#approvals" class="text-link">查看记录</a></div>`:'';
  const tabs=`<div class="flow-view-row"><div class="filter-tabs">${[['flow','流程图'],['list','任务'],['people','成员'],['requests','申请'],['history','记录']].map(([id,title])=>`<button type="button" class="filter-tab ${projectView===id?'active':''}" data-action="project-view" data-id="${id}">${title}</button>`).join('')}</div></div>`;
  let view;
  if(projectView==='list')view=`<div class="detail-grid"><section class="panel"><div class="panel-header"><h2>任务计划 <span class="count">${ts.length}</span></h2></div><div class="task-list">${ts.map(t=>taskRow(t,false)).join('')||empty('还没有任务','先添加一个阶段节点，再拆分具体任务。')}</div></section><section class="panel milestone-panel"><div class="panel-header"><h2>阶段节点</h2></div><div class="milestone-list">${ms.map(m=>milestoneCard(m,true)).join('')||empty('规划第一个大节点','每周对应一个可验收成果。')}</div></section></div>`;
  else if(projectView==='people')view=renderProjectTeam(state,p);
  else if(projectView==='requests')view=projectNodeRequests(p);
  else if(projectView==='history')view=`<section class="panel"><div class="panel-header"><h2>项目操作记录</h2><span class="muted">最近 ${logs.length} 条</span></div><div class="activity-list">${logs.map(l=>`<div class="activity-item"><span class="activity-dot"></span><div class="activity-body"><p><strong>${e(user(l.actorId)?.name||'系统')}</strong> ${e(l.message)}</p><span class="activity-time">${fullDate(l.at)}</span></div></div>`).join('')||'<p class="muted">暂无记录。</p>'}</div></section>`;
  else view=renderProjectFlow(state,p,{canManage:canManage(p),actorId,scope:flowScope,expandedIds:[...expandedFlowIds]});
  return `<div class="project-workspace">${projectHeader}${summary}${renderProjectPeopleSummary(state,p)}${extension}${nodeApprovalBanner(p)}${tabs}${view}</div>`;
}
function milestoneDetail(id) {
  const m=milestone(id),p=m&&project(m.projectId);if(!m||!visibleProjects().some(item=>item.id===p.id))return;
  const ts=state.tasks.filter(t=>t.milestoneId===m.id),done=ts.filter(t=>t.status==='done').length;
  const actions=(canManage(p)?`${m.status!=='done'?`<button type="button" class="button secondary" data-action="new-task" data-id="${e(p.id)}" data-milestone-id="${e(m.id)}">添加小任务</button>`:''}${m.status!=='done'&&ts.length&&done===ts.length?button('确认节点达成','complete-milestone',m.id,'primary','check'):''}`:'')+(m.status!=='done'&&!visibleNodeRequests().some(x=>x.milestoneId===m.id&&x.status==='pending')?button('申请修改大节点','edit-milestone',m.id,'secondary'):'');
  showModal('大节点详情',`<div class="task-detail-heading"><h3>${e(m.title)}</h3>${statusPill(m.status==='done'?'done':'doing',m.status==='done'?'已达成':'待达成')}</div><p class="muted">${e(p.name)}</p><div class="task-detail-meta"><div><span>阶段截止</span><strong>${fullDate(m.dueDate)}</strong>${m.dueDate!==m.originalDueDate?`<small>原计划 ${fullDate(m.originalDueDate)}</small>`:''}</div><div><span>已验收任务</span><strong>${done} / ${ts.length}</strong></div></div>${visibleNodeRequests().some(x=>x.milestoneId===m.id&&x.status==='pending')?'<p class="request-pending-note">此节点已有修改申请待审批，当前计划仍然生效。<a class="text-link" href="#approvals">查看申请</a></p>':''}<h4>节点内的任务</h4><div class="task-list">${ts.map(t=>taskRow(t,false)).join('')||'<p class="form-intro">为这个阶段添加具体任务，明确执行人与验收标准。</p>'}</div><p class="field-help">所有关联任务验收通过后，项目负责人确认大节点达成，才计入项目总进度。</p>`,'','',m.id,actions);
}
function tasksPage() {
  let tasks=visibleTasks(); const all=tasks;
  if(taskFilter==='mine') tasks=tasks.filter(t=>t.ownerId===actorId);
  if(taskFilter==='review') tasks=tasks.filter(t=>t.status==='review'&&canReview(t));
  if(taskFilter==='overdue') tasks=tasks.filter(overdue);
  if(taskFilter==='done') tasks=tasks.filter(t=>t.status==='done');
  tasks=tasks.slice().sort((a,b)=>(a.status==='done')-(b.status==='done') || a.dueDate.localeCompare(b.dueDate));
  return heading('我的任务','明确今天的重点，让每一份交付都有着落。',visibleProjects().some(canManage)?button('新建任务','new-task','','primary','plus'):'')+`<div class="filters"><div class="filter-tabs">${[['mine','我负责的'],['review',`待我验收 ${all.filter(t=>t.status==='review'&&canReview(t)).length}`],['all','全部任务'],['overdue','已逾期'],['done','已完成']].map(([id,label])=>`<button class="filter-tab ${taskFilter===id?'active':''}" data-action="task-filter" data-id="${id}">${label}</button>`).join('')}</div><span class="muted">${tasks.length} 项任务</span></div><section class="panel"><div class="task-list">${tasks.map(t=>taskRow(t)).join('')||empty('当前没有此类任务',taskFilter==='mine'?'管理员分配给你的任务会出现在这里。':'调整筛选条件，或继续推进其他任务。')}</div></section><p class="page-note">任务可以跨多天进行；每天更新进展，提交后由指定验收人确认。</p>`;
}
function milestoneCard(m, compact=false) {
  const ts=state.tasks.filter(t=>t.milestoneId===m.id), done=ts.filter(t=>t.status==='done').length, p=project(m.projectId);
  return `<div class="milestone-card ${compact?'compact':''}"><div class="milestone-card-top"><span class="milestone-date">${dateLabel(m.dueDate)}</span>${statusPill(m.status==='done'?'done':m.dueDate<currentDay()?'overdue':'doing',m.status==='done'?'已达成':m.dueDate<currentDay()?'待达成 · 逾期':'进行中')}</div><h3 class="milestone-title">${e(m.title)}</h3>${!compact?`<a class="text-link" href="#projects/${e(m.projectId)}">${e(p?.name)}</a>`:''}<div class="milestone-meta"><span>${done} / ${ts.length} 项已验收</span></div><div class="progress-track"><span style="width:${ts.length?Math.round(done/ts.length*100):0}%"></span></div>${m.status!=='done'&&canManage(p)?`<div class="milestone-tasks">${button('确认节点达成','complete-milestone',m.id,'small secondary')}${ts.some(t=>t.status!=='done')?'<span class="cell-subtext">全部关联任务验收后可确认</span>':''}</div>`:''}</div>`;
}
function reportData() { const r=range(), ts=visibleTasks().filter(t=>inRange(t.dueDate,r)), ms=visibleMilestones().filter(m=>inRange(m.dueDate,r)); return {r,ts,ms,done:ts.filter(t=>t.status==='done'),late:ts.filter(overdue)}; }
function weeklyPage() {
  const {r,ts,ms,done,late}=reportData(); const nextR={start:shift(r.start,7),end:shift(r.end,7)}, next=visibleTasks().filter(t=>inRange(t.dueDate,nextR));
  return heading('周计划与汇总','以每周交付节点，连接日常工作与项目目标。',button('导出周报','export-week','','secondary','download'))+`<div class="toolbar week-toolbar"><div class="week-switch">${button('上一周','previous-week','','small ghost')}<strong>${fullDate(r.start)} — ${fullDate(r.end)}</strong>${button('下一周','next-week','','small ghost')}</div>${button(weekOffset===0?'本周':'回到本周','current-week','','small secondary')}</div><div class="report-summary"><div><span>本周任务</span><strong>${ts.length}<small>项</small></strong></div><div><span>已验收完成</span><strong>${done.length}<small>项</small></strong></div><div><span>周节点达成</span><strong>${ms.filter(m=>m.status==='done').length}<small>/ ${ms.length}</small></strong></div><div><span>逾期任务</span><strong>${late.length}<small>项</small></strong></div></div><div class="section-heading"><div><h2>本周里程碑</h2><p class="panel-subtitle">每个节点都对应明确的交付成果</p></div></div><div class="week-grid">${ms.sort((a,b)=>a.dueDate.localeCompare(b.dueDate)).map(m=>milestoneCard(m)).join('')}</div>${!ms.length?empty('这一周还没有里程碑','在项目详情中添加带验收标准的周节点。'):''}<section class="panel report-panel"><div class="panel-header"><div><h2>周汇总草稿</h2><p class="panel-subtitle">根据项目数据自动汇总，可导出后补充原因与下周安排</p></div><span class="tag">自动汇总</span></div><div class="report-columns"><div class="report-block"><h3>已完成的工作 <span class="count">${done.length}</span></h3>${done.length?`<ul>${done.map(t=>`<li><strong>${e(t.title)}</strong><span>${e(user(t.ownerId)?.name)} · ${e(project(t.projectId)?.name)}</span></li>`).join('')}</ul>`:'<p class="muted">本周到期任务尚无验收完成记录。</p>'}</div><div class="report-block"><h3>逾期待跟进 <span class="count">${late.length}</span></h3>${late.map(t=>`<p><strong>${e(t.title)}</strong><span>${e(`已超过 ${dateLabel(t.dueDate)} 截止日期`)}</span></p>`).join('')||'<p class="muted">本周到期任务暂无逾期事项。</p>'}<h3 class="next-week-title">下周计划 <span class="count">${next.length}</span></h3>${next.slice(0,5).map(t=>`<p>${e(t.title)}<span>${dateLabel(t.dueDate)} · ${e(user(t.ownerId)?.name)}</span></p>`).join('')||'<p class="muted">下周暂未安排到期任务。</p>'}</div></div></section>`;
}
function nodeApprovalBanner(p) {
  const count=visibleNodeRequests().filter(x=>x.projectId===p.id&&x.status==='pending').length;
  return count?`<div class="node-approval-banner">${icon('approval')}<span>${count} 项大节点申请待审批</span><button class="text-link" data-action="project-view" data-id="requests">查看申请 ${icon('arrow')}</button></div>`:'';
}
function projectNodeRequests(p) {
  const list=visibleNodeRequests().filter(x=>x.projectId===p.id).slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return `<section class="project-node-requests"><div class="section-heading"><div><h2>大节点申请</h2><p class="panel-subtitle">新增与修改均由管理员批准后生效，审批记录持续保留。</p></div>${button('申请新增大节点','new-milestone',p.id,'secondary','plus')}</div><div class="approval-list">${list.map(x=>renderMilestoneRequestCard(state,x,{admin:isAdmin()})).join('')||empty('还没有大节点申请','新增节点可在此提交；修改节点请点击流程图中的大节点，再选择“申请修改大节点”。')}</div></section>`;
}
function approvalsPage() {
  const nodes=visibleNodeRequests(),extensions=visibleExtensions(),all=approvalKind==='nodes'?nodes:extensions;
  const list=all.filter(x=>approvalFilter==='all'||x.status===approvalFilter).slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return heading(isAdmin()?'审批中心':'申请记录','提交申请、查看处理意见，批准后计划才会更新。',approvalKind==='extensions'&&visibleProjects().some(canManage)?button('申请项目延期','new-extension','','primary','plus'):'')+`<div class="approval-kind-tabs" aria-label="申请类型">${[['nodes','大节点申请',nodes],['extensions','项目延期',extensions]].map(([id,label,items])=>`<button class="filter-tab ${approvalKind===id?'active':''}" aria-pressed="${approvalKind===id}" data-action="approval-kind" data-id="${id}">${label} · ${items.filter(x=>x.status==='pending').length} 待审批</button>`).join('')}</div><div class="filters"><div class="filter-tabs">${[['pending',`待审批 ${all.filter(x=>x.status==='pending').length}`],['approved','已批准'],['rejected','已驳回'],['all','全部申请']].map(([id,label])=>`<button class="filter-tab ${approvalFilter===id?'active':''}" data-action="approval-filter" data-id="${id}">${label}</button>`).join('')}</div><span class="muted">${list.length} 条记录</span></div><div class="approval-list">${list.map(x=>approvalKind==='nodes'?renderMilestoneRequestCard(state,x,{admin:isAdmin()}):approvalCard(x)).join('')||empty('当前没有此类申请',approvalKind==='nodes'?'在项目流程中申请新增大节点，或点击已有大节点申请修改。':'项目负责人可以从项目详情提交延期申请。')}</div>`;
}
function approvalCard(x) {
  const p=project(x.projectId), days=Math.round((Date.parse(x.newDueDate)-Date.parse(x.originalDueDate))/86400000);
  return `<article class="approval-card"><div class="approval-head"><div>${projectMark(p||{})}<div><a href="#projects/${e(x.projectId)}" class="approval-project">${e(p?.name || '项目')}</a><p class="cell-subtext">${e(user(x.applicantId)?.name)} 提交于 ${fullDate(x.createdAt)}</p></div></div>${statusPill(x.status)}</div><div class="approval-body"><div class="date-change"><div class="date-box"><span>申请时截止日期</span><strong>${fullDate(x.originalDueDate)}</strong></div>${icon('arrow')}<div class="date-box"><span>申请调整至</span><strong>${fullDate(x.newDueDate)}</strong></div><span class="tag">延期 ${days} 天</span></div><div class="approval-reason"><span>延期原因</span><p>${e(x.reason)}</p></div><div class="approval-plan"><div><span>后续安排</span><p>${e(x.plan)}</p></div><div><span>影响范围</span><p>${e(x.impact || '未补充')}</p></div></div>${x.affectedMilestones?.length || x.affectedTasks?.length?`<div class="affected-summary"><strong>同步调整 ${x.affectedMilestones?.length || 0} 个节点、${x.affectedTasks?.length || 0} 项任务</strong>${[...(x.affectedMilestones||[]).map(a=>({title:milestone(a.id)?.title,date:a.newDueDate})),...(x.affectedTasks||[]).map(a=>({title:task(a.id)?.title,date:a.newDueDate}))].map(a=>`<span>${e(a.title)} → ${fullDate(a.date)}</span>`).join('')}</div>`:''}${x.comment?`<div class="approval-comment"><strong>${e(user(x.reviewerId)?.name)} 的审批意见</strong><p>${e(x.comment)}</p></div>`:''}</div><div class="approval-footer"><span class="muted">${x.status==='pending'?'等待管理人员审批':`${e(user(x.reviewerId)?.name || '管理员')} · ${fullDate(x.reviewedAt)}`}</span><div class="approval-buttons">${x.status==='pending'&&isAdmin()&&x.applicantId!==actorId?`${button('驳回申请','reject-extension',x.id,'secondary')}${button('批准延期','approve-extension',x.id,'primary','check')}`:x.status==='pending'&&x.applicantId===actorId?'<span class="cell-subtext">申请人不能审批自己的申请</span>':''}</div></div></article>`;
}
function teamPage() {
  const r=range(), ids=new Set(visibleProjects().flatMap(p=>[p.ownerId,...p.memberIds])); const people=isAdmin()?state.users:actor().role==='member'?[actor()]:state.users.filter(u=>ids.has(u.id)); const scopedState={...state,tasks:visibleTasks()};
  return heading('团队与效能','同时关注完成、及时与质量，让每一份贡献清晰可见。',isAdmin()?'<a class="button primary" href="#accounts">管理团队账号</a>':'')+`<div class="toolbar"><div><strong>本周执行情况</strong><span class="muted"> ${fullDate(r.start)} — ${fullDate(r.end)}</span></div><div>${button('上一周','previous-week','','small ghost')}${button('本周','current-week','','small secondary')}${button('下一周','next-week','','small ghost')}</div></div><div class="notice info">${icon('users')}<span>按所选周截止日期统计，包含本周尚未到期任务；用于观察计划执行，非员工绩效排名。按时率以提交时间为准，验收等待不算作成员提交延误。</span></div><section class="panel"><div class="table-wrap"><table class="data-table"><thead><tr><th>团队成员</th><th>部门 / 角色</th><th>本周计划完成率</th><th>按时提交率</th><th>一次验收通过率</th><th>当前负荷</th></tr></thead><tbody>${people.map(u=>{const s=memberStats(scopedState,u.id,r.start,r.end), pending=scopedState.tasks.filter(t=>t.ownerId===u.id&&t.status!=='done');return `<tr><td>${person(u.id)}<span class="cell-subtext person-title">${e(u.title)}</span></td><td>${e(u.department)}<span class="cell-subtext">${roleLabel(u.role)}</span></td><td>${rate(s.completionRate,s.completed,s.due)}</td><td>${rate(s.onTimeRate,s.onTime,s.due)}</td><td>${rate(s.firstPassRate,s.firstPassed,s.firstReviewed)}</td><td><strong>${pending.length}</strong> 项<span class="cell-subtext">${pending.filter(t=>t.status==='review').length} 项待验收 · ${pending.filter(overdue).length} 项逾期</span></td></tr>`}).join('')}</tbody></table></div></section><div class="metrics-note"><h3>指标如何计算</h3><p>本周计划完成率 = 所选周内截止且已验收任务 ÷ 所选周内截止任务（包含尚未到期任务）。按时提交率 = 截止时间前提交的任务 ÷ 本周到期任务。一次验收通过率 = 本周计划任务中首次验收通过的任务 ÷ 这些任务中已发生首次验收的任务。没有可统计任务时显示「—」。</p><p>获批调整的任务按新日期统计；项目原截止日期和全部审批记录仍然保留。</p></div>`;
}
const rate=(pct,n,d)=>`<span class="rate ${pct!==null&&pct>=80?'positive':''}">${pct===null || pct===undefined?'—':`${Math.round(pct)}%`}</span><span class="cell-subtext">${n ?? 0} / ${d ?? 0} 项</span>`;
function settingsPage() {
  let hasLegacy=false;try{hasLegacy=!!localStorage.getItem(LEGACY_KEY);}catch{}
  return heading('平台设置','账号权限和业务数据由服务器统一管理。')+`<div class="settings-grid"><section class="settings-card"><div class="settings-icon">${icon('grid')}</div><h2>工作空间</h2><dl class="settings-details"><div><dt>空间名称</dt><dd>鼎峰工作空间</dd></div><div><dt>身份认证</dt><dd>ChatGPT 独立账号</dd></div><div><dt>数据存储</dt><dd>云端数据库</dd></div><div><dt>当前数据版本</dt><dd>${revision}</dd></div></dl><p>管理员查看全局并分配权限，员工仅访问参与项目。所有变更均由服务器校验并保存。</p><a class="text-link" href="#accounts">管理账号 ${icon('arrow')}</a></section><section class="settings-card"><div class="settings-icon">${icon('download')}</div><h2>数据备份</h2><p>导出当前可见的项目、任务、成员和审批记录。备份不包含账号登录信息。</p><div class="settings-actions">${button('导出项目数据','export-data','','secondary','download')}</div><p class="cell-subtext">${visibleProjects().length} 个项目 · ${visibleTasks().length} 项任务</p>${hasLegacy?`<div class="legacy-data-note"><strong>检测到旧版浏览器数据</strong><p>这些数据仍保留在此浏览器，尚未合并到云端。可先导出备份，避免覆盖云端记录。</p>${button('导出旧版备份','export-legacy','','secondary','download')}</div>`:''}</section><section class="settings-card"><div class="settings-icon">${icon('approval')}</div><h2>执行规则</h2><ul class="plain-list"><li>提交成果并通过验收后，任务才计为完成。</li><li>全部大节点验收通过，项目进度才达到 100%。</li><li>新增、修改大节点须提交申请，管理员批准后才生效。</li><li>延期申请与审批人分离，批准后才调整日期。</li><li>多人同时修改时会提示刷新，避免覆盖他人更新。</li></ul></section><section class="settings-card"><div class="settings-icon">${icon('users')}</div><h2>员工进入平台</h2><p>先在账号管理中登记员工的 ChatGPT 登录邮箱，再在站点共享设置中允许同一邮箱访问本站。两处都开通后，员工才可登录。</p><p class="cell-subtext">当前站点仍保留私有访问范围；创建平台账号不会自动发送邀请或开放站点。</p></section></div>`;
}
function myAccountPage() {
  const a=actor(),w=weekRange(currentDay()),s=memberStats(state,a.id,w.start,w.end);
  return heading('我的账号','当前身份由 ChatGPT 登录确认，权限由平台管理员分配。')+`<div class="account-profile-card"><div class="account-profile-head">${avatar(a.id)}<div><h2>${e(a.name)}</h2><span>${e(a.title||roleLabel(a.role))} · ${e(a.department||'工作空间')}</span></div><span class="status ${isAdmin()?'green':'blue'}">${isAdmin()?'管理端':'员工端'}</span></div><dl class="account-profile-details"><div><dt>登录邮箱</dt><dd>${e(accountInfo?.email||'—')}</dd></div><div><dt>平台角色</dt><dd>${roleLabel(a.role)}</dd></div><div><dt>可见项目</dt><dd>${visibleProjects().length} 个${isAdmin()?' · 全部项目':' · 仅参与的项目'}</dd></div><div><dt>数据存储</dt><dd>云端保存</dd></div></dl><p class="field-help">${isAdmin()?'你可以管理项目、审批延期、查看团队数据，并开通员工账号。':'你可以查看参与项目、处理自己的任务并提交成果。项目负责人可安排所负责项目的计划。'}</p><div class="my-account-links">${isAdmin()?'<a href="#settings" class="text-link">平台设置与数据备份</a><a href="#team" class="text-link">团队与效能</a>':'<a href="#approvals" class="text-link">查看申请记录</a>'}</div><a class="button secondary" href="/signout-with-chatgpt?return_to=/" target="_top">退出当前账号</a></div><section class="panel personal-stats"><div class="panel-header"><h2>我本周的执行情况</h2><span class="muted">${shortDate(w.start)} — ${shortDate(w.end)}</span></div><div class="personal-stats-grid"><div><span>计划完成率</span>${rate(s.completionRate,s.completed,s.due)}</div><div><span>按时提交率</span>${rate(s.onTimeRate,s.onTime,s.due)}</div><div><span>一次验收通过率</span>${rate(s.firstPassRate,s.firstPassed,s.firstReviewed)}</div></div></section>`;
}
async function loadAccounts() {
  if(!isAdmin()||accountsLoading)return;
  accountsLoading=true;
  try{accountsData=await api('/api/accounts');if(route()[0]==='accounts'&&!modal.open)renderContent();}
  catch(error){toast(error.message,true);if(error.status===401||error.status===403)await loadSession(true);}
  finally{accountsLoading=false;}
}
function accountsPage() {
  if(!accountsData){if(!accountsLoading)queueMicrotask(loadAccounts);return heading('账号管理','管理员与员工分别登录，权限由服务器执行。')+'<div class="panel session-loading" role="status">正在加载账号…</div>';}
  const list=accountsData.accounts,active=list.filter(x=>x.status==='active'),unlinked=state.users.filter(u=>!list.some(x=>x.userId===u.id));
  return heading('账号管理','登记员工的登录邮箱，分配角色，并关联已有项目成员。',button('开通账号','new-account','','primary','plus'))+`<div class="account-summary"><span><strong>${active.length}</strong> 已启用账号</span><span><strong>${list.filter(x=>x.role==='admin').length}</strong> 管理员</span><span><strong>${unlinked.length}</strong> 位成员尚未关联账号</span><button class="text-link" data-action="refresh-accounts">刷新列表</button></div><div class="account-access-note">${icon('users')}<div><strong>管理端与员工端独立使用</strong><p>开通账号后，还需在本站的共享设置中授权同一邮箱访问。员工用自己的 ChatGPT 账号登录，系统自动进入员工工作台；这里不会自动发送邀请。</p></div></div><section class="panel"><div class="table-wrap"><table class="data-table account-table"><thead><tr><th>姓名 / 登录邮箱</th><th>角色与工作台</th><th>账号状态</th><th>登录关联</th><th>操作</th></tr></thead><tbody>${list.map(a=>`<tr><td><strong>${e(a.name)}</strong><span class="cell-subtext">${e(a.email)}</span></td><td>${roleLabel(a.role)}<span class="cell-subtext">${a.role==='admin'?'管理端 · 全局数据':'员工端 · 参与项目'}</span></td><td>${statusPill(a.status==='active'?'done':'todo',a.status==='active'?'已启用':'已停用')}</td><td>${a.linked?'已绑定 ChatGPT':'等待首次登录'}<span class="cell-subtext">${a.lastLoginAt?`最近登录 ${fullDate(a.lastLoginAt)}`:'请使用登记的邮箱登录'}</span></td><td>${button('管理','edit-account',a.id,'small secondary')}${a.userId===actorId?'<span class="cell-subtext">当前账号</span>':''}</td></tr>`).join('')}</tbody></table></div></section>${unlinked.length?`<section class="panel unlinked-members"><div class="panel-header"><div><h2>尚未开通账号的项目成员</h2><p class="panel-subtitle">业务中的负责人记录不会自动成为登录账号。开通时选择“关联已有成员”即可保留原有任务归属。</p></div></div><div class="unlinked-member-list">${unlinked.map(u=>`<span>${avatar(u.id)}${e(u.name)}<small>${roleLabel(u.role)}</small></span>`).join('')}</div></section>`:''}`;
}
function accountRoleOptions(selected='member') {return [['member','员工'],['manager','项目负责人'],['admin','管理员']].map(([id,label])=>`<option value="${id}" ${selected===id?'selected':''}>${label}</option>`).join('');}
function newAccount() {
  if(!isAdmin())return;
  const linked=new Set((accountsData?.accounts||[]).map(a=>a.userId));
  showModal('开通独立账号',`<p class="form-intro">登记对方实际用于 ChatGPT 登录的邮箱。员工无法自己选择或提升角色。</p><div class="form-grid">${field('登录邮箱','email','','email','required maxlength="254" autocomplete="off"')}${field('姓名','name','','text','required maxlength="30"')}${selectField('账号角色','role',accountRoleOptions())}${selectField('关联项目成员','existingUserId','<option value="new">创建新成员</option>'+state.users.filter(u=>!linked.has(u.id)).map(u=>`<option value="${e(u.id)}">${e(u.name)} · ${roleLabel(u.role)}</option>`).join(''))}${field('职位','title','','text','maxlength="40"')}${field('部门','department','','text','maxlength="40"')}</div><p class="field-help">关联已有成员将保留其任务和项目归属，并使用上面的姓名、角色。管理员可以访问全部公司数据，请谨慎分配。</p>`,'开通账号','create-account');
}
function editAccount(id) {
  const a=accountsData?.accounts.find(x=>x.id===id);if(!a||!isAdmin())return;
  const own=a.userId===actorId;
  showModal('管理账号',`<p class="form-intro"><strong>${e(a.name)}</strong><br>${e(a.email)}</p>${selectField('账号角色','role',accountRoleOptions(a.role))}${selectField('账号状态','status',`<option value="active" ${a.status==='active'?'selected':''}>启用</option><option value="disabled" ${a.status==='disabled'?'selected':''} ${own?'disabled':''}>停用</option>`)}<p class="field-help">${own?'不能停用当前账号，也不能移除最后一名管理员。':'停用后，该账号立即失去平台数据访问和操作权限。项目与任务历史记录仍会保留。'} 修改角色不会自动变更项目负责人或任务归属。</p>`,'保存账号设置','edit-account',id);
}
async function saveAccount(action,payload,id) {
  if(saving)return;saving=true;const submit=modal.querySelector('[type="submit"]');if(submit)submit.disabled=true;
  try{
    if(!payload.existingUserId||payload.existingUserId==='new')delete payload.existingUserId;
    const data=await api(action==='create-account'?'/api/accounts':`/api/accounts/${encodeURIComponent(id)}`,{method:action==='create-account'?'POST':'PATCH',body:JSON.stringify({...payload,revision:accountsData?.revision??revision})});
    acceptSession(data);accountsData={accounts:data.accounts,users:state.users,revision:data.revision};modal.close();render();toast(action==='create-account'?'账号已开通；请确认站点共享权限也已授予该邮箱。':'账号设置已保存。');
  }catch(error){if(error.status===409)await loadAccounts();throw error;}finally{saving=false;if(submit)submit.disabled=false;}
}
function searchPage() {
  const q=searchTerm.trim().toLowerCase(), ps=visibleProjects().filter(p=>`${p.name} ${p.description} ${p.code}`.toLowerCase().includes(q)),ts=visibleTasks().filter(t=>`${t.title} ${t.description} ${user(t.ownerId)?.name}`.toLowerCase().includes(q));
  return heading('搜索结果',`“${e(searchTerm.trim())}” · 找到 ${ps.length} 个项目、${ts.length} 项任务`,button('清除搜索','clear-search','','secondary'))+`<section class="panel"><div class="panel-header"><h2>项目 <span class="count">${ps.length}</span></h2></div><div class="project-list">${ps.map(projectRow).join('')||'<p class="search-empty">没有匹配的项目</p>'}</div></section><section class="panel detail-section"><div class="panel-header"><h2>任务 <span class="count">${ts.length}</span></h2></div><div class="task-list">${ts.map(t=>taskRow(t)).join('')||'<p class="search-empty">没有匹配的任务，试试项目名、任务名或负责人。</p>'}</div></section>`;
}

function showModal(title, body, submitLabel='保存', formAction='', id='', extra='') {
  modal.innerHTML=`<div class="modal-header"><h2 id="modal-title">${title}</h2><button class="modal-close icon-button" data-action="close-modal" aria-label="关闭">${icon('close')}</button></div><form data-form="${formAction}" data-id="${e(id)}"><div class="modal-body">${body}<p class="form-error" role="alert" hidden></p></div><div class="modal-footer">${extra}<button type="button" class="button secondary" data-action="close-modal">取消</button>${formAction?`<button type="submit" class="button primary">${submitLabel}</button>`:''}</div></form>`;
  if (!modal.open) modal.showModal();
}
const field=(label,name,value='',type='text',options='')=>`<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${e(value)}" ${options}></div>`;
const textarea=(label,name,placeholder='',required=true,value='')=>`<div class="field full"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}" rows="3" placeholder="${e(placeholder)}" ${required?'required':''} maxlength="2000">${e(value)}</textarea></div>`;
const selectField=(label,name,options)=>`<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}" required>${options}</select></div>`;
const userOptions=(selected,users=state.users)=>users.map(u=>`<option value="${e(u.id)}" ${selected===u.id?'selected':''}>${e(u.name)} · ${e(u.title || roleLabel(u.role))}</option>`).join('');
const projectOptions=(selected,ps=visibleProjects().filter(canManage))=>ps.map(p=>`<option value="${e(p.id)}" ${selected===p.id?'selected':''}>${e(p.name)}</option>`).join('');
function newProject() {
  if(actor().role==='member') {toast('当前身份不能创建项目，请切换到项目负责人或管理员。',true);return;}
  showModal('新建项目',`<p class="form-intro">先明确目标与团队，再拆解里程碑和任务。</p><div class="form-grid">${field('项目名称','name','','text','required maxlength="80" placeholder="例如：新产品上市计划"')}${field('项目类别','category','','text','maxlength="30" placeholder="例如：产品研发"')}${selectField('项目负责人','ownerId',userOptions(actorId,state.users.filter(u=>u.role!=='member'&&(isAdmin()||u.id===actorId))))}<div class="field"><label>项目成员</label><div class="member-checks">${state.users.map(u=>`<label class="checkbox-label"><input type="checkbox" name="memberIds" value="${e(u.id)}" ${u.id===actorId?'checked':''}>${e(u.name)}</label>`).join('')}</div></div>${field('开始日期','startDate',currentDay(),'date','required')}${field('计划截止日期','dueDate',shift(currentDay(),30),'date','required')}${textarea('项目目标与说明','description','这个项目要解决什么问题，最终交付什么？')}</div>`,'创建项目','createProject');
}
function newTask(projectId, selectedMilestoneId) {
  const ps=visibleProjects().filter(canManage),p=ps.find(p=>p.id===projectId)||ps[0]; if(!p){toast('请先创建你负责的项目。',true);return;}
  const ms=state.milestones.filter(m=>m.projectId===p.id&&m.status!=='done');
  if(!ms.length){showModal('先规划项目里程碑',`<p class="form-intro">${e(p.name)}</p><p>任务需要关联一个尚未完成的里程碑，确保所有交付都计入项目计划。请先申请新增大节点，待管理员批准后再创建任务。</p>`,'','',p.id,button('申请新增大节点','new-milestone',p.id,'primary','plus'));return;}
  const members=state.users.filter(u=>p.memberIds.includes(u.id)||u.id===p.ownerId), owner=members[0]?.id||actorId;
  showModal('新建任务',`<p class="form-intro">任务需要明确交付标准，由负责人提交、验收人确认。</p><div class="form-grid">${selectField('所属项目','projectId',projectOptions(p.id))}${selectField('所属里程碑','milestoneId',ms.map(m=>`<option value="${e(m.id)}">${e(m.title)}</option>`).join(''))}<div class="field full">${field('任务名称','title','','text','required maxlength="100" placeholder="例如：完成外观设计 V1"')}</div>${selectField('主负责人','ownerId',userOptions(owner,members))}${selectField('验收人','reviewerId',userOptions(p.ownerId===owner?state.users.find(u=>u.role==='admin'&&u.id!==owner)?.id:p.ownerId,state.users.filter(u=>u.id!==owner&&(p.memberIds.includes(u.id)||u.role==='admin'))))}${field('截止日期','dueDate',ms[0].dueDate<shift(currentDay(),3)?ms[0].dueDate:shift(currentDay(),3),'date',`required min="${e(p.startDate)}" max="${e(ms[0].dueDate)}"`)}${selectField('优先级','priority','<option value="normal">普通</option><option value="high">高</option><option value="low">低</option>')}${textarea('任务说明','description','说明工作范围和注意事项。',false)}${textarea('交付物与验收标准','acceptance','例如：提交三视图、尺寸及材料说明，负责人确认后通过。')}</div>`,'创建任务','createTask');
}
function newMilestone(projectId, milestoneId) {
  const p=visibleProjects().find(p=>p.id===projectId),m=milestoneId&&milestone(milestoneId);if(!p)return;
  if(m&&(m.projectId!==p.id||m.status==='done')){toast('已完成的大节点不能修改。',true);return;}
  if(m&&visibleNodeRequests().some(x=>x.milestoneId===m.id&&x.status==='pending')){toast('此节点已有待审批申请，请等待处理。',true);return;}
  const kind=m?'update':'create';
  showModal(m?'申请修改大节点':'申请新增大节点',`<p class="form-intro">${e(p.name)} · 管理员批准后才会更新正式计划。</p><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="milestoneId" value="${e(m?.id||'')}">${m?`<p class="node-approval-help">当前节点：${e(m.title)} · ${fullDate(m.dueDate)} 截止</p>`:''}<div class="form-grid"><div class="field full">${field('节点交付成果','title',m?.title||'','text','required maxlength="100" placeholder="例如：样机方案通过评审"')}</div>${field('节点截止日期','dueDate',m?.dueDate||p.dueDate,'date',`required min="${e(p.startDate)}" max="${e(p.dueDate)}"`)}${textarea('申请原因','reason',m?'说明调整节点或日期的原因。':'说明新增这个阶段的必要性和预期交付。')}</div><p class="field-help">节点日期须在项目周期内，且不得早于其下属任务的截止日期。超过项目截止日期时，先由项目负责人申请项目延期。批准不会自动调整小任务日期。</p>`,'提交申请','requestMilestone',p.id);
}
function reviewNodeRequest(id, approve) {
  const x=visibleNodeRequests().find(x=>x.id===id);if(!x||!isAdmin())return;
  showModal(approve?'批准大节点申请':'驳回大节点申请',`<p class="form-intro">${e(project(x.projectId)?.name)} · ${e(user(x.applicantId)?.name)} 提交</p>${requestComparison(x)}<div class="approval-reason"><span>申请原因</span><p>${e(x.reason)}</p></div><p class="field-help">${approve?'批准后更新正式节点；进度按已完成大节点的数量计算。':'驳回后保留当前计划，员工可根据审批意见重新提交。'}</p>${textarea('审批意见','comment',approve?'说明批准依据及执行要求。':'说明需要补充或调整的内容。')}`,approve?'确认批准并生效':'确认驳回',approve?'approveMilestoneRequest':'rejectMilestoneRequest',id);
}
function taskDetail(id) {
  const t=visibleTasks().find(t=>t.id===id);if(!t)return;
  const actions = t.status==='review'&&canReview(t)?`${button('退回修改','reject-task',id,'secondary')}${button('验收通过','approve-task',id,'primary','check')}`:canOperate(t)&&t.status!=='done'&&t.status!=='review'?`${t.status==='todo'?button('开始任务','start-task',id,'primary','arrow'):button('提交成果','submit-task',id,'primary','check')}`:'';
  showModal('任务详情',`<div class="task-detail-heading"><h3>${e(t.title)}</h3>${statusPill(t.status)}</div><p class="muted">${e(project(t.projectId)?.name)}${t.milestoneId?` · ${e(milestone(t.milestoneId)?.title)}`:''}</p><div class="task-detail-meta"><div><span>主负责人</span>${person(t.ownerId)}</div><div><span>验收人</span>${person(t.reviewerId)}</div><div><span>截止日期</span><strong>${fullDate(t.dueDate)}</strong>${t.dueDate!==t.originalDueDate?`<small>原定 ${fullDate(t.originalDueDate)}</small>`:''}</div></div><div class="detail-text"><h4>任务说明</h4><p>${e(t.description || '暂无补充说明')}</p><h4>交付物与验收标准</h4><p>${e(t.acceptance)}</p>${t.deliverable?`<h4>已提交成果</h4><p class="preserve-space">${e(t.deliverable)}</p><span class="cell-subtext">提交时间：${fullDate(t.submittedAt)}</span>`:''}${t.reviewComment?`<h4>验收意见</h4><p>${e(t.reviewComment)}</p>`:''}</div>`, '', '', id, actions);
  modal.querySelector('.modal-footer > button[data-action="close-modal"]').textContent='关闭';
}
function submitTask(id) {
  const t=task(id);showModal('提交任务成果',`<p class="form-intro">${e(t.title)}</p><div class="notice info"><span>验收标准：${e(t.acceptance)}</span></div>${textarea('成果说明或交付链接','deliverable','描述已完成的工作，并填写文件链接或交付结果。提交后由验收人确认。',true,t.deliverable||'')}<p class="field-help">此框架支持文字与链接记录，暂未接入附件上传。</p>`,'提交验收','submitTask',id);
}
function reviewTask(id,approve) { const t=task(id);showModal(approve?'确认验收通过':'退回任务修改',`<p class="form-intro">${e(t.title)}</p><div class="notice info"><span>交付成果：${e(t.deliverable)}</span></div>${textarea('验收意见','comment',approve?'说明通过验收的依据。':'请明确指出需要修改的内容。',!approve)}` ,approve?'验收通过':'退回修改',approve?'approveTask':'rejectTask',id); }
function extensionFields(projectId) {
  const p=project(projectId),ms=state.milestones.filter(m=>m.projectId===p.id&&m.status!=='done'),ts=state.tasks.filter(t=>t.projectId===p.id&&t.status!=='done');
  return `<div class="date-current"><span>当前截止日期</span><strong>${fullDate(p.dueDate)}</strong><span>原计划 ${fullDate(p.originalDueDate)}</span></div>${field('申请的新截止日期','newDueDate',shift(p.dueDate,7),'date',`required min="${shift(p.dueDate,1)}"`)}<p class="field-help">勾选需要同步调整的节点或任务，并分别填写新日期。未勾选的日期保持原值。</p><div class="reschedule-list">${ms.map(m=>rescheduleRow('milestone',m)).join('')}${ts.map(t=>rescheduleRow('task',t)).join('')}${!ms.length&&!ts.length?'<p class="muted">当前没有未完成的节点或任务。</p>':''}</div>`;
}
function rescheduleRow(kind,item) { return `<div class="reschedule-row"><label class="checkbox-label"><input type="checkbox" name="${kind}Ids" value="${e(item.id)}" data-reschedule="${e(item.id)}"><span><strong>${kind==='milestone'?'节点':'任务'} · ${e(item.title)}</strong><small>当前 ${fullDate(item.dueDate)}</small></span></label><input aria-label="${e(item.title)}的新截止日期" type="date" name="date-${e(item.id)}" value="${e(item.dueDate)}" data-reschedule-date="${e(item.id)}" disabled></div>`; }
function newExtension(projectId) {
  const ps=visibleProjects().filter(canManage),p=ps.find(p=>p.id===projectId)||ps[0];if(!p){toast('当前身份没有可申请延期的项目。',true);return;}
  showModal('申请项目延期',`<p class="form-intro">填写特殊原因和后续安排，由另一位管理员审批后生效。</p>${selectField('申请延期的项目','projectId',projectOptions(p.id))}<div id="extension-dates">${extensionFields(p.id)}</div><div class="form-grid">${textarea('延期原因','reason','说明造成延期的特殊情况。')}${textarea('后续推进安排','plan','如何解决问题，延长期间将完成哪些工作？')}${textarea('影响范围','impact','对交付、人员安排和其他项目有什么影响？')}</div>`,'提交延期申请','requestExtension');
}
function reviewExtension(id,approve) { const x=state.extensions.find(x=>x.id===id);showModal(approve?'批准项目延期':'驳回延期申请',`<p class="form-intro">${e(project(x.projectId)?.name)}</p><div class="date-change"><div class="date-box"><span>当前截止</span><strong>${fullDate(x.originalDueDate)}</strong></div>${icon('arrow')}<div class="date-box"><span>申请调整至</span><strong>${fullDate(x.newDueDate)}</strong></div></div><p class="field-help">${approve?`批准后同步修改 ${(x.affectedMilestones||[]).length} 个节点与 ${(x.affectedTasks||[]).length} 项任务，保留原始截止日期。`:'驳回后所有日期保持不变，申请人可查看审批意见。'}</p>${textarea('审批意见','comment',approve?'说明批准理由及需要注意的事项。':'请说明驳回原因及建议。')}`,approve?'确认批准':'确认驳回',approve?'approveExtension':'rejectExtension',id); }

function dataForExport() {
  if(isAdmin()) return state;
  const projects=visibleProjects(),ids=new Set(projects.map(p=>p.id));
  const tasks=visibleTasks(),milestones=visibleMilestones(),extensions=visibleExtensions(),logs=state.logs.filter(l=>ids.has(l.projectId));
  const users=new Set(projects.flatMap(p=>[p.ownerId,...p.memberIds]));users.add(actorId);
  tasks.forEach(t=>[t.ownerId,t.reviewerId].forEach(id=>users.add(id)));
  extensions.forEach(x=>[x.applicantId,x.reviewerId].forEach(id=>users.add(id)));
  logs.forEach(l=>users.add(l.actorId));
  return {...state,projects,tasks,milestones,extensions,logs,users:state.users.filter(u=>users.has(u.id))};
}
function exportFile(name,body,type) {const blob=new Blob([body],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('文件已生成，请查看浏览器下载。');}
function exportWeek() {const {r,ts,ms,done,late}=reportData();const lines=[`# 鼎峰项目周报`,`${r.start} — ${r.end}`,'',`统计范围：${isAdmin()?'所有项目':`${actor().name} 可见项目`}`,'',`## 本周概况`,`- 到期任务：${ts.length} 项`,`- 已验收完成：${done.length} 项`,`- 周节点达成：${ms.filter(m=>m.status==='done').length}/${ms.length}`,`- 逾期任务：${late.length} 项`,'','## 已完成工作',...done.map(t=>`- ${t.title}（${user(t.ownerId)?.name}；${project(t.projectId)?.name}）`),'','## 本周里程碑',...ms.map(m=>`- ${m.title}：${m.status==='done'?'已达成':'未达成'}；截止 ${m.dueDate}`),'','## 逾期待跟进',...late.map(t=>`- ${t.title}：${`超过截止日期 ${t.dueDate}`}`),'','## 下周到期任务',...visibleTasks().filter(t=>inRange(t.dueDate,{start:shift(r.start,7),end:shift(r.end,7)})).map(t=>`- ${t.title}（${user(t.ownerId)?.name}；${t.dueDate}）`),'','## 负责人补充与确认','请补充延期原因、需要协调的资源与下周重点。','','此文件根据当前可见的云端项目数据自动汇总。'];exportFile(`鼎峰周报_${r.start}.md`,lines.join('\n'),'text/markdown;charset=utf-8');}

document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();document.querySelector('#content')?.focus();return;}
  const el=event.target.closest('[data-action]');if(!el)return;const {action,id}=el.dataset;
  if(el.closest('form')&&el.type!=='submit')event.preventDefault();
  try {
    if(action==='reload-session'){await loadSession();if(state&&route()[0]==='accounts')await loadAccounts();return;}
    if(action==='refresh-accounts'){await loadAccounts();return;}
    if(!state)return;
    if(action==='flow-filter'){flowScope=['all','week','mine'].includes(id)?id:'all';renderContent();document.querySelector(`[data-action="flow-filter"][data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});return;}
    if(action==='flow-toggle'){const viewport=document.querySelector('.flow-scroll'),pos=viewport&&[viewport.scrollLeft,viewport.scrollTop];expandedFlowIds.has(id)?expandedFlowIds.delete(id):expandedFlowIds.add(id);renderContent();const next=document.querySelector('.flow-scroll');if(next&&pos){next.scrollLeft=pos[0];next.scrollTop=pos[1];}document.querySelector(`[data-action="flow-toggle"][data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});return;}
    if(action==='new-account')return newAccount();
    if(action==='edit-account')return editAccount(id);
    if(action==='export-legacy'){const old=localStorage.getItem(LEGACY_KEY);if(old)exportFile('鼎峰旧版浏览器备份.json',old,'application/json;charset=utf-8');return;}
    if(action==='close-modal'){modal.close();return;}
    if(action==='new-project')return newProject();
    if(action==='new-task'){newTask(id,el.dataset.milestoneId);if(el.dataset.milestoneId){const f=modal.querySelector('form[data-form="createTask"]');if(f){f.elements.milestoneId.value=el.dataset.milestoneId;const m=milestone(el.dataset.milestoneId);if(m){f.elements.dueDate.max=m.dueDate;if(f.elements.dueDate.value>m.dueDate)f.elements.dueDate.value=m.dueDate;}}}return;}
    if(action==='new-milestone')return newMilestone(id);
    if(action==='edit-milestone')return newMilestone(milestone(id)?.projectId,id);
    if(action==='approve-node-request'||action==='reject-node-request')return reviewNodeRequest(id,action==='approve-node-request');
    if(action==='approval-kind'){approvalKind=id;approvalFilter='pending';renderContent();return;}
    if(action==='new-extension')return newExtension(id);
    if(action==='new-user')return newAccount();
    if(action==='milestone-detail')return milestoneDetail(id);
    if(action==='project-view'){projectView=id;renderContent();return;}
    if(action==='task-detail')return taskDetail(id);
    if(action==='submit-task')return submitTask(id);
    if(action==='approve-task'||action==='reject-task')return reviewTask(id,action==='approve-task');
    if(action==='approve-extension'||action==='reject-extension')return reviewExtension(id,action==='approve-extension');
    if(action==='start-task')return await commit('updateTask',{id,status:'doing'},'任务已开始，进度已保存。');
    if(action==='complete-milestone')return showModal('确认节点达成',`<p class="form-intro">${e(milestone(id)?.title)}</p><p>确认这个节点的交付成果已达到要求。系统会检查所有关联任务是否已验收，确认后计入项目总进度。</p>`,'确认达成','completeMilestone',id);
    if(action==='project-filter'){projectFilter=id;renderContent();return;}
    if(action==='task-filter'){taskFilter=id;renderContent();return;}
    if(action==='approval-filter'){approvalFilter=id;renderContent();return;}
    if(action==='previous-week'){weekOffset--;renderContent();return;}
    if(action==='next-week'){weekOffset++;renderContent();return;}
    if(action==='current-week'){weekOffset=0;renderContent();return;}
    if(action==='show-overdue'){taskFilter='overdue';location.hash='tasks';if(route()[0]==='tasks')render();return;}
    if(action==='clear-search'){searchTerm='';render();return;}
    if(action==='export-week')return exportWeek();
    if(action==='export-data')return exportFile(`鼎峰管理平台备份_${currentDay()}.json`,JSON.stringify(dataForExport(),null,2),'application/json;charset=utf-8');

  } catch(error){toast(error.message,true);}
});
document.addEventListener('submit',async event=>{
  const form=event.target.closest('form[data-form]');if(!form)return;event.preventDefault();const data=new FormData(form),payload=Object.fromEntries(data),action=form.dataset.form,id=form.dataset.id;const err=form.querySelector('.form-error');
  try {
    if(action==='create-account'||action==='edit-account')return await saveAccount(action,payload,id);
    if(action==='createProject'){payload.memberIds=data.getAll('memberIds');return await commit(action,payload,'项目已创建，可以开始添加里程碑与任务。');}
    if(action==='createTask'){return await commit(action,payload,'任务已创建并分配。');}
    if(action==='requestMilestone')return await commit(action,{...payload,projectId:id},'申请已提交，管理员批准后才生效。');
    if(action==='approveMilestoneRequest'||action==='rejectMilestoneRequest')return await commit('reviewMilestoneRequest',{id,approve:action==='approveMilestoneRequest',comment:payload.comment},action==='approveMilestoneRequest'?'申请已批准，正式节点已更新。':'申请已驳回，当前计划保持不变。');
    if(action==='submitTask')return await commit(action,{id,deliverable:payload.deliverable},'成果已提交，等待验收。');
    if(action==='approveTask'||action==='rejectTask')return await commit('reviewTask',{id,approve:action==='approveTask',comment:payload.comment},action==='approveTask'?'任务已通过验收。':'任务已退回，等待负责人修改。');
    if(action==='completeMilestone')return await commit(action,{id},'里程碑已达成，项目总进度已更新。');
    if(action==='requestExtension'){payload.affectedTasks=data.getAll('taskIds').map(id=>({id,newDueDate:data.get(`date-${id}`)}));payload.affectedMilestones=data.getAll('milestoneIds').map(id=>({id,newDueDate:data.get(`date-${id}`)}));return await commit(action,payload,'延期申请已提交，等待管理员审批。');}
    if(action==='approveExtension'||action==='rejectExtension')return await commit('reviewExtension',{id,approve:action==='approveExtension',comment:payload.comment},action==='approveExtension'?'延期已批准，相关计划已同步更新。':'延期申请已驳回，原计划保持不变。');

  } catch(error){if(err&&modal.open){err.hidden=false;err.textContent=error.message;err.scrollIntoView({block:'nearest'});}else toast(error.message,true);}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='flow-project-select'){flowProjectId=el.value;projectView='flow';expandedFlowIds.clear();renderContent();return;}

  if(el.dataset.reschedule){const input=modal.querySelector(`[data-reschedule-date="${CSS.escape(el.dataset.reschedule)}"]`);if(input){input.disabled=!el.checked;input.required=el.checked;}return;}
  const form=el.closest('form');if(!form)return;
  if(form.dataset.form==='create-account'&&el.name==='existingUserId'){const u=user(el.value);if(u){form.elements.name.value=u.name;form.elements.role.value=u.role;form.elements.title.value=u.title||'';form.elements.department.value=u.department||'';}return;}
  if(el.name==='projectId'&&form.dataset.form==='requestExtension'){document.querySelector('#extension-dates').innerHTML=extensionFields(el.value);return;}
  if(form.dataset.form==='createTask'&&el.name==='projectId'){
    const p=project(el.value),ms=state.milestones.filter(m=>m.projectId===p.id&&m.status!=='done');
    if(!ms.length){newTask(p.id);return;}
    form.elements.milestoneId.innerHTML=ms.map(m=>`<option value="${e(m.id)}">${e(m.title)}</option>`).join('');
    form.elements.ownerId.innerHTML=userOptions('',state.users.filter(u=>p.memberIds.includes(u.id)||u.id===p.ownerId));
    form.elements.reviewerId.innerHTML=userOptions(p.ownerId,state.users.filter(u=>u.id!==form.elements.ownerId.value&&(p.memberIds.includes(u.id)||u.role==='admin')));
    const due=ms[0].dueDate;form.elements.dueDate.max=due;if(form.elements.dueDate.value>due)form.elements.dueDate.value=due;return;
  }
  if(form.dataset.form==='createTask'&&el.name==='ownerId'){form.elements.reviewerId.innerHTML=userOptions(project(form.elements.projectId.value)?.ownerId,state.users.filter(u=>u.id!==el.value&&(project(form.elements.projectId.value)?.memberIds.includes(u.id)||u.role==='admin')));return;}
  if(form.dataset.form==='createTask'&&el.name==='milestoneId'){const due=milestone(el.value)?.dueDate||project(form.elements.projectId.value)?.dueDate;form.elements.dueDate.max=due;if(form.elements.dueDate.value>due)form.elements.dueDate.value=due;}
});
document.addEventListener('input',event=>{if(event.target.id==='global-search'){searchTerm=event.target.value;renderContent();}});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();document.querySelector('#global-search')?.focus();}});
window.addEventListener('hashchange',()=>{searchTerm='';modal.close();render();if(route()[0]==='accounts')loadAccounts();window.scrollTo({top:0,behavior:'instant'});});

modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();}});
app.innerHTML='<div class="session-loading" role="status">正在载入你的工作台…</div>';
await loadSession();
setInterval(()=>{if(state&&!document.hidden&&!modal.open&&!saving&&route()[0]!=='accounts'&&!searchTerm)loadSession(true);},45000);
