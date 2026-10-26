import { renderProjectFlow, bindFlowCanvas } from './flow.js';
import { today, addDays, weekRange, projectProgress, progressAgainstPlan, memberStats } from './domain.js';
import { datePart, deadlineMs, isOverdue, formatDateTime, toDateTimeInput } from './time.js';
import { renderProgressTrack, renderProgressNote } from './progress.js';
import { renderMilestoneProgress } from './milestone-progress.js';
import { renderTeamAnalytics } from './team-analytics.js';
import { canAccessRoute } from './access.js';
import { renderMilestoneRequestCard, requestComparison } from './milestone-requests.js';
import { renderProjectTeam, renderProjectPeopleSummary } from './project-team.js';
import { renderInstallCard, initPWA } from './pwa.js';
import { notificationCount, unreadBadge, renderNotificationList } from './notifications.js';

const LEGACY_KEY = 'dinfon.management.v1';
const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const toastEl = document.querySelector('#toast');
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e = escapeHTML;
const currentDay = () => today();
const shift = (date, days) => addDays(datePart(date), days);
let state = null, actorId = '', revision = 0, accountInfo = null, accountsData = null, accountsLoading = false;
let renderedTiming = '', sessionEpoch = 0, authBusy = false;
let notifications = [], notificationReads = new Set(), acknowledgedNotifications = new Set();
let storageIssue = '', toastTimer, weekOffset = 0, taskFilter = 'mine', projectFilter = 'all', approvalFilter = 'pending', approvalKind = 'nodes', searchTerm = '', flowProjectId = '', projectView = 'flow', flowScope = 'all', expandedFlowIds = new Set(), saving = false;
async function api(path, options = {}) {
  const response = await fetch(path, {credentials:'same-origin', cache:'no-store', ...options, headers:{'Content-Type':'application/json', ...(options.headers||{})}});
  const data = await response.json().catch(()=>({error:'服务器响应异常，请稍后重试。'}));
  if(!response.ok){const error=new Error(data.error || data.message || '操作未成功，请重试。');error.status=response.status;error.code=data.code;throw error;}
  return data;
}
function acceptSession(data) {
  if(accountInfo?.id !== data.account?.id){acknowledgedNotifications.clear();notificationReads.clear();}
  notifications=(data.notifications||[]).filter(item=>!acknowledgedNotifications.has(item.id));
  accountInfo=data.account; actorId=data.actor.id; revision=data.revision;
  if(data.mustChangePassword||data.account?.mustChangePassword){state=null;accountsData=null;notifications=[];passwordChangeScreen();return false;}
  state=data.state; state.milestoneRequests ||= []; return true;
}
function clearLocalSession() {
  notifications=[];notificationReads.clear();acknowledgedNotifications.clear();
  sessionEpoch++;state=null;actorId='';revision=0;accountInfo=null;accountsData=null;accountsLoading=false;
  searchTerm='';flowProjectId='';projectView='flow';expandedFlowIds.clear();storageIssue='';
  modal.close();modal.innerHTML='';clearTimeout(toastTimer);toastEl.hidden=true;
}
function authBrand() {return `<div class="auth-brand"><span class="auth-symbol">${icon('grid')}</span><div>鼎峰<small>协同管理平台</small></div></div>`;}
function authScreen(message='', denied=false) {
  clearLocalSession();document.title='登录 · 鼎峰协同管理';
  app.innerHTML=`<main class="auth-page" id="content" tabindex="-1">${authBrand()}<section class="auth-card"><span class="account-eyebrow">团队工作空间</span><h1>欢迎回来</h1><p>使用公司分配的账号，继续今天的工作。</p>${message?`<p class="auth-notice ${denied?'is-error':''}" role="${denied?'alert':'status'}">${e(message)}</p>`:''}<form data-form="login" class="auth-form"><div class="field"><label for="login-name">账号</label><input id="login-name" name="login" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="64" placeholder="用户名、手机号或邮箱"></div><div class="field"><label for="login-password">密码</label><input id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="128" placeholder="请输入密码"></div><p class="form-error" role="alert" hidden></p><button type="submit" class="button primary">登录工作空间</button></form><p class="auth-help">账号由管理员开通。忘记密码时，请联系公司管理员重置。</p><div class="auth-access-summary"><span>${icon('users')}各自账号，各自权限</span><span>${icon('grid')}员工仅查看参与项目</span></div></section><div class="auth-install">${renderInstallCard()}</div><p class="auth-footer">电脑与手机，共用一个工作空间。</p></main>`;
}
function passwordFields() {
  return `${field('当前密码','currentPassword','','password','required maxlength="128" autocomplete="current-password"')}${field('新密码','newPassword','','password','required minlength="12" maxlength="128" autocomplete="new-password" aria-describedby="password-help"')}${field('再次输入新密码','confirmPassword','','password','required minlength="12" maxlength="128" autocomplete="new-password"')}<p id="password-help" class="field-help">使用 12–128 个字符，可使用一句容易记住的短语。新密码应与当前密码不同。</p>`;
}
function passwordChangeScreen() {
  modal.close();modal.innerHTML='';document.title='设置新密码 · 鼎峰协同管理';
  app.innerHTML=`<main class="auth-page" id="content" tabindex="-1">${authBrand()}<section class="auth-card"><span class="account-eyebrow">保护你的账号</span><h1>先设置你的新密码</h1><p>你正在使用初始密码或重置密码。设置后即可进入工作空间。</p><div class="auth-account-label"><span>当前账号</span><strong>${e(accountInfo?.login||'')}</strong></div><form data-form="change-password" class="auth-form"><input type="hidden" name="username" autocomplete="username" value="${e(accountInfo?.login||'')}">${passwordFields()}<p class="form-error" role="alert" hidden></p><button type="submit" class="button primary">保存并进入工作空间</button></form><button type="button" class="button ghost auth-switch" data-action="logout">退出当前账号</button></section></main>`;
}
function enterWorkspace() {
  if(!state)return;
  if(!location.hash||!canAccessRoute(actor(),route()[0]))history.replaceState(null,'',isAdmin()?'#overview':'#tasks');
  render();
}
async function submitAuth(form,payload,action) {
  if(authBusy)return;
  const changing=action==='change-password';
  if(changing&&payload.newPassword!==payload.confirmPassword)throw new Error('两次输入的新密码不一致，请重新确认。');
  if(changing&&payload.newPassword===payload.currentPassword)throw new Error('新密码不能与当前密码相同。');
  authBusy=true;const submit=form.querySelector('[type="submit"]'),label=submit.textContent;submit.disabled=true;submit.textContent=changing?'正在保存…':'正在登录…';form.setAttribute('aria-busy','true');
  try {
    const data=await api(changing?'/api/auth/password':'/api/auth/login',{method:'POST',body:JSON.stringify(changing?{currentPassword:payload.currentPassword,newPassword:payload.newPassword}:{login:payload.login.trim(),password:payload.password})});
    sessionEpoch++;accountsData=null;form.reset();
    if(acceptSession(data)){modal.close();modal.innerHTML='';enterWorkspace();if(changing)toast('新密码已保存，其他设备需要重新登录。');}
  } catch(error) {
    if(!changing){form.elements.password.value='';form.elements.password.focus();}
    else if(error.status===401){authScreen('登录已失效，请重新登录。');return;}
    throw error;
  } finally {authBusy=false;submit.disabled=false;submit.textContent=label;form.removeAttribute('aria-busy');}
}
async function logout() {
  if(authBusy)return;authBusy=true;sessionEpoch++;
  const buttons=document.querySelectorAll('[data-action="logout"]');buttons.forEach(el=>el.disabled=true);
  try{await api('/api/auth/logout',{method:'POST',body:'{}'});history.replaceState(null,'',location.pathname+location.search);authScreen('你已退出当前账号。');}
  catch{throw new Error('退出未完成，请检查网络后重试。');}
  finally{authBusy=false;buttons.forEach(el=>el.disabled=false);}
}
function changePassword() {
  showModal('修改密码',`<p class="form-intro">修改后，其他设备需要使用新密码重新登录。</p><input type="hidden" name="username" autocomplete="username" value="${e(accountInfo?.login||'')}">${passwordFields()}`,'保存新密码','change-password');
}
async function loadSession(silent=false) {
  const epoch=sessionEpoch;
  try{const data=await api('/api/session');if(epoch!==sessionEpoch)return;const wasReady=!!state,changed=data.revision!==revision,previousNotices=notifications.map(n=>n.id).join(',');if(!acceptSession(data))return;storageIssue='';const noticesChanged=previousNotices!==notifications.map(n=>n.id).join(',');if(!wasReady&&!location.hash)history.replaceState(null,'',isAdmin()?'#overview':'#tasks');if(!silent||((changed||noticesChanged||renderedTiming!==timingSignature())&&!modal.open))render();}
  catch(error){if(epoch!==sessionEpoch)return;if(error.status===401)authScreen();else if(error.status===403)authScreen(error.message,true);else if(!state)authScreen(error.message);else if(!silent)toast(error.message,true);}
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
const overdue = t => t.status !== 'done' && isOverdue(t.dueDate);
const canReview = t => t.ownerId !== actorId && (isAdmin() || t.reviewerId === actorId);
const canOperate = t => t.ownerId === actorId || isAdmin() || project(t.projectId)?.ownerId === actorId;
function range() {
  const d = shift(currentDay(), weekOffset * 7);
  const result = weekRange(d);
  return Array.isArray(result) ? {start: result[0], end: result[1]} : result;
}
const inRange = (value, r = range()) => {const day=datePart(value);return day&&day>=r.start&&day<=r.end;};
const dateLabel = value => formatDateTime(value,{compact:true});
const fullDate = value => formatDateTime(value);
const dayLabel = value => formatDateTime(value,{legacyLabel:false});
const shortDate = value => formatDateTime(value,{compact:true,legacyLabel:false});
const scheduleInput = value => toDateTimeInput(value,'23:00');
const offsetInput = (value, days) => `${shift(value,days)}T${toDateTimeInput(value,'18:00').slice(11)}`;
const nextHourInput = value => toDateTimeInput(new Date((Math.floor(deadlineMs(value)/3600000)+1)*3600000).toISOString());
const timingSignature = () => state ? `${currentDay()}|${[...visibleProjects(),...visibleMilestones(),...visibleTasks()].filter(item=>isOverdue(item.dueDate)).map(item=>item.id).sort().join(',')}` : '';
const durationLabel = (from,to) => {const hours=Math.max(0,(deadlineMs(to)-deadlineMs(from))/3600000);return hours<24?`${Number(hours.toFixed(1))} 小时`:`${Number((hours/24).toFixed(1))} 天`;};
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
  bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.grid}</svg>`;
const avatar = (id, extra = '') => { const u = user(id); return `<span class="avatar ${extra}" title="${e(u?.name || '未分配')}" style="--avatar-color:${safeColor(u?.color)}">${e(u?.name?.slice(-2) || '?')}</span>`; };
const safeColor = value => /^#[0-9a-f]{3,8}$/i.test(value || '') ? value : '#34776f';
const person = id => `<span class="person-cell">${avatar(id)}<span><span class="person-name">${e(user(id)?.name || '未分配')}</span></span></span>`;
const button = (label, action, id = '', className = 'secondary', iconName = '') => `<button type="button" class="button ${className}" data-action="${action}"${id ? ` data-id="${e(id)}"` : ''}>${iconName ? icon(iconName) : ''}${label}</button>`;
const empty = (title, text, action = '') => `<div class="empty-state">${icon('check')}<h3>${title}</h3><p>${text}</p>${action}</div>`;
const progress = p => { const metrics = progressAgainstPlan(state.tasks.filter(t=>t.projectId===p.id)); return `<div class="project-progress"><div class="progress-label"><span>任务完成率</span><strong>${metrics.total?`${metrics.actual}%`:'—'}</strong></div>${renderMilestoneProgress(state,p.id,{compact:true,basis:'tasks'})}${renderProgressNote(metrics)}</div>`; };
function projectStatus(p) {
  if (projectProgress(state,p.id) >= 100) return statusPill('done');
  if (state.extensions.some(x => x.projectId === p.id && x.status === 'pending')) return statusPill('pending', '延期审批中');
  if (isOverdue(p.dueDate)) return statusPill('overdue');
  if (deadlineMs(p.dueDate) > deadlineMs(p.originalDueDate)) return statusPill('approved', '已批准延期');
  return statusPill('doing');
}
const projectMark = p => `<span class="project-symbol" style="--project-color:${safeColor(p.color)}">${icon('grid')}</span>`;
function toast(message, error = false) {
  clearTimeout(toastTimer); toastEl.hidden = false; toastEl.classList.toggle('error', error); toastEl.textContent = message;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}
function unreadSlot(filter={}) {
  return `<span class="unread-slot" data-unread-category="${e(filter.category||'')}" data-unread-entity="${e(filter.entityId||'')}" data-unread-project="${e(filter.projectId||'')}">${unreadBadge(notificationCount(notifications,filter))}</span>`;
}
const navigationUnread = id => ['overview','tasks','approvals'].includes(id) ? unreadSlot({category:id==='overview'?'projects':id}) : '';
function refreshUnreadBadges() {
  document.querySelectorAll('.unread-slot').forEach(slot=>{
    const filter={category:slot.dataset.unreadCategory,entityId:slot.dataset.unreadEntity,projectId:slot.dataset.unreadProject};
    slot.innerHTML=unreadBadge(notificationCount(notifications,filter));
  });
}
async function markNotificationsRead(ids,{silent=false}={}) {
  const pending=ids.filter(id=>notifications.some(item=>item.id===id)&&!notificationReads.has(id));
  if(!pending.length)return;
  const epoch=sessionEpoch;
  pending.forEach(id=>notificationReads.add(id));
  try {
    for(let offset=0;offset<pending.length;offset+=1000){
      const batch=pending.slice(offset,offset+1000);
      await api('/api/notifications/read',{method:'POST',body:JSON.stringify({ids:batch})});
      if(epoch!==sessionEpoch)return;
      batch.forEach(id=>acknowledgedNotifications.add(id));
      notifications=notifications.filter(item=>!acknowledgedNotifications.has(item.id));
      refreshUnreadBadges();
    }
  } catch(error) {if(epoch===sessionEpoch&&!silent)toast('未读状态未保存，请稍后重试。',true);}
  finally{if(epoch===sessionEpoch)pending.forEach(id=>notificationReads.delete(id));}
}
function readEntityNotifications(category,entityId) {
  void markNotificationsRead(notifications.filter(item=>item.category===category&&item.entityId===entityId).map(item=>item.id),{silent:true});
}
function readVisibleNotifications(page,id) {
  if(searchTerm||!state)return;
  let visible=[];
  if(page==='overview'||(page==='projects'&&id)) visible=notifications.filter(item=>item.category==='projects'&&item.projectId===flowProjectId);
  if((page==='overview'||(page==='projects'&&id))&&projectView==='requests'){
    const ids=new Set(visibleNodeRequests().filter(item=>item.projectId===flowProjectId).map(item=>item.id));
    visible.push(...notifications.filter(item=>item.category==='approvals'&&ids.has(item.entityId)));
  }
  if(page==='approvals') {
    const records=approvalKind==='nodes'?visibleNodeRequests():visibleExtensions();
    const ids=new Set(records.filter(item=>approvalFilter==='all'||item.status===approvalFilter).map(item=>item.id));
    visible=notifications.filter(item=>item.category==='approvals'&&ids.has(item.entityId));
  }
  if(visible.length)void markNotificationsRead(visible.map(item=>item.id),{silent:true});
}
function notificationCenter() {
  showModal('通知',renderNotificationList(notifications,fullDate),'','','',notifications.length?button('全部已读','read-all-notifications','','ghost'):'');
}
async function openNotification(id) {
  const item=notifications.find(item=>item.id===id);if(!item)return;
  modal.close();searchTerm='';
  if(item.category==='tasks'&&task(item.entityId)){taskDetail(item.entityId);return;}
  if(item.category==='approvals'){
    approvalKind=state.extensions.some(x=>x.id===item.entityId)?'extensions':'nodes';approvalFilter='all';
    history.replaceState(null,'','#approvals');render();
  } else if(visibleProjects().some(p=>p.id===item.projectId)) {
    projectView='flow';flowProjectId=item.projectId;history.replaceState(null,'',`#projects/${encodeURIComponent(item.projectId)}`);render();
  } else toast('这条消息对应的内容已不可查看。');
  await markNotificationsRead([id]);
}
async function commit(action, payload, message) {
  if(saving)return;
  const epoch=sessionEpoch,previousProjectIds=action==='createProject'?new Set(state.projects.map(p=>p.id)):null;
  saving=true; const submit=modal.querySelector('[type="submit"]');if(submit)submit.disabled=true;
  try {const data=await api('/api/command',{method:'POST',body:JSON.stringify({action,payload,revision})});if(epoch!==sessionEpoch)return;acceptSession(data);storageIssue='';modal.close();if(previousProjectIds){const created=state.projects.find(p=>!previousProjectIds.has(p.id));if(created){flowProjectId=created.id;projectView='flow';location.hash=`projects/${created.id}`;}}render();toast(message);}
  catch(error){if(error.status===409){await loadSession(true);error.message+=' 已刷新最新数据，请核对后重试。';}if(error.status===401||error.status===403)await loadSession(true);throw error;}
  finally{saving=false;if(submit)submit.disabled=false;}
}
const routes = [{id:'overview',name:'项目中心',icon:'grid'},{id:'tasks',name:'我的任务',icon:'task'},{id:'weekly',name:'周计划与汇总',icon:'calendar'},{id:'approvals',name:'审批中心',icon:'approval'},{id:'team',name:'团队与效能',icon:'users'},{id:'accounts',name:'账号管理',icon:'users'},{id:'my-account',name:'我的账号',icon:'settings'}];
function route() {
  const parts=(location.hash.slice(1) || (isAdmin()?'overview':'tasks')).split('/');
  if(parts[0]==='dashboard'){history.replaceState(null,'','#overview');return ['overview'];}
  return parts;
}
const navigationPage = page => page === 'projects' ? 'overview' : page;
const pageTitle = page => page === 'projects' ? (route()[1] ? '项目中心' : '全部项目 · 项目中心') : routes.find(r=>r.id===page)?.name || '平台设置';
function navigationRoutes() {const list=routes.filter(r=>canAccessRoute(actor(),r.id));return isAdmin()?list:list.sort((a,b)=>['tasks','overview','weekly','approvals','my-account'].indexOf(a.id)-['tasks','overview','weekly','approvals','my-account'].indexOf(b.id)).map(r=>r.id==='approvals'?{...r,name:'申请记录'}:r);}
function render() {
  if(!state)return;
  const [page] = route(), activePage=navigationPage(page), a = actor(), nav=navigationRoutes();
  const mobile=(isAdmin()?['overview','approvals','tasks','accounts','my-account'].map(id=>routes.find(r=>r.id===id)):nav);
  const navLink=r=>`<a href="#${r.id}" aria-label="${e(r.name)}" title="${e(r.name)}" class="nav-item ${activePage===r.id?'active':''}" ${activePage===r.id?'aria-current="page"':''}>${icon(r.icon)}<span class="nav-label">${r.name}</span>${navigationUnread(r.id)}</a>`;
  app.innerHTML = `<div class="app-shell ${isAdmin()?'admin-workspace':'employee-workspace'}"><aside class="sidebar"><a href="#${isAdmin()?'overview':'tasks'}" class="brand" aria-label="鼎峰工作台首页"><span class="brand-symbol">${icon('grid')}</span><span class="brand-word">鼎峰<span class="brand-subtitle">协同管理平台</span></span></a><div class="workspace-switch">${isAdmin()?'管理工作台':'员工工作台'}</div><div class="nav-section-label">${isAdmin()?'工作空间':'我的工作'}</div><nav aria-label="主导航">${nav.filter(r=>r.id!=='my-account').map(navLink).join('')}</nav><div class="sidebar-bottom">${isAdmin()?`<a href="#settings" class="nav-item ${page==='settings'?'active':''}">${icon('settings')}<span class="nav-label">平台设置</span></a>`:''}${navLink(routes.find(r=>r.id==='my-account'))}<div class="sync-note"><span class="demo-dot"></span>服务器保存 · 独立账号</div></div></aside><div class="shell-main"><header class="topbar"><div class="breadcrumb"><strong>${pageTitle(page)}</strong></div><div class="topbar-actions"><button type="button" class="notification-trigger icon-button" data-action="notifications" aria-label="查看通知">${icon('bell')}${unreadSlot()}</button><label class="searchbox">${icon('search')}<input type="search" id="global-search" placeholder="搜索项目、任务…" aria-label="搜索项目和任务" value="${e(searchTerm)}" autocomplete="off"><kbd>⌘ K</kbd></label><button class="button ghost small" data-action="reload-session" aria-label="刷新最新数据">刷新</button><a href="#my-account" class="signed-account" aria-label="我的账号">${avatar(a.id)}<span><strong>${e(a.name)}</strong><small>${roleLabel(a.role)}</small></span></a><button type="button" data-action="logout" class="signout-link" aria-label="退出登录">${icon('logout')}</button></div></header><main id="content" class="content" tabindex="-1"></main><nav class="mobile-nav" aria-label="移动端导航">${mobile.map(r=>`<a href="#${r.id}" aria-label="${e(r.name)}" title="${e(r.name)}" class="nav-item ${activePage===r.id?'active':''}" ${activePage===r.id?'aria-current="page"':''}>${icon(r.icon)}<span class="nav-label">${({overview:'项目中心',approvals:isAdmin()?'审批':'申请',tasks:'任务',weekly:'周计划',accounts:'账号','my-account':'我的'})[r.id]}</span>${navigationUnread(r.id)}</a>`).join('')}</nav></div></div>`;
  renderContent();
}
function renderContent() {
  const [page,id] = route();
  if(!canAccessRoute(actor(),page)){document.title='无访问权限 · 鼎峰协同管理';document.querySelector('#content').innerHTML=empty('当前账号没有此页面的访问权限','管理员与员工使用不同工作台。','<a class="button primary" href="#tasks">返回我的任务</a>');return;}
  let html;
  if (searchTerm.trim()) html = searchPage();
  else if (page === 'projects' && id) html = projectDetail(id);
  else html = ({overview:overviewPage,projects:projectsPage,tasks:tasksPage,weekly:weeklyPage,approvals:approvalsPage,team:teamPage,settings:settingsPage,accounts:accountsPage,'my-account':myAccountPage}[page] || overviewPage)();
  document.querySelector('#content').innerHTML = (storageIssue ? `<div class="notice warning">${icon('alert')}<span>${e(storageIssue)}</span></div>` : '') + html;
  renderedTiming=timingSignature();
  readVisibleNotifications(page,id);
  document.querySelectorAll('[data-project-flow]').forEach(bindFlowCanvas);
  document.title = `${searchTerm ? '搜索' : pageTitle(page)} · 鼎峰协同管理`;
}
function heading(title, subtitle, actions = '') { return `<div class="page-heading"><div><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`; }
function projectRow(p) {
  const tasks = state.tasks.filter(t => t.projectId === p.id);
  return `<a class="project-row" href="#projects/${e(p.id)}">${projectMark(p)}<div class="project-main"><h3>${e(p.name)}${unreadSlot({category:'projects',projectId:p.id})}</h3><div class="project-meta"><span>${e(p.code || '项目')}</span><span>${e(user(p.ownerId)?.name)}负责</span><span>${dateLabel(p.dueDate)}截止</span></div></div>${progress(p)}<div class="project-side">${projectStatus(p)}<span class="cell-subtext">${tasks.filter(t => t.status === 'done').length} / ${tasks.length} 项任务</span></div>${icon('chevron')}</a>`;
}
function projectsPage() {
  let projects = visibleProjects();
  const count = projects.length;
  if (projectFilter === 'active') projects = projects.filter(p => projectProgress(state,p.id) < 100);
  if (projectFilter === 'complete') projects = projects.filter(p => projectProgress(state,p.id) >= 100);
  if (projectFilter === 'delayed') projects = projects.filter(p => isOverdue(p.dueDate) || deadlineMs(p.dueDate) > deadlineMs(p.originalDueDate) || state.extensions.some(x => x.projectId === p.id && x.status === 'pending'));
  return heading('全部项目','选择项目，进入流程图查看节点和团队进度。', '<a class="button secondary" href="#overview">返回流程图</a>'+(actor().role !== 'member' ? button('新建项目','new-project','','primary','plus') : '')) + `<div class="filters"><div class="filter-tabs">${[['all',`全部项目 ${count}`],['active','进行中'],['delayed','延期关注'],['complete','已完成']].map(([id,label])=>`<button class="filter-tab ${projectFilter===id?'active':''}" data-action="project-filter" data-id="${id}">${label}</button>`).join('')}</div><span class="muted">${projects.length} 个项目</span></div><div class="project-grid">${projects.map(p => `<a class="project-card" href="#projects/${e(p.id)}"><div class="project-card-head">${projectMark(p)}${projectStatus(p)}</div><div class="project-card-title"><span class="cell-subtext">${e(p.code || p.category || '项目')}</span><h2>${e(p.name)}${unreadSlot({category:'projects',projectId:p.id})}</h2></div><p class="project-card-description">${e(p.description || '暂无项目说明')}</p>${progress(p)}<div class="project-card-footer"><div class="member-stack">${[...new Set([p.ownerId,...p.memberIds])].slice(0,4).map(id=>avatar(id)).join('')}</div><span>${dateLabel(p.dueDate)}截止</span></div></a>`).join('')}</div>${!projects.length ? empty('这里还没有项目','调整筛选条件，或创建一个新的项目。',actor().role !== 'member'?button('新建项目','new-project','','primary','plus'):'') : ''}`;
}
function taskRow(t, showProject = true) {
  return `<div class="task-row"><button class="task-state ${t.status === 'done'?'is-done':''}" data-action="task-detail" data-id="${e(t.id)}" aria-label="查看任务 ${e(t.title)}">${icon(t.status==='done'?'check':t.status==='review'?'approval':'task')}</button><div class="task-main"><button class="task-title ${t.status==='done'?'is-done':''}" data-action="task-detail" data-id="${e(t.id)}">${e(t.title)}${unreadSlot({category:'tasks',entityId:t.id})}</button><div class="task-meta">${showProject?`<span>${e(project(t.projectId)?.name)}</span>`:''}<span>${e(user(t.ownerId)?.name)}</span><span class="${overdue(t)?'overdue-text':''}">${dateLabel(t.dueDate)}截止${overdue(t)?' · 已逾期':''}</span>${t.priority==='high'?'<span class="priority-high">高优先级</span>':''}</div></div><div class="task-actions">${statusPill(t.status)}${t.status==='review' && canReview(t)?button('验收','task-detail',t.id,'small secondary'):t.ownerId===actorId && t.status==='doing'?button('提交成果','submit-task',t.id,'small secondary'):button('详情','task-detail',t.id,'small ghost')}</div></div>`;
}
function overviewPage() {
  const ps = visibleProjects();
  const p = ps.find(item=>item.id===flowProjectId) || ps[0];
  if(!p) return heading('项目中心','从一个项目开始，把目标拆成可交付的大小节点。',actor().role!=='member'?button('新建项目','new-project','','primary','plus'):'')+empty('暂无可查看的项目',actor().role==='member'?'管理员将你加入项目后，流程图会显示在这里。':'先创建项目组，再添加阶段节点和具体任务。');
  flowProjectId=p.id;
  return projectWorkspace(p);
}
function projectDetail(id) {
  const p=visibleProjects().find(item=>item.id===id);
  if(!p)return empty('无法查看此项目','当前身份没有访问权限，或项目不存在。','<a class="button secondary" href="#projects">返回项目列表</a>');
  flowProjectId=p.id;
  return projectWorkspace(p);
}
function projectWorkspace(p) {
  const ts=state.tasks.filter(t=>t.projectId===p.id),ms=state.milestones.filter(m=>m.projectId===p.id).sort((a,b)=>deadlineMs(a.dueDate)-deadlineMs(b.dueDate));
  const xs=state.extensions.filter(x=>x.projectId===p.id),pending=xs.find(x=>x.status==='pending'),approved=xs.filter(x=>x.status==='approved');
  const logs=state.logs.filter(l=>l.projectId===p.id).slice().sort((a,b)=>b.at.localeCompare(a.at)).slice(0,20);
  const taskMetrics=progressAgainstPlan(ts),done=taskMetrics.completed;
  const memberActions=isAdmin()?button('添加成员','add-project-member',p.id,'secondary','plus'):'';
  const actions=`${button('申请大节点','new-milestone',p.id,canManage(p)?'secondary':'primary','plus')}${canManage(p)?`${button('添加任务','new-task',p.id,'primary','plus')}<details class="project-more"><summary class="button secondary">更多 ${icon('chevron')}</summary><div class="project-more-menu">${button('申请项目延期','new-extension',p.id,'ghost','clock')}</div></details>`:''}`;
  const projectHeader=`<div class="flow-project-heading"><div><div class="flow-project-label">${projectStatus(p)}<span>${e(p.code)} · ${e(p.category)}</span></div><h1 class="sr-only">项目中心 · ${e(p.name)}</h1><label class="flow-inline-selector"><span class="sr-only">当前项目</span><select id="flow-project-select" aria-label="当前项目">${visibleProjects().map(item=>`<option value="${e(item.id)}" ${item.id===p.id?'selected':''}>${e(item.name)}</option>`).join('')}</select></label></div><div class="heading-actions"><a class="button secondary" href="#projects">${icon('grid')}全部项目</a>${actor().role!=='member'?button('新建项目','new-project','','primary','plus'):''}</div></div>`;
  const taskCompletion=ts.length?`${taskMetrics.actual}%`:'—';
  const taskCompletionCount=ts.length?`${done} / ${ts.length} 项已完成`:'尚无任务';
  const summary=`<div class="flow-summary-bar"><div class="flow-summary-progress"><div class="project-progress-head"><span>任务完成率</span><strong>${taskCompletion}</strong><small>${taskCompletionCount}</small></div>${renderMilestoneProgress(state,p.id,{basis:'tasks'})}</div><div class="flow-deadline"><span>截止</span><strong>${fullDate(p.dueDate)}</strong><span>北京时间</span>${p.dueDate!==p.originalDueDate?`<small>原定 ${fullDate(p.originalDueDate)}</small>`:''}</div></div>`;
  const extension=pending?`<div class="notice warning flow-extension-note">${icon('clock')}<span>延期审批中：申请调整至 ${fullDate(pending.newDueDate)}，批准前仍执行 ${fullDate(p.dueDate)}。</span><a href="#approvals" class="text-link">查看申请</a></div>`:approved.length?`<div class="flow-approved-note">${icon('approval')}<span>已批准延期 ${approved.length} 次 · 累计 ${durationLabel(p.originalDueDate,p.dueDate)}</span><a href="#approvals" class="text-link">查看记录</a></div>`:'';
  const tabs=`<div class="flow-view-row"><div class="filter-tabs" aria-label="项目视图">${[['flow','流程图'],['list','任务'],['people','成员'],['requests','申请'],['history','记录']].map(([id,title])=>`<button type="button" class="filter-tab ${projectView===id?'active':''}" aria-pressed="${projectView===id}" data-action="project-view" data-id="${id}">${title}</button>`).join('')}</div><div class="project-actions" aria-label="当前项目操作">${actions}</div></div>`;
  let view;
  if(projectView==='list')view=`<div class="detail-grid"><section class="panel"><div class="panel-header"><h2>任务计划 <span class="count">${ts.length}</span></h2></div><div class="task-list">${ts.map(t=>taskRow(t,false)).join('')||empty('还没有任务','先添加一个阶段节点，再拆分具体任务。')}</div></section><section class="panel milestone-panel"><div class="panel-header"><h2>阶段节点</h2></div><div class="milestone-list">${ms.map(m=>milestoneCard(m,true)).join('')||empty('规划第一个大节点','每周对应一个可验收成果。')}</div></section></div>`;
  else if(projectView==='people')view=renderProjectTeam(state,p,{actions:memberActions});
  else if(projectView==='requests')view=projectNodeRequests(p);
  else if(projectView==='history')view=`<section class="panel"><div class="panel-header"><h2>项目操作记录</h2><span class="muted">最近 ${logs.length} 条</span></div><div class="activity-list">${logs.map(l=>`<div class="activity-item"><span class="activity-dot"></span><div class="activity-body"><p><strong>${e(user(l.actorId)?.name||'系统')}</strong> ${e(l.message)}</p><span class="activity-time">${fullDate(l.at)}</span></div></div>`).join('')||'<p class="muted">暂无记录。</p>'}</div></section>`;
  else view=renderProjectFlow(state,p,{renderUnread:id=>unreadSlot({category:'tasks',entityId:id}),canManage:canManage(p),actorId,scope:flowScope,expandedIds:[...expandedFlowIds]});
  return `<div class="project-workspace">${projectHeader}${summary}${renderProjectPeopleSummary(state,p,{actions:memberActions})}${extension}${nodeApprovalBanner(p)}${tabs}${view}</div>`;
}
function milestoneDetail(id) {
  const m=milestone(id),p=m&&project(m.projectId);if(!m||!visibleProjects().some(item=>item.id===p.id))return;
  const ts=state.tasks.filter(t=>t.milestoneId===m.id),done=ts.filter(t=>t.status==='done').length;
  const actions=(canManage(p)?`${m.status!=='done'?`<button type="button" class="button secondary" data-action="new-task" data-id="${e(p.id)}" data-milestone-id="${e(m.id)}">添加小任务</button>`:''}${m.status!=='done'&&ts.length&&done===ts.length?button('确认节点达成','complete-milestone',m.id,'primary','check'):''}`:'')+(m.status!=='done'&&!visibleNodeRequests().some(x=>x.milestoneId===m.id&&x.status==='pending')?button('申请修改大节点','edit-milestone',m.id,'secondary'):'');
  showModal('大节点详情',`<div class="task-detail-heading"><h3>${e(m.title)}</h3>${statusPill(m.status==='done'?'done':'doing',m.status==='done'?'已达成':'待达成')}</div><p class="muted">${e(p.name)}</p><div class="task-detail-meta"><div><span>阶段截止</span><strong>${fullDate(m.dueDate)}</strong>${m.dueDate!==m.originalDueDate?`<small>原计划 ${fullDate(m.originalDueDate)}</small>`:''}</div><div><span>已验收任务</span><strong>${done} / ${ts.length}</strong></div>${m.acceptedAt?`<div><span>节点达成时间</span><strong>${fullDate(m.acceptedAt)}</strong></div>`:''}</div>${visibleNodeRequests().some(x=>x.milestoneId===m.id&&x.status==='pending')?'<p class="request-pending-note">此节点已有修改申请待审批，当前计划仍然生效。<a class="text-link" href="#approvals">查看申请</a></p>':''}<h4>节点内的任务</h4><div class="task-list">${ts.map(t=>taskRow(t,false)).join('')||'<p class="form-intro">为这个阶段添加具体任务，明确执行人与验收标准。</p>'}</div><p class="field-help">所有关联任务验收通过后，项目负责人可确认并更新大节点状态。</p>`,'','',m.id,actions);
}
function tasksPage() {
  let tasks=visibleTasks(); const all=tasks;
  if(taskFilter==='mine') tasks=tasks.filter(t=>t.ownerId===actorId);
  if(taskFilter==='review') tasks=tasks.filter(t=>t.status==='review'&&canReview(t));
  if(taskFilter==='overdue') tasks=tasks.filter(overdue);
  if(taskFilter==='done') tasks=tasks.filter(t=>t.status==='done');
  tasks=tasks.slice().sort((a,b)=>(a.status==='done')-(b.status==='done') || deadlineMs(a.dueDate)-deadlineMs(b.dueDate));
  return heading('我的任务','明确今天的重点，让每一份交付都有着落。',visibleProjects().some(canManage)?button('新建任务','new-task','','primary','plus'):'')+`<div class="filters"><div class="filter-tabs">${[['mine','我负责的'],['review',`待我验收 ${all.filter(t=>t.status==='review'&&canReview(t)).length}`],['all','全部任务'],['overdue','已逾期'],['done','已完成']].map(([id,label])=>`<button class="filter-tab ${taskFilter===id?'active':''}" data-action="task-filter" data-id="${id}">${label}</button>`).join('')}</div><span class="muted">${tasks.length} 项任务</span></div><section class="panel"><div class="task-list">${tasks.map(t=>taskRow(t)).join('')||empty('当前没有此类任务',taskFilter==='mine'?'管理员分配给你的任务会出现在这里。':'调整筛选条件，或继续推进其他任务。')}</div></section><p class="page-note">任务可以跨多天进行；每天更新进展，提交后由指定验收人确认。</p>`;
}
function milestoneCard(m, compact=false) {
  const ts=state.tasks.filter(t=>t.milestoneId===m.id), done=ts.filter(t=>t.status==='done').length, p=project(m.projectId);
  return `<div class="milestone-card ${compact?'compact':''}"><div class="milestone-card-top"><span class="milestone-date">${dateLabel(m.dueDate)}</span>${statusPill(m.status==='done'?'done':isOverdue(m.dueDate)?'overdue':'doing',m.status==='done'?'已达成':isOverdue(m.dueDate)?'待达成 · 逾期':'进行中')}</div><h3 class="milestone-title">${e(m.title)}</h3>${!compact?`<a class="text-link" href="#projects/${e(m.projectId)}">${e(p?.name)}</a>`:''}<div class="milestone-meta"><span>${done} / ${ts.length} 项已验收</span></div>${renderProgressTrack(progressAgainstPlan(ts),`${m.title}任务完成进度`)}${renderProgressNote(progressAgainstPlan(ts))}${m.status!=='done'&&canManage(p)?`<div class="milestone-tasks">${button('确认节点达成','complete-milestone',m.id,'small secondary')}${ts.some(t=>t.status!=='done')?'<span class="cell-subtext">全部关联任务验收后可确认</span>':''}</div>`:''}</div>`;
}
function reportData() { const r=range(), ts=visibleTasks().filter(t=>inRange(t.dueDate,r)), ms=visibleMilestones().filter(m=>inRange(m.dueDate,r)); return {r,ts,ms,done:ts.filter(t=>t.status==='done'),late:ts.filter(overdue)}; }
function weeklyPage() {
  const {r,ts,ms,done,late}=reportData(); const nextR={start:shift(r.start,7),end:shift(r.end,7)}, next=visibleTasks().filter(t=>inRange(t.dueDate,nextR));
  return heading('周计划与汇总','以每周交付节点，连接日常工作与项目目标。',button('导出周报','export-week','','secondary','download'))+`<div class="toolbar week-toolbar"><div class="week-switch">${button('上一周','previous-week','','small ghost')}<strong>${dayLabel(r.start)} — ${dayLabel(r.end)}</strong>${button('下一周','next-week','','small ghost')}</div>${button(weekOffset===0?'本周':'回到本周','current-week','','small secondary')}</div><div class="report-summary"><div><span>本周任务</span><strong>${ts.length}<small>项</small></strong></div><div><span>已验收完成</span><strong>${done.length}<small>项</small></strong></div><div><span>周节点达成</span><strong>${ms.filter(m=>m.status==='done').length}<small>/ ${ms.length}</small></strong></div><div><span>逾期任务</span><strong>${late.length}<small>项</small></strong></div></div><div class="section-heading"><div><h2>本周里程碑</h2><p class="panel-subtitle">每个节点都对应明确的交付成果</p></div></div><div class="week-grid">${ms.sort((a,b)=>deadlineMs(a.dueDate)-deadlineMs(b.dueDate)).map(m=>milestoneCard(m)).join('')}</div>${!ms.length?empty('这一周还没有里程碑','在项目详情中添加带验收标准的周节点。'):''}<section class="panel report-panel"><div class="panel-header"><div><h2>周汇总草稿</h2><p class="panel-subtitle">根据项目数据自动汇总，可导出后补充原因与下周安排</p></div><span class="tag">自动汇总</span></div><div class="report-columns"><div class="report-block"><h3>已完成的工作 <span class="count">${done.length}</span></h3>${done.length?`<ul>${done.map(t=>`<li><strong>${e(t.title)}</strong><span>${e(user(t.ownerId)?.name)} · ${e(project(t.projectId)?.name)}</span></li>`).join('')}</ul>`:'<p class="muted">本周到期任务尚无验收完成记录。</p>'}</div><div class="report-block"><h3>逾期待跟进 <span class="count">${late.length}</span></h3>${late.map(t=>`<p><strong>${e(t.title)}</strong><span>${e(`已超过 ${dateLabel(t.dueDate)} 截止时间`)}</span></p>`).join('')||'<p class="muted">本周到期任务暂无逾期事项。</p>'}<h3 class="next-week-title">下周计划 <span class="count">${next.length}</span></h3>${next.slice(0,5).map(t=>`<p>${e(t.title)}<span>${dateLabel(t.dueDate)} · ${e(user(t.ownerId)?.name)}</span></p>`).join('')||'<p class="muted">下周暂未安排到期任务。</p>'}</div></div></section>`;
}
function nodeApprovalBanner(p) {
  const count=visibleNodeRequests().filter(x=>x.projectId===p.id&&x.status==='pending').length;
  return count?`<div class="node-approval-banner">${icon('approval')}<span>${count} 项大节点申请待审批</span><button class="text-link" data-action="project-view" data-id="requests">查看申请 ${icon('arrow')}</button></div>`:'';
}
function projectNodeRequests(p) {
  const list=visibleNodeRequests().filter(x=>x.projectId===p.id).slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return `<section class="project-node-requests"><div class="section-heading"><div><h2>大节点申请</h2><p class="panel-subtitle">新增与修改均由管理员批准后生效，审批记录持续保留。</p></div>${button('申请新增大节点','new-milestone',p.id,'secondary','plus')}</div><div class="approval-list">${list.map(x=>renderMilestoneRequestCard(state,x,{admin:isAdmin(),unreadMarkup:unreadSlot({category:'approvals',entityId:x.id})})).join('')||empty('还没有大节点申请','新增节点可在此提交；修改节点请点击流程图中的大节点，再选择“申请修改大节点”。')}</div></section>`;
}
function approvalsPage() {
  const nodes=visibleNodeRequests(),extensions=visibleExtensions(),all=approvalKind==='nodes'?nodes:extensions;
  const list=all.filter(x=>approvalFilter==='all'||x.status===approvalFilter).slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  return heading(isAdmin()?'审批中心':'申请记录','提交申请、查看处理意见，批准后计划才会更新。',approvalKind==='extensions'&&visibleProjects().some(canManage)?button('申请项目延期','new-extension','','primary','plus'):'')+`<div class="approval-kind-tabs" aria-label="申请类型">${[['nodes','大节点申请',nodes],['extensions','项目延期',extensions]].map(([id,label,items])=>`<button class="filter-tab ${approvalKind===id?'active':''}" aria-pressed="${approvalKind===id}" data-action="approval-kind" data-id="${id}">${label} · ${items.filter(x=>x.status==='pending').length} 待审批</button>`).join('')}</div><div class="filters"><div class="filter-tabs">${[['pending',`待审批 ${all.filter(x=>x.status==='pending').length}`],['approved','已批准'],['rejected','已驳回'],['all','全部申请']].map(([id,label])=>`<button class="filter-tab ${approvalFilter===id?'active':''}" data-action="approval-filter" data-id="${id}">${label}</button>`).join('')}</div><span class="muted">${list.length} 条记录</span></div><div class="approval-list">${list.map(x=>approvalKind==='nodes'?renderMilestoneRequestCard(state,x,{admin:isAdmin(),unreadMarkup:unreadSlot({category:'approvals',entityId:x.id})}):approvalCard(x)).join('')||empty('当前没有此类申请',approvalKind==='nodes'?'在项目流程中申请新增大节点，或点击已有大节点申请修改。':'项目负责人可以从项目详情提交延期申请。')}</div>`;
}
function approvalCard(x) {
  const p=project(x.projectId), duration=durationLabel(x.originalDueDate,x.newDueDate);
  return `<article class="approval-card"><div class="approval-head"><div>${projectMark(p||{})}<div><a href="#projects/${e(x.projectId)}" class="approval-project">${e(p?.name || '项目')}</a>${unreadSlot({category:'approvals',entityId:x.id})}<p class="cell-subtext">${e(user(x.applicantId)?.name)} 提交于 ${fullDate(x.createdAt)}</p></div></div>${statusPill(x.status)}</div><div class="approval-body"><div class="date-change"><div class="date-box"><span>申请时截止时间</span><strong>${fullDate(x.originalDueDate)}</strong></div>${icon('arrow')}<div class="date-box"><span>申请调整至</span><strong>${fullDate(x.newDueDate)}</strong></div><span class="tag">延期 ${duration}</span></div>${typeof x.reason==='string'&&x.reason.trim()?`<div class="approval-reason"><span>延期原因</span><p>${e(x.reason)}</p></div>`:''}<div class="approval-plan"><div><span>后续安排</span><p>${e(x.plan)}</p></div><div><span>影响范围</span><p>${e(x.impact || '未补充')}</p></div></div>${x.affectedMilestones?.length || x.affectedTasks?.length?`<div class="affected-summary"><strong>同步调整 ${x.affectedMilestones?.length || 0} 个节点、${x.affectedTasks?.length || 0} 项任务</strong>${[...(x.affectedMilestones||[]).map(a=>({title:milestone(a.id)?.title,date:a.newDueDate})),...(x.affectedTasks||[]).map(a=>({title:task(a.id)?.title,date:a.newDueDate}))].map(a=>`<span>${e(a.title)} → ${fullDate(a.date)}</span>`).join('')}</div>`:''}${x.comment?`<div class="approval-comment"><strong>${e(user(x.reviewerId)?.name)} 的审批意见</strong><p>${e(x.comment)}</p></div>`:''}</div><div class="approval-footer"><span class="muted">${x.status==='pending'?'等待管理人员审批':`${e(user(x.reviewerId)?.name || '管理员')} · ${fullDate(x.reviewedAt)}`}</span><div class="approval-buttons">${x.status==='pending'&&isAdmin()&&x.applicantId!==actorId?`${button('驳回申请','reject-extension',x.id,'secondary')}${button('批准延期','approve-extension',x.id,'primary','check')}`:x.status==='pending'&&x.applicantId===actorId?'<span class="cell-subtext">申请人不能审批自己的申请</span>':''}</div></div></article>`;
}
function teamPage() {
  const r=range(), ids=new Set(visibleProjects().flatMap(p=>[p.ownerId,...p.memberIds]));
  const people=isAdmin()?state.users:actor().role==='member'?[actor()]:state.users.filter(u=>ids.has(u.id));
  const scopedState={...state,tasks:visibleTasks()};
  const weekLabel=weekOffset===0?'本周':weekOffset===-1?'上周':weekOffset===1?'下周':'所选周';
  return heading('团队与效能','看见团队进展，合理安排下一步工作。',isAdmin()?'<a class="button secondary" href="#accounts">管理团队账号</a>':'')+
    `<div class="toolbar team-week-toolbar"><div><strong>${weekLabel}执行概览</strong><span class="muted"> ${dayLabel(r.start)} — ${dayLabel(r.end)}</span></div><div class="team-week-controls">${button('上一周','previous-week','','small ghost')}${button('本周','current-week','','small secondary')}${button('下一周','next-week','','small ghost')}</div></div>`+
    renderTeamAnalytics(scopedState,{people,range:r});
}
const rate=(pct,n,d)=>`<span class="rate ${pct!==null&&pct>=80?'positive':''}">${pct===null || pct===undefined?'—':`${Math.round(pct)}%`}</span><span class="cell-subtext">${n ?? 0} / ${d ?? 0} 项</span>`;
function settingsPage() {
  let hasLegacy=false;try{hasLegacy=!!localStorage.getItem(LEGACY_KEY);}catch{}
  return heading('平台设置','账号权限和业务数据由服务器统一管理。')+`<div class="settings-grid"><section class="settings-card"><div class="settings-icon">${icon('grid')}</div><h2>工作空间</h2><dl class="settings-details"><div><dt>空间名称</dt><dd>鼎峰工作空间</dd></div><div><dt>身份认证</dt><dd>独立账号与密码</dd></div><div><dt>数据存储</dt><dd>服务器数据库</dd></div><div><dt>当前数据版本</dt><dd>${revision}</dd></div></dl><p>管理员查看全局并分配权限，员工仅访问参与项目。所有变更均由服务器校验并保存。</p><a class="text-link" href="#accounts">管理账号 ${icon('arrow')}</a></section><section class="settings-card"><div class="settings-icon">${icon('download')}</div><h2>数据备份</h2><p>导出当前可见的项目、任务、成员和审批记录。备份不包含账号登录信息。</p><div class="settings-actions">${button('导出项目数据','export-data','','secondary','download')}</div><p class="cell-subtext">${visibleProjects().length} 个项目 · ${visibleTasks().length} 项任务</p>${hasLegacy?`<div class="legacy-data-note"><strong>检测到旧版浏览器数据</strong><p>这些数据仍保留在此浏览器，尚未合并到服务器。可先导出备份，避免覆盖服务器记录。</p>${button('导出旧版备份','export-legacy','','secondary','download')}</div>`:''}</section><section class="settings-card"><div class="settings-icon">${icon('approval')}</div><h2>执行规则</h2><ul class="plain-list"><li>提交成果并通过验收后，任务才计为完成。</li><li>全部任务验收通过，任务完成率达到 100%；全部大节点确认后，项目标记为已完成。</li><li>新增、修改大节点须提交申请，管理员批准后才生效。</li><li>延期申请与审批人分离，批准后才调整日期。</li><li>多人同时修改时会提示刷新，避免覆盖他人更新。</li></ul></section><section class="settings-card"><div class="settings-icon">${icon('users')}</div><h2>员工进入平台</h2><p>在账号管理中设置员工账号、初始密码和参与项目。员工首次登录时设置自己的密码，之后即可使用电脑或手机处理工作。</p><p class="cell-subtext">账号、初始密码和平台网址需由管理员通过公司内部渠道告知员工。忘记密码时由管理员重置。</p></section></div>`;
}
function myAccountPage() {
  const a=actor(),w=weekRange(currentDay()),s=memberStats(state,a.id,w.start,w.end);
  return heading('我的账号','管理登录信息，查看自己的工作与权限。')+`<div class="account-profile-card"><div class="account-profile-head">${avatar(a.id)}<div><h2>${e(a.name)}</h2><span>${e(a.title||roleLabel(a.role))} · ${e(a.department||'工作空间')}</span></div><span class="status ${isAdmin()?'green':'blue'}">${isAdmin()?'管理端':'员工端'}</span></div><dl class="account-profile-details"><div><dt>登录账号</dt><dd>${e(accountInfo?.login||'—')}</dd></div><div><dt>平台角色</dt><dd>${roleLabel(a.role)}</dd></div><div><dt>可见项目</dt><dd>${visibleProjects().length} 个${isAdmin()?' · 全部项目':' · 仅参与的项目'}</dd></div><div><dt>数据存储</dt><dd>服务器保存</dd></div></dl><p class="field-help">${isAdmin()?'你可以管理项目、审批延期、查看团队数据，并开通员工账号。':'你可以查看参与项目、处理自己的任务并提交成果。项目负责人可安排所负责项目的计划。'}</p><div class="my-account-links">${isAdmin()?'<a href="#settings" class="text-link">平台设置与数据备份</a><a href="#team" class="text-link">团队与效能</a>':'<a href="#approvals" class="text-link">查看申请记录</a>'}</div><div class="account-security-actions">${button('修改密码','change-password','','secondary')}${button('退出当前账号','logout','','ghost')}</div></div>${renderInstallCard()}<section class="panel personal-stats"><div class="panel-header"><h2>我本周的执行情况</h2><span class="muted">${shortDate(w.start)} — ${shortDate(w.end)}</span></div><div class="personal-stats-grid"><div><span>计划完成率</span>${rate(s.completionRate,s.completed,s.due)}</div><div><span>按时提交率</span>${rate(s.onTimeRate,s.onTime,s.due)}</div><div><span>一次验收通过率</span>${rate(s.firstPassRate,s.firstPassed,s.firstReviewed)}</div></div></section>`;
}
let accountsRequest = null;
async function loadAccounts({throwOnError=false}={}) {
  if(!isAdmin())return null;
  const epoch=sessionEpoch;
  if(!accountsRequest||accountsRequest.epoch!==epoch){
    accountsLoading=true;
    const promise=api('/api/accounts').then(data=>{if(epoch!==sessionEpoch||!isAdmin()||!acceptSession(data))return null;accountsData=data;refreshUnreadBadges();if(route()[0]==='accounts'&&!modal.open)renderContent();return data;}).finally(()=>{if(accountsRequest?.promise===promise){accountsRequest=null;accountsLoading=false;}});
    accountsRequest={epoch,promise};
  }
  try{return await accountsRequest.promise;}
  catch(error){if(epoch!==sessionEpoch)return null;if(error.status===401||error.status===403)await loadSession(true);if(throwOnError)throw error;toast(error.message,true);return null;}
}
function accountsPage() {
  if(!accountsData){if(!accountsLoading)queueMicrotask(loadAccounts);return heading('账号管理','管理员与员工分别登录，权限由服务器执行。')+'<div class="panel session-loading" role="status">正在加载账号…</div>';}
  const list=accountsData.accounts,active=list.filter(x=>x.status==='active'),unlinked=state.users.filter(u=>!list.some(x=>x.userId===u.id));
  return heading('账号管理','开通独立账号、分配角色，并关联项目成员。',button('开通账号','new-account','','primary','plus'))+`<div class="account-summary"><span><strong>${active.length}</strong> 已启用账号</span><span><strong>${list.filter(x=>x.role==='admin').length}</strong> 管理员</span><span><strong>${unlinked.length}</strong> 位成员尚未关联账号</span><button class="text-link" data-action="refresh-accounts">刷新列表</button></div><div class="account-access-note">${icon('users')}<div><strong>管理端与员工端独立使用</strong><p>开通账号时选择参与项目；之后可在“管理”中调整。员工首次登录需设置新密码，只能看到自己参与的项目；账号信息由管理员内部通知。</p></div></div><section class="panel"><div class="table-wrap"><table class="data-table account-table"><thead><tr><th>姓名 / 登录账号</th><th>角色与工作台</th><th>账号状态</th><th>登录情况</th><th>操作</th></tr></thead><tbody>${list.map(a=>`<tr><td><strong>${e(a.name)}</strong><span class="cell-subtext">${e(a.login||a.email||'—')}</span></td><td>${roleLabel(a.role)}<span class="cell-subtext">${a.role==='admin'?'管理端 · 全局数据':'员工端 · 参与项目'}</span></td><td>${statusPill(a.status==='active'?'done':'todo',a.status==='active'?'已启用':'已停用')}</td><td>${a.mustChangePassword?'待设置新密码':a.lastLoginAt?'正常使用':'等待首次登录'}<span class="cell-subtext">${a.lastLoginAt?`最近登录 ${fullDate(a.lastLoginAt)}`:'尚无登录记录'}</span></td><td><div class="account-row-actions">${button('管理','edit-account',a.id,'small secondary')}${a.userId===actorId?button('修改密码','change-password','','small ghost'):button('重置密码','reset-password',a.id,'small ghost')}</div>${a.userId===actorId?'<span class="cell-subtext">当前账号</span>':''}</td></tr>`).join('')}</tbody></table></div></section>${unlinked.length?`<section class="panel unlinked-members"><div class="panel-header"><div><h2>尚未开通账号的项目成员</h2><p class="panel-subtitle">业务中的负责人记录不会自动成为登录账号。开通时选择“关联已有成员”即可保留原有任务归属。</p></div></div><div class="unlinked-member-list">${unlinked.map(u=>`<span>${avatar(u.id)}${e(u.name)}<small>${roleLabel(u.role)}</small></span>`).join('')}</div></section>`:''}`;
}
function accountRoleOptions(selected='member') {return [['member','员工'],['manager','项目负责人'],['admin','管理员']].map(([id,label])=>`<option value="${id}" ${selected===id?'selected':''}>${label}</option>`).join('');}
function accountProjectNotice(role) {
  return role==='admin'?'管理员可查看全部项目；这里记录参与关系，不限制管理员权限。':'员工只可访问参与或负责的项目。移出项目会撤销该员工的访问权限，已有任务负责人不会自动更换。';
}
function accountProjectFields(userId='',role='member') {
  return `<fieldset class="account-projects field full"><legend>参与项目</legend><p class="field-help" id="account-project-help">${accountProjectNotice(role)}</p><div class="account-project-list">${state.projects.map(p=>{const owned=p.ownerId===userId,selected=owned||p.memberIds.includes(userId);return `<label class="account-project-choice"><input type="checkbox" name="projectIds" value="${e(p.id)}" ${selected?'checked':''} ${owned?'disabled':''}><span><strong>${e(p.name)}</strong><small>${e(p.code||'项目')}${owned?' · 项目负责人，保留访问权限':''}</small></span></label>`;}).join('')||'<p class="field-help">暂无项目，可以先开通账号，再新建项目并选择成员。</p>'}</div></fieldset>`;
}
function selectedAccountProjects(data,userId='') {
  return [...new Set([...data.getAll('projectIds'),...state.projects.filter(p=>p.ownerId===userId).map(p=>p.id)])];
}
function availableProjectAccounts(p) {
  return (accountsData?.accounts||[]).filter(a=>a.status==='active'&&a.userId!==p.ownerId&&!p.memberIds.includes(a.userId));
}
function projectMemberOptions(p,selected='') {
  return '<option value="">请选择员工</option>'+availableProjectAccounts(p).map(a=>`<option value="${e(a.id)}" ${a.id===selected?'selected':''}>${e(a.name)} · ${e(a.login||a.email||roleLabel(a.role))}</option>`).join('');
}
async function addProjectMember(projectId) {
  if(!isAdmin()||saving)return;
  const epoch=sessionEpoch;
  showModal('添加成员','<p class="form-intro" role="status">正在加载可添加的员工…</p>','','',projectId);
  const loadingForm=modal.querySelector('form');
  try{
    const snapshot=await loadAccounts({throwOnError:true});
    if(!snapshot||epoch!==sessionEpoch||!modal.open||modal.querySelector('form')!==loadingForm)return;
    const p=snapshot.state.projects.find(item=>item.id===projectId);
    if(!p)throw new Error('项目不存在，请刷新后重试。');
    if(!availableProjectAccounts(p).length){showModal('添加成员',`<p class="form-intro"><strong>${e(p.name)}</strong></p><p>暂无可添加的员工。请在账号管理中开通或启用尚未加入项目的账号。</p><a class="button secondary" href="#accounts">前往账号管理</a>`,'','',projectId);return;}
    showModal('添加成员',`<p class="form-intro"><strong>${e(p.name)}</strong></p>${selectField('员工账号','accountId',projectMemberOptions(p))}<p class="field-help">加入后，员工可查看该项目的流程与任务。</p>`,'添加成员','add-project-member',projectId);
  }catch(error){if(epoch===sessionEpoch&&modal.open&&modal.querySelector('form')===loadingForm)showModal('添加成员',`<p class="form-error" role="alert">${e(error.message)}</p>`,'','',projectId,button('重新加载','add-project-member',projectId,'primary'));}
}
async function saveProjectMember(form,payload,projectId) {
  if(saving)return;
  if(!isAdmin())throw new Error('仅管理员可以添加项目成员。');
  const snapshot=accountsData,p=snapshot?.state?.projects.find(item=>item.id===projectId),account=snapshot?.accounts.find(item=>item.id===payload.accountId);
  if(!p)throw new Error('项目数据已更新，请关闭窗口后重新添加。');
  if(!account||account.status!=='active')throw new Error('请选择一个已启用的员工账号。');
  if(p.ownerId===account.userId||p.memberIds.includes(account.userId))throw new Error('该员工已在项目中，请选择其他员工。');
  const projectIds=[...new Set([...snapshot.state.projects.filter(item=>item.ownerId===account.userId||item.memberIds.includes(account.userId)).map(item=>item.id),projectId])];
  const epoch=sessionEpoch,submit=form.querySelector('[type="submit"]'),label=submit?.textContent;
  saving=true;form.setAttribute('aria-busy','true');if(submit){submit.disabled=true;submit.textContent='正在添加…';}
  try{
    const data=await api(`/api/accounts/${encodeURIComponent(account.id)}`,{method:'PATCH',body:JSON.stringify({projectIds,revision:snapshot.revision})});
    if(epoch!==sessionEpoch||!acceptSession(data))return;
    accountsData={...data,users:state.users};storageIssue='';modal.close();modal.innerHTML='';render();toast(`${account.name} 已加入项目。`);
  }catch(error){
    if(epoch!==sessionEpoch)return;
    if(error.status===409){const refreshed=await loadAccounts(),current=refreshed?.state?.projects.find(item=>item.id===projectId);if(current&&form.isConnected&&form.elements.accountId)form.elements.accountId.innerHTML=projectMemberOptions(current,payload.accountId);error.message+=refreshed?' 已刷新最新数据，请核对后重试。':' 暂时无法刷新，请关闭窗口后重试。';}
    if(error.status===401||error.status===403)await loadSession(true);
    throw error;
  }finally{saving=false;form.removeAttribute('aria-busy');if(submit){submit.disabled=false;submit.textContent=label;}}
}
function newAccount() {
  if(!isAdmin())return;
  const linked=new Set((accountsData?.accounts||[]).map(a=>a.userId));
  showModal('开通独立账号',`<p class="form-intro">设置员工专属账号与初始密码。首次登录需改密，员工不能自行提升角色。</p><div class="form-grid">${field('登录账号','login','','text','required minlength="3" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9._@\\-]{3,64}" aria-describedby="account-login-help"')}${field('初始密码','password','','password','required minlength="12" maxlength="128" autocomplete="new-password"')}${field('姓名','name','','text','required maxlength="30"')}${selectField('账号角色','role',accountRoleOptions())}${selectField('关联项目成员','existingUserId','<option value="new">创建新成员</option>'+state.users.filter(u=>!linked.has(u.id)).map(u=>`<option value="${e(u.id)}">${e(u.name)} · ${roleLabel(u.role)}</option>`).join(''))}${field('职位','title','','text','maxlength="40"')}${field('部门','department','','text','maxlength="40"')}<div class="field full" id="account-project-memberships">${accountProjectFields()}</div></div><p id="account-login-help" class="field-help">账号支持 3–64 个英文字母、数字、点、下划线、短横线或 @，可使用手机号或邮箱。密码需为 12–128 个字符。</p><p class="field-help">关联已有成员将保留其任务和项目归属。请将账号和初始密码通过公司内部渠道告知员工。管理员可以访问全部公司数据，请谨慎分配。</p>`,'开通账号','create-account');
}
function editAccount(id) {
  const a=accountsData?.accounts.find(x=>x.id===id);if(!a||!isAdmin())return;
  const own=a.userId===actorId;
  showModal('管理账号',`<p class="form-intro"><strong>${e(a.name)}</strong><br>${e(a.login||a.email||'—')}</p>${selectField('账号角色','role',accountRoleOptions(a.role))}${selectField('账号状态','status',`<option value="active" ${a.status==='active'?'selected':''}>启用</option><option value="disabled" ${a.status==='disabled'?'selected':''} ${own?'disabled':''}>停用</option>`)}<div id="account-project-memberships">${accountProjectFields(a.userId,a.role)}</div><p class="field-help">${own?'不能停用当前账号，也不能移除最后一名管理员。':'停用后，该账号立即失去平台数据访问和操作权限。项目与任务历史记录仍会保留。'} 修改角色不会自动变更项目负责人或任务归属。</p>`,'保存账号设置','edit-account',id);
}
function resetPassword(id) {
  const a=accountsData?.accounts.find(x=>x.id===id);if(!a||!isAdmin())return;
  if(a.userId===actorId)return changePassword();
  showModal('重置员工密码',`<p class="form-intro">为 <strong>${e(a.name)}</strong>（${e(a.login||a.email)}）设置临时密码。保存后该账号将退出其他设备，下次登录需重新设置密码。</p>${field('临时密码','password','','password','required minlength="12" maxlength="128" autocomplete="new-password"')}${field('再次输入临时密码','confirmPassword','','password','required minlength="12" maxlength="128" autocomplete="new-password"')}<p class="field-help">使用 12–128 个字符。请通过公司内部渠道单独告知员工，密码不会在页面中再次展示。</p>`,'重置密码','reset-password',id);
}
async function savePasswordReset(payload,id) {
  if(payload.password!==payload.confirmPassword)throw new Error('两次输入的临时密码不一致，请重新确认。');
  if(saving)return;saving=true;const epoch=sessionEpoch,submit=modal.querySelector('[type="submit"]');submit.disabled=true;
  try{const data=await api(`/api/accounts/${encodeURIComponent(id)}/password`,{method:'POST',body:JSON.stringify({password:payload.password,revision:accountsData?.revision??revision})});if(epoch!==sessionEpoch)return;acceptSession(data);accountsData={accounts:data.accounts,users:state.users,revision:data.revision};modal.close();modal.innerHTML='';render();toast('密码已重置，请单独通知员工。');}
  catch(error){if(error.status===409)await loadAccounts();if(error.status===401||error.status===403)await loadSession(true);throw error;}
  finally{saving=false;submit.disabled=false;}
}
async function saveAccount(action,payload,id) {
  if(saving)return;saving=true;const epoch=sessionEpoch,submit=modal.querySelector('[type="submit"]');if(submit)submit.disabled=true;
  try{
    if(!payload.existingUserId||payload.existingUserId==='new')delete payload.existingUserId;
    const data=await api(action==='create-account'?'/api/accounts':`/api/accounts/${encodeURIComponent(id)}`,{method:action==='create-account'?'POST':'PATCH',body:JSON.stringify({...payload,revision:accountsData?.revision??revision})});
    if(epoch!==sessionEpoch)return;acceptSession(data);accountsData={accounts:data.accounts,users:state.users,revision:data.revision};modal.close();modal.innerHTML='';render();toast(action==='create-account'?'账号已开通；请向员工告知账号、初始密码和平台网址。':'账号设置已保存。');
  }catch(error){if(error.status===409){const refreshed=await loadAccounts(),memberships=modal.querySelector('#account-project-memberships');if(refreshed&&memberships){const userId=action==='create-account'?payload.existingUserId:refreshed.accounts.find(a=>a.id===id)?.userId;memberships.innerHTML=accountProjectFields(userId,payload.role);error.message+=' 项目归属已刷新，请核对后重新保存。';}}throw error;}finally{saving=false;if(submit)submit.disabled=false;}
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
const scheduleField=(label,name,value,options='')=>field(label,name,value,'datetime-local',`step="3600" ${options}`);
const scheduleHelp='<p class="field-help">时间按北京时间填写，可精确到小时。历史“全天”记录未设置小时；编辑时请确认具体时间。</p>';
function taskScheduleBounds(form,p,m){const input=form.elements.dueDate;input.min=toDateTimeInput(p.startDate,'00:00');input.max=scheduleInput(m.dueDate);if(!input.value||input.value>input.max)input.value=input.max;if(input.value<input.min)input.value=input.min;}
const textarea=(label,name,placeholder='',required=true,value='')=>`<div class="field full"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}" rows="3" placeholder="${e(placeholder)}" ${required?'required':''} maxlength="2000">${e(value)}</textarea></div>`;
const selectField=(label,name,options)=>`<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}" required>${options}</select></div>`;
const userOptions=(selected,users=state.users)=>users.map(u=>`<option value="${e(u.id)}" ${selected===u.id?'selected':''}>${e(u.name)} · ${e(u.title || roleLabel(u.role))}</option>`).join('');
const projectOptions=(selected,ps=visibleProjects().filter(canManage))=>ps.map(p=>`<option value="${e(p.id)}" ${selected===p.id?'selected':''}>${e(p.name)}</option>`).join('');
function newProject() {
  if(actor().role==='member') {toast('当前身份不能创建项目，请切换到项目负责人或管理员。',true);return;}
  showModal('新建项目',`<p class="form-intro">先明确目标与团队，再拆解里程碑和任务。</p><div class="form-grid">${field('项目名称','name','','text','required maxlength="80" placeholder="例如：新产品上市计划"')}${field('项目类别','category','','text','maxlength="30" placeholder="例如：产品研发"')}${selectField('项目负责人','ownerId',userOptions(actorId,state.users.filter(u=>u.role!=='member'&&(isAdmin()||u.id===actorId))))}<div class="field"><label>项目成员</label><div class="member-checks">${state.users.map(u=>`<label class="checkbox-label"><input type="checkbox" name="memberIds" value="${e(u.id)}" ${u.id===actorId?'checked':''}>${e(u.name)}</label>`).join('')}</div></div>${scheduleField('开始时间','startDate',`${currentDay()}T09:00`,'required')}${scheduleField('计划截止时间','dueDate',`${shift(currentDay(),30)}T18:00`,'required')}${textarea('项目目标与说明','description','这个项目要解决什么问题，最终交付什么？')}</div>${scheduleHelp}`,'创建项目','createProject');
}
function newTask(projectId, selectedMilestoneId) {
  const ps=visibleProjects().filter(canManage),p=ps.find(p=>p.id===projectId)||ps[0]; if(!p){toast('请先创建你负责的项目。',true);return;}
  const ms=state.milestones.filter(m=>m.projectId===p.id&&m.status!=='done');
  if(!ms.length){showModal('先规划项目里程碑',`<p class="form-intro">${e(p.name)}</p><p>任务需要关联一个尚未完成的里程碑，确保所有交付都计入项目计划。请先申请新增大节点，待管理员批准后再创建任务。</p>`,'','',p.id,button('申请新增大节点','new-milestone',p.id,'primary','plus'));return;}
  const members=state.users.filter(u=>p.memberIds.includes(u.id)||u.id===p.ownerId), owner=members[0]?.id||actorId;
  showModal('新建任务',`<p class="form-intro">任务需要明确交付标准，由负责人提交、验收人确认。</p><div class="form-grid">${selectField('所属项目','projectId',projectOptions(p.id))}${selectField('所属里程碑','milestoneId',ms.map(m=>`<option value="${e(m.id)}">${e(m.title)}</option>`).join(''))}<div class="field full">${field('任务名称','title','','text','required maxlength="100" placeholder="例如：完成外观设计 V1"')}</div>${selectField('主负责人','ownerId',userOptions(owner,members))}${selectField('验收人','reviewerId',userOptions(p.ownerId===owner?state.users.find(u=>u.role==='admin'&&u.id!==owner)?.id:p.ownerId,state.users.filter(u=>u.id!==owner&&(p.memberIds.includes(u.id)||u.role==='admin'))))}${scheduleField('交付截止时间','dueDate',scheduleInput(ms[0].dueDate),`required min="${e(toDateTimeInput(p.startDate,'00:00'))}" max="${e(scheduleInput(ms[0].dueDate))}"`)}${selectField('优先级','priority','<option value="normal">普通</option><option value="high">高</option><option value="low">低</option>')}${textarea('任务说明','description','说明工作范围和注意事项。',false)}${textarea('交付物与验收标准','acceptance','例如：提交三视图、尺寸及材料说明，负责人确认后通过。')}</div>${scheduleHelp}`,'创建任务','createTask');
}
function newMilestone(projectId, milestoneId) {
  const p=visibleProjects().find(p=>p.id===projectId),m=milestoneId&&milestone(milestoneId);if(!p)return;
  if(m&&(m.projectId!==p.id||m.status==='done')){toast('已完成的大节点不能修改。',true);return;}
  if(m&&visibleNodeRequests().some(x=>x.milestoneId===m.id&&x.status==='pending')){toast('此节点已有待审批申请，请等待处理。',true);return;}
  const kind=m?'update':'create',legacyDue=!!m&&/^\d{4}-\d{2}-\d{2}$/.test(m.dueDate);
  showModal(m?'申请修改大节点':'申请新增大节点',`<p class="form-intro">${e(p.name)} · 管理员批准后才会更新正式计划。</p><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="milestoneId" value="${e(m?.id||'')}">${m?`<p class="node-approval-help">当前节点：${e(m.title)} · ${fullDate(m.dueDate)} 截止</p>`:''}<div class="form-grid"><div class="field full">${field('节点交付成果','title',m?.title||'','text','required maxlength="100" placeholder="例如：样机方案通过评审"')}</div>${scheduleField('节点截止时间','dueDate',scheduleInput(m?.dueDate||p.dueDate),`required ${legacyDue?'disabled':''} min="${e(toDateTimeInput(p.startDate,'00:00'))}" max="${e(scheduleInput(p.dueDate))}"`)}${legacyDue?`<label class="checkbox-label field full"><input type="checkbox" name="preserveAllDay" checked data-preserve-all-day>保留原截止日（全天）；取消勾选后设置具体小时</label>`:''}${textarea('申请原因（选填）','reason',m?'可补充调整节点或日期的原因。':'可补充新增阶段的原因和预期交付。',false)}</div><p class="field-help">节点日期须在项目周期内，且不得早于其下属任务的截止时间。超过项目截止时间时，先由项目负责人申请项目延期。批准不会自动调整小任务时间。</p>${scheduleHelp}`,'提交申请','requestMilestone',p.id);
}
function reviewNodeRequest(id, approve) {
  readEntityNotifications('approvals',id);
  const x=visibleNodeRequests().find(x=>x.id===id);if(!x||!isAdmin())return;
  showModal(approve?'批准大节点申请':'驳回大节点申请',`<p class="form-intro">${e(project(x.projectId)?.name)} · ${e(user(x.applicantId)?.name)} 提交</p>${requestComparison(x)}${typeof x.reason==='string'&&x.reason.trim()?`<div class="approval-reason"><span>申请原因</span><p>${e(x.reason)}</p></div>`:''}<p class="field-help">${approve?'批准后更新正式节点。':'驳回后保留当前计划，员工可根据审批意见重新提交。'}</p>${textarea('审批意见（选填）','comment',approve?'可补充批准依据及执行要求。':'可补充需要调整的内容。',false)}`,approve?'确认批准并生效':'确认驳回',approve?'approveMilestoneRequest':'rejectMilestoneRequest',id);
}
function taskDetail(id) {
  readEntityNotifications('tasks',id);
  const t=visibleTasks().find(t=>t.id===id);if(!t)return;
  const actions = t.status==='review'&&canReview(t)?`${button('退回修改','reject-task',id,'secondary')}${button('验收通过','approve-task',id,'primary','check')}`:canOperate(t)&&t.status!=='done'&&t.status!=='review'?`${t.status==='todo'?button('开始任务','start-task',id,'primary','arrow'):button('提交成果','submit-task',id,'primary','check')}`:'';
  showModal('任务详情',`<div class="task-detail-heading"><h3>${e(t.title)}</h3>${statusPill(t.status)}</div><p class="muted">${e(project(t.projectId)?.name)}${t.milestoneId?` · ${e(milestone(t.milestoneId)?.title)}`:''}</p><div class="task-detail-meta"><div><span>主负责人</span>${person(t.ownerId)}</div><div><span>验收人</span>${person(t.reviewerId)}</div><div><span>截止时间</span><strong>${fullDate(t.dueDate)}</strong>${t.dueDate!==t.originalDueDate?`<small>原定 ${fullDate(t.originalDueDate)}</small>`:''}</div></div><div class="detail-text"><h4>任务说明</h4><p>${e(t.description || '暂无补充说明')}</p><h4>交付物与验收标准</h4><p>${e(t.acceptance)}</p>${t.deliverable?`<h4>已提交成果</h4><p class="preserve-space">${e(t.deliverable)}</p><span class="cell-subtext">提交时间：${fullDate(t.submittedAt)}</span>`:''}${t.reviewComment?`<h4>验收意见</h4><p>${e(t.reviewComment)}</p>`:''}${t.reviewedAt?`<span class="cell-subtext">${t.status==='done'?'验收通过时间':'最近审核时间'}：${fullDate(t.reviewedAt)}</span>`:''}</div>`, '', '', id, actions);
  modal.querySelector('.modal-footer > button[data-action="close-modal"]').textContent='关闭';
}
function submitTask(id) {
  const t=task(id);showModal('提交任务成果',`<p class="form-intro">${e(t.title)}</p><div class="notice info"><span>验收标准：${e(t.acceptance)}</span></div>${textarea('成果说明或交付链接','deliverable','描述已完成的工作，并填写文件链接或交付结果。提交后由验收人确认。',true,t.deliverable||'')}<p class="field-help">提交和验收时间由系统自动记录，按北京时间显示。</p>`,'提交验收','submitTask',id);
}
function reviewTask(id,approve) { readEntityNotifications('tasks',id); const t=task(id);showModal(approve?'确认验收通过':'退回任务修改',`<p class="form-intro">${e(t.title)}</p><div class="notice info"><span>交付成果：${e(t.deliverable)}</span></div>${textarea('验收意见','comment',approve?'说明通过验收的依据。':'请明确指出需要修改的内容。',!approve)}` ,approve?'验收通过':'退回修改',approve?'approveTask':'rejectTask',id); }
function extensionFields(projectId) {
  const p=project(projectId),ms=state.milestones.filter(m=>m.projectId===p.id&&m.status!=='done'),ts=state.tasks.filter(t=>t.projectId===p.id&&t.status!=='done');
  return `<div class="date-current"><span>当前截止时间</span><strong>${fullDate(p.dueDate)}</strong><span>原计划 ${fullDate(p.originalDueDate)}</span></div>${scheduleField('申请的新截止时间','newDueDate',offsetInput(p.dueDate,7),`required min="${nextHourInput(p.dueDate)}"`)}${scheduleHelp}<p class="field-help">勾选需要同步调整的节点或任务，并分别填写新日期。未勾选的日期保持原值。</p><div class="reschedule-list">${ms.map(m=>rescheduleRow('milestone',m)).join('')}${ts.map(t=>rescheduleRow('task',t)).join('')}${!ms.length&&!ts.length?'<p class="muted">当前没有未完成的节点或任务。</p>':''}</div>`;
}
function rescheduleRow(kind,item) { return `<div class="reschedule-row"><label class="checkbox-label"><input type="checkbox" name="${kind}Ids" value="${e(item.id)}" data-reschedule="${e(item.id)}"><span><strong>${kind==='milestone'?'节点':'任务'} · ${e(item.title)}</strong><small>当前 ${fullDate(item.dueDate)}</small></span></label><input aria-label="${e(item.title)}的新截止时间" type="datetime-local" step="3600" name="date-${e(item.id)}" value="${e(nextHourInput(item.dueDate))}" min="${e(nextHourInput(item.dueDate))}" data-reschedule-date="${e(item.id)}" disabled></div>`; }
function newExtension(projectId) {
  const ps=visibleProjects().filter(canManage),p=ps.find(p=>p.id===projectId)||ps[0];if(!p){toast('当前身份没有可申请延期的项目。',true);return;}
  showModal('申请项目延期',`<p class="form-intro">填写新的截止时间和后续安排，由另一位管理员审批后生效。</p>${selectField('申请延期的项目','projectId',projectOptions(p.id))}<div id="extension-dates">${extensionFields(p.id)}</div><div class="form-grid">${textarea('延期原因（选填）','reason','可补充造成延期的情况。',false)}${textarea('后续推进安排','plan','如何解决问题，延长期间将完成哪些工作？')}${textarea('影响范围','impact','对交付、人员安排和其他项目有什么影响？')}</div>`,'提交延期申请','requestExtension');
}
function reviewExtension(id,approve) { readEntityNotifications('approvals',id); const x=state.extensions.find(x=>x.id===id);showModal(approve?'批准项目延期':'驳回延期申请',`<p class="form-intro">${e(project(x.projectId)?.name)}</p><div class="date-change"><div class="date-box"><span>当前截止</span><strong>${fullDate(x.originalDueDate)}</strong></div>${icon('arrow')}<div class="date-box"><span>申请调整至</span><strong>${fullDate(x.newDueDate)}</strong></div></div><p class="field-help">${approve?`批准后同步修改 ${(x.affectedMilestones||[]).length} 个节点与 ${(x.affectedTasks||[]).length} 项任务，保留原始截止时间。`:'驳回后所有日期保持不变，申请人可查看审批意见。'}</p>${textarea('审批意见（选填）','comment',approve?'可补充批准理由及注意事项。':'可补充驳回原因及建议。',false)}`,approve?'确认批准':'确认驳回',approve?'approveExtension':'rejectExtension',id); }

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
function exportWeek() {const {r,ts,ms,done,late}=reportData();const lines=[`# 鼎峰项目周报`,`${r.start} — ${r.end}`,'',`统计范围：${isAdmin()?'所有项目':`${actor().name} 可见项目`}`,'',`## 本周概况`,`- 到期任务：${ts.length} 项`,`- 已验收完成：${done.length} 项`,`- 周节点达成：${ms.filter(m=>m.status==='done').length}/${ms.length}`,`- 逾期任务：${late.length} 项`,'','## 已完成工作',...done.map(t=>`- ${t.title}（${user(t.ownerId)?.name}；${project(t.projectId)?.name}；提交 ${fullDate(t.submittedAt)}；验收 ${fullDate(t.reviewedAt)}）`),'','## 本周里程碑',...ms.map(m=>`- ${m.title}：${m.status==='done'?'已达成':'未达成'}；截止 ${fullDate(m.dueDate)}`),'','## 逾期待跟进',...late.map(t=>`- ${t.title}：${`超过截止时间 ${fullDate(t.dueDate)}`}`),'','## 下周到期任务',...visibleTasks().filter(t=>inRange(t.dueDate,{start:shift(r.start,7),end:shift(r.end,7)})).map(t=>`- ${t.title}（${user(t.ownerId)?.name}；${fullDate(t.dueDate)}）`),'','## 负责人补充与确认','请补充延期原因、需要协调的资源与下周重点。','','此文件根据当前可见的服务器项目数据自动汇总，时间均为北京时间。'];exportFile(`鼎峰周报_${r.start}.md`,lines.join('\n'),'text/markdown;charset=utf-8');}

document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();document.querySelector('#content')?.focus();return;}
  if(state&&location.hash==='#overview'&&event.target.closest('.nav-item[href="#overview"], .brand[href="#overview"]')&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){searchTerm='';projectView='flow';expandedFlowIds.clear();render();return;}
  const el=event.target.closest('[data-action]');if(!el)return;const {action,id}=el.dataset;
  if(el.closest('form')&&el.type!=='submit')event.preventDefault();
  try {
    if(action==='reload-session'){await loadSession();if(state&&route()[0]==='accounts')await loadAccounts();return;}
    if(action==='refresh-accounts'){await loadAccounts();return;}
    if(action==='logout')return await logout();
    if(!state)return;
    if(action==='notifications')return notificationCenter();
    if(action==='open-notification')return await openNotification(id);
    if(action==='read-all-notifications'){const epoch=sessionEpoch;await markNotificationsRead(notifications.map(item=>item.id));if(epoch===sessionEpoch&&state&&modal.open)notificationCenter();return;}
    if(action==='change-password')return changePassword();
    if(action==='reset-password')return resetPassword(id);
    if(action==='flow-filter'){flowScope=['all','week','mine'].includes(id)?id:'all';renderContent();document.querySelector(`[data-action="flow-filter"][data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});return;}
    if(action==='flow-toggle'){const viewport=document.querySelector('.flow-scroll'),pos=viewport&&[viewport.scrollLeft,viewport.scrollTop];expandedFlowIds.has(id)?expandedFlowIds.delete(id):expandedFlowIds.add(id);renderContent();const next=document.querySelector('.flow-scroll');if(next&&pos){next.scrollLeft=pos[0];next.scrollTop=pos[1];}document.querySelector(`[data-action="flow-toggle"][data-id="${CSS.escape(id)}"]`)?.focus({preventScroll:true});return;}
    if(action==='new-account')return newAccount();
    if(action==='edit-account')return editAccount(id);
    if(action==='add-project-member')return await addProjectMember(id);
    if(action==='export-legacy'){const old=localStorage.getItem(LEGACY_KEY);if(old)exportFile('鼎峰旧版浏览器备份.json',old,'application/json;charset=utf-8');return;}
    if(action==='close-modal'){modal.close();return;}
    if(action==='new-project')return newProject();
    if(action==='new-task'){newTask(id,el.dataset.milestoneId);if(el.dataset.milestoneId){const f=modal.querySelector('form[data-form="createTask"]');if(f){f.elements.milestoneId.value=el.dataset.milestoneId;const m=milestone(el.dataset.milestoneId);if(m){taskScheduleBounds(f,project(m.projectId),m);}}}return;}
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
    if(action==='complete-milestone')return showModal('确认节点达成',`<p class="form-intro">${e(milestone(id)?.title)}</p><p>确认这个节点的交付成果已达到要求。系统会检查所有关联任务是否已验收，确认后更新大节点状态。</p>`,'确认达成','completeMilestone',id);
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
    if(err){err.hidden=true;err.textContent='';}
    if(action==='login'||action==='change-password')return await submitAuth(form,payload,action);
    if(!state)return;
    if(action==='reset-password')return await savePasswordReset(payload,id);
    if(action==='add-project-member')return await saveProjectMember(form,payload,id);
    if(action==='create-account'||action==='edit-account'){const userId=action==='create-account'?payload.existingUserId:accountsData?.accounts.find(a=>a.id===id)?.userId;payload.projectIds=selectedAccountProjects(data,userId);return await saveAccount(action,payload,id);}
    if(action==='createProject'){payload.memberIds=data.getAll('memberIds');return await commit(action,payload,'项目已创建，可以开始添加里程碑与任务。');}
    if(action==='createTask'){return await commit(action,payload,'任务已创建并分配。');}
    if(action==='requestMilestone'){if(payload.preserveAllDay==='on'){const current=milestone(payload.milestoneId);if(current)payload.dueDate=current.dueDate;}delete payload.preserveAllDay;return await commit(action,{...payload,projectId:id},'申请已提交，管理员批准后才生效。');}
    if(action==='approveMilestoneRequest'||action==='rejectMilestoneRequest')return await commit('reviewMilestoneRequest',{id,approve:action==='approveMilestoneRequest',comment:payload.comment},action==='approveMilestoneRequest'?'申请已批准，正式节点已更新。':'申请已驳回，当前计划保持不变。');
    if(action==='submitTask')return await commit(action,{id,deliverable:payload.deliverable},'成果已提交，等待验收。');
    if(action==='approveTask'||action==='rejectTask')return await commit('reviewTask',{id,approve:action==='approveTask',comment:payload.comment},action==='approveTask'?'任务已通过验收。':'任务已退回，等待负责人修改。');
    if(action==='completeMilestone')return await commit(action,{id},'大节点状态已更新为已达成。');
    if(action==='requestExtension'){payload.affectedTasks=data.getAll('taskIds').map(id=>({id,newDueDate:data.get(`date-${id}`)}));payload.affectedMilestones=data.getAll('milestoneIds').map(id=>({id,newDueDate:data.get(`date-${id}`)}));return await commit(action,payload,'延期申请已提交，等待管理员审批。');}
    if(action==='approveExtension'||action==='rejectExtension')return await commit('reviewExtension',{id,approve:action==='approveExtension',comment:payload.comment},action==='approveExtension'?'延期已批准，相关计划已同步更新。':'延期申请已驳回，原计划保持不变。');

  } catch(error){if(err&&form.isConnected){err.hidden=false;err.textContent=error.message;err.scrollIntoView({block:'nearest'});}else toast(error.message,true);}
});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='flow-project-select'){flowProjectId=el.value;projectView='flow';expandedFlowIds.clear();location.hash=`projects/${flowProjectId}`;return;}

  if(el.hasAttribute('data-preserve-all-day')){const input=el.closest('form').elements.dueDate;input.disabled=el.checked;input.required=!el.checked;return;}
  if(el.dataset.reschedule){const input=modal.querySelector(`[data-reschedule-date="${CSS.escape(el.dataset.reschedule)}"]`);if(input){input.disabled=!el.checked;input.required=el.checked;}return;}
  const form=el.closest('form');if(!form)return;
  if(form.dataset.form==='create-account'&&el.name==='existingUserId'){const u=user(el.value);if(u){form.elements.name.value=u.name;form.elements.role.value=u.role;form.elements.title.value=u.title||'';form.elements.department.value=u.department||'';}form.querySelector('#account-project-memberships').innerHTML=accountProjectFields(u?.id||'',form.elements.role.value);return;}
  if(['create-account','edit-account'].includes(form.dataset.form)&&el.name==='role'){form.querySelector('#account-project-help').textContent=accountProjectNotice(el.value);return;}
  if(el.name==='projectId'&&form.dataset.form==='requestExtension'){document.querySelector('#extension-dates').innerHTML=extensionFields(el.value);return;}
  if(form.dataset.form==='createTask'&&el.name==='projectId'){
    const p=project(el.value),ms=state.milestones.filter(m=>m.projectId===p.id&&m.status!=='done');
    if(!ms.length){newTask(p.id);return;}
    form.elements.milestoneId.innerHTML=ms.map(m=>`<option value="${e(m.id)}">${e(m.title)}</option>`).join('');
    form.elements.ownerId.innerHTML=userOptions('',state.users.filter(u=>p.memberIds.includes(u.id)||u.id===p.ownerId));
    form.elements.reviewerId.innerHTML=userOptions(p.ownerId,state.users.filter(u=>u.id!==form.elements.ownerId.value&&(p.memberIds.includes(u.id)||u.role==='admin')));
    taskScheduleBounds(form,p,ms[0]);return;
  }
  if(form.dataset.form==='createTask'&&el.name==='ownerId'){form.elements.reviewerId.innerHTML=userOptions(project(form.elements.projectId.value)?.ownerId,state.users.filter(u=>u.id!==el.value&&(project(form.elements.projectId.value)?.memberIds.includes(u.id)||u.role==='admin')));return;}
  if(form.dataset.form==='createTask'&&el.name==='milestoneId'){const p=project(form.elements.projectId.value),m=milestone(el.value);if(m)taskScheduleBounds(form,p,m);}
});
document.addEventListener('input',event=>{if(event.target.id==='global-search'){searchTerm=event.target.value;renderContent();}});
document.addEventListener('keydown',event=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();document.querySelector('#global-search')?.focus();}});
window.addEventListener('hashchange',()=>{searchTerm='';projectView='flow';expandedFlowIds.clear();modal.close();render();if(route()[0]==='accounts')loadAccounts();window.scrollTo({top:0,behavior:'instant'});});

modal.addEventListener('click',event=>{if(event.target===modal){const r=modal.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modal.close();}});
app.innerHTML='<div class="session-loading" role="status">正在载入你的工作台…</div>';
initPWA();
await loadSession();
function refreshWorkspace(){if(state&&!authBusy&&!document.hidden&&!modal.open&&!saving&&!searchTerm){if(route()[0]==='accounts')void loadAccounts();else void loadSession(true);}}
setInterval(refreshWorkspace,15000);
window.addEventListener('focus',refreshWorkspace);
