import { formatDateTime } from './time.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const validId = value => typeof value === 'string' && value.length > 0;
const textOr = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const peopleIcon = svg('<circle cx="9" cy="8" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 21v-2a6 6 0 0 0-4-5.65"/>');
const arrowIcon = svg('<path d="M4 12h16m-5-5 5 5-5 5"/>');
const taskStates = { todo: ['未开始', 'todo'], doing: ['进行中', 'doing'], review: ['待验收', 'review'], done: ['已完成', 'done'] };

function collect(state = {}, project = {}) {
  const users = new Map((Array.isArray(state.users) ? state.users : []).filter(Boolean).map(user => [user.id, user]));
  const tasks = (Array.isArray(state.tasks) ? state.tasks : []).filter(task => task && task.projectId === project.id);
  const memberIds = [...new Set([project.ownerId, ...(Array.isArray(project.memberIds) ? project.memberIds : [])].filter(validId))];
  const members = new Set(memberIds);
  const collaboratorIds = [...new Set(tasks.map(task => task.ownerId).filter(id => validId(id) && !members.has(id)))];
  const collaborators = new Set(collaboratorIds);
  const reviewerIds = [...new Set(tasks.map(task => task.reviewerId).filter(id => validId(id) && !members.has(id) && !collaborators.has(id)))];
  const profile = id => {
    const user = users.get(id);
    return { name: textOr(user?.name, '成员资料待补充'), title: textOr(user?.title, '岗位未设置'), department: textOr(user?.department, '部门未设置'), missing: !user };
  };
  return { tasks, memberIds, collaboratorIds, reviewerIds, profile };
}

function taskTimes(task) {
  const entries = [['截止', task.dueDate]];
  if (task.submittedAt) entries.push(['提交', task.submittedAt]);
  if (task.reviewedAt) entries.push([task.status === 'done' ? '验收' : '最近审核', task.reviewedAt]);
  return entries;
}

function taskTiming(entries) {
  return `<span class="project-team-task-times">${entries.map(([label,value])=>`<span title="${escape(label)}时间 ${escape(formatDateTime(value))}">${label} <span class="project-team-time-value">${escape(formatDateTime(value,{compact:true}))}</span></span>`).join('')}</span>`;
}

function taskList(tasks, responsibility) {
  return `<ul class="project-team-task-list">${tasks.map(task => {
    const status = task.status === 'blocked' ? 'doing' : task.status;
    const [label, tone] = Object.hasOwn(taskStates, status) ? taskStates[status] : ['状态待确认', 'todo'];
    const title = textOr(task.title, '未命名任务');
    const times = taskTimes(task);
    const timingLabel = times.map(([name,value])=>`${name}时间 ${formatDateTime(value)}`).join('，');
    const contents = `<span class="project-team-task-copy"><span class="project-team-task-title">${escape(title)}</span>${taskTiming(times)}</span><span class="project-team-task-status is-${tone}"><i aria-hidden="true"></i>${label}</span>${arrowIcon}`;
    return `<li>${validId(task.id) ? `<button type="button" class="project-team-task" data-action="task-detail" data-id="${escape(task.id)}" aria-label="查看${responsibility}：${escape(title)}，${label}，${escape(timingLabel)}">${contents}</button>` : `<div class="project-team-task">${contents}</div>`}</li>`;
  }).join('')}</ul>`;
}

function personRow(context, project, id, kind = 'member') {
  const person = context.profile(id);
  const owned = context.tasks.filter(task => task.ownerId === id);
  const reviewing = context.tasks.filter(task => task.reviewerId === id);
  const completed = owned.filter(task => task.status === 'done').length;
  const awaitingReview = reviewing.filter(task => task.status === 'review').length;
  const owner = id === project.ownerId;
  const role = owner ? '项目负责人' : kind === 'reviewer' ? '验收协作' : kind === 'collaborator' ? '任务协作' : '项目成员';
  const initial = person.missing ? '?' : Array.from(person.name).slice(-1).join('');
  const execution = kind !== 'reviewer' ? `<div class="project-team-duty"><div class="project-team-duty-heading"><h3>执行任务 <span>${owned.length}</span></h3>${owned.length ? `<p>已完成 <strong>${completed} / ${owned.length}</strong></p>` : ''}</div>${owned.length ? taskList(owned, '负责的任务') : '<p class="project-team-empty-duty">尚未分配执行任务</p>'}</div>` : '';
  const review = reviewing.length ? `<div class="project-team-duty is-review"><div class="project-team-duty-heading"><h3>验收任务 <span>${reviewing.length}</span></h3>${awaitingReview ? `<p>待验收 <strong>${awaitingReview}</strong> 项</p>` : ''}</div>${taskList(reviewing, '负责验收的任务')}</div>` : '';
  return `<li class="project-team-row${owner ? ' is-owner' : ''}" data-team-person="${escape(id)}"><div class="project-team-person"><span class="project-team-avatar${kind === 'reviewer' ? ' is-reviewer' : ''}" aria-hidden="true">${escape(initial)}</span><div><div class="project-team-person-name"><h3>${escape(person.name)}</h3><span class="project-team-role${owner ? ' is-owner' : ''}">${role}</span></div><p>${escape(person.department)}<span aria-hidden="true"> · </span>${escape(person.title)}</p>${person.missing ? '<small>当前没有此成员的资料</small>' : ''}</div></div><div class="project-team-duties">${execution}${review}</div></li>`;
}

/** Compact summary for the project header; reviewers are not counted as members. */
export function renderProjectPeopleSummary(state = {}, project = {}, { actions = '' } = {}) {
  const context = collect(state, project);
  const owner = validId(project.ownerId) ? context.profile(project.ownerId).name : '未指定';
  const otherMembers = context.memberIds.filter(id => id !== project.ownerId);
  const names = otherMembers.map(id => escape(context.profile(id).name)).join('、');
  return `<div class="project-people-summary">${peopleIcon}<div class="project-people-names"><span>负责人 <strong>${escape(owner)}</strong></span>${otherMembers.length ? `<span>成员 ${names}</span>` : '<span>暂无其他项目成员</span>'}${context.reviewerIds.length ? `<span class="project-people-support">另有 ${context.reviewerIds.length} 名验收协作</span>` : ''}${context.collaboratorIds.length ? `<span class="project-people-support">另有 ${context.collaboratorIds.length} 名任务协作</span>` : ''}</div><button type="button" class="project-people-open" data-action="project-view" data-id="people">查看分工${arrowIcon}</button>${actions}</div>`;
}

/** Read-only project membership and concrete responsibilities; actions use app delegation. */
export function renderProjectTeam(state = {}, project = {}, { actions = '' } = {}) {
  const context = collect(state, project);
  const members = context.memberIds.length ? `<ul class="project-team-list">${context.memberIds.map(id => personRow(context, project, id)).join('')}</ul>` : '<div class="project-team-empty"><h3>尚未设置项目成员</h3><p>成员加入项目后，这里会显示每个人的具体分工。</p></div>';
  const collaborators = context.collaboratorIds.length ? `<section class="project-team-support"><header><h3>任务协作人员 <span>${context.collaboratorIds.length}</span></h3><p>项目组外的执行人员</p></header><ul class="project-team-list">${context.collaboratorIds.map(id => personRow(context, project, id, 'collaborator')).join('')}</ul></section>` : '';
  const reviewers = context.reviewerIds.length ? `<section class="project-team-support is-review"><header><h3>验收协作 <span>${context.reviewerIds.length}</span></h3><p>不计入项目成员人数</p></header><ul class="project-team-list">${context.reviewerIds.map(id => personRow(context, project, id, 'reviewer')).join('')}</ul></section>` : '';
  return `<section class="panel project-team"><header class="panel-header project-team-header"><h2>项目人员与分工</h2><span class="project-team-total">${context.memberIds.length} 名项目成员</span>${actions}</header>${members}${collaborators}${reviewers}</section>`;
}
