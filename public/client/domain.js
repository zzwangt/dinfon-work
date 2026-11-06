/**
 * 鼎峰项目协作 · 共享领域模型。
 * 正式环境由 server/service.mjs 在受信任的登录身份和云端数据上执行这些规则。
 */

import { datePart, deadlineMs, startMs, validSchedule } from './time.js';
import { canApproveRequest, canApproveProject, canReviewTask, canSubmitTask, personalSubmissionTime, taskSignSeats, taskOwners, taskReviewers, stageReviewers, stageSeats, milestoneSignSlots } from './approval-access.js';
import { isAdminRole, normalizeRole } from './roles.js';

const ROLES = ['admin', 'member'];

export function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const read = (key) => parts.find((p) => p.type === key).value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function validDate(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}格式不正确`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label}无效`);
  return value;
}

export function addDays(date, n) {
  validDate(date);
  if (!Number.isInteger(n)) throw new Error('天数必须是整数');
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + n);
  return value.toISOString().slice(0, 10);
}

export function weekRange(date = today()) {
  const calendarDate = datePart(validSchedule(date));
  const day = new Date(`${calendarDate}T00:00:00Z`).getUTCDay();
  const start = addDays(calendarDate, -((day + 6) % 7));
  return { start, end: addDays(start, 6) };
}

function text(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${label}`);
  if (value.trim().length > max) throw new Error(`${label}不能超过 ${max} 字`);
  return value.trim();
}

function optionalText(value, max = 2000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`文本长度不能超过 ${max} 字`);
  return value.trim();
}

function uid(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function find(list, id, label) {
  const item = list.find((entry) => entry.id === id);
  if (!item) throw new Error(`${label}不存在`);
  return item;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function contentFields(payload, allowed) {
  check(payload && typeof payload === 'object' && !Array.isArray(payload), '编辑内容格式不正确');
  check(Object.keys(payload).every(key => allowed.includes(key)), '此操作只能修改节点名称和文字内容，不能修改日期、人员或完成状态');
}

function contentChanges(before, after) {
  return Object.fromEntries(Object.keys(after).filter(key => before[key] !== after[key])
    .map(key => [key, { before: before[key] ?? '', after: after[key] }]));
}

function manageProject(actor, project) {
  requireProjectAccess(actor, project);
  check(canApproveProject(project, actor), '仅项目负责人或管理员可以修改项目节点');
}

function requireProjectAccess(actor, project) {
  check(isAdminRole(actor.role) || actor.id === project.ownerId || project.memberIds.includes(actor.id), '你已无权访问该项目，请联系项目负责人');
}

function peopleIds(list = []) {
  check(Array.isArray(list) && list.every(id => typeof id === 'string' && id), '请选择有效的人员');
  return [...new Set(list)];
}

function nodeStaff(users, project, type, memberIds, reviewers, ownerId) {
  const members = peopleIds(memberIds).filter(id => id !== ownerId);
  const reviewIds = peopleIds(reviewers).filter(id=>type === 'task' || id !== project.ownerId);
  for (const id of [...members,...reviewIds]) find(users, id, '节点人员');
  if (type === 'task') {
    check(reviewIds.length, '请至少指定一位任务验收人');
    return {memberIds:members, reviewerId:reviewIds[0], extraReviewerIds:reviewIds.slice(1)};
  }
  return {memberIds:members, coReviewerId:reviewIds[0] || null, extraReviewerIds:reviewIds.slice(1)};
}

function addParticipants(project, ids) {
  project.memberIds = [...new Set([...project.memberIds, ...ids])];
}

function restartDeliveries(task, reason, at) {
  if (!task.deliveries?.length) return;
  (task.deliveryHistory ??= []).push({at, reason, deliveries:task.deliveries, signatures:task.reviewSignatures || []});
  task.deliveries = [];
  task.submittedAt = null;
  task.submittedBy = null;
  task.deliverable = '';
}

function stageStaff(users, project, input) {
  return nodeStaff(users, project, 'milestone', input.memberIds, [
    ...(input.coReviewerId ? [input.coReviewerId] : []), ...peopleIds(input.extraReviewerIds),
  ]);
}

function canChangeTask(actor, task, project) {
  requireProjectAccess(actor, project);
  check(isAdminRole(actor.role) || taskOwners(task).includes(actor.id) || actor.id === project.ownerId, '只能更新自己负责的任务');
  check(task.status !== 'done', '已验收任务不能直接修改');
  check(task.status !== 'review', '任务正在等待验收，请由验收人处理');
}

function validateSchedule(state, project) {
  validSchedule(project.startDate, '项目开始日期');
  validSchedule(project.dueDate, '项目截止日期');
  const start = startMs(project.startDate);
  const end = deadlineMs(project.dueDate);
  check(start <= end, '项目截止日期不能早于开始日期');
  const milestones = state.milestones.filter((m) => m.projectId === project.id);
  for (const milestone of milestones) {
    validSchedule(milestone.dueDate, '节点截止日期');
    check(deadlineMs(milestone.dueDate) >= start && deadlineMs(milestone.dueDate) <= end, '节点日期必须位于项目周期内');
  }
  for (const task of state.tasks.filter((t) => t.projectId === project.id)) {
    validSchedule(task.dueDate, '任务截止日期');
    check(deadlineMs(task.dueDate) >= start && deadlineMs(task.dueDate) <= end, '任务截止日期必须位于项目周期内');
    if (task.milestoneId) {
      const milestone = find(milestones, task.milestoneId, '项目节点');
      check(deadlineMs(task.dueDate) <= deadlineMs(milestone.dueDate), `任务“${task.title}”的截止日期不能晚于所属节点`);
    }
  }
}

// Build the exact node and parent date changes on both the form and server.
export function nodeExtensionPlan(state, { projectId, targetType, targetId, newDueDate }) {
  check(['milestone', 'task'].includes(targetType), '延期节点类型无效');
  const project = find(state.projects, projectId, '项目');
  const target = find(targetType === 'task' ? state.tasks : state.milestones, targetId, '延期节点');
  check(target.projectId === project.id, '延期节点不属于该项目');
  check(target.status !== 'done', '已完成的节点不能延期');
  const date = validSchedule(newDueDate, '申请截止日期');
  check(deadlineMs(date) > deadlineMs(target.dueDate), '申请日期必须晚于当前截止日期');
  const change = item => ({ id: item.id, originalDueDate: item.dueDate, newDueDate: date });
  const affectedMilestones = targetType === 'milestone' ? [change(target)] : [];
  const affectedTasks = targetType === 'task' ? [change(target)] : [];
  if (targetType === 'task' && target.milestoneId) {
    const parent = find(state.milestones, target.milestoneId, '所属大节点');
    check(parent.projectId === project.id, '所属大节点不属于该项目');
    check(parent.status !== 'done', '所属大节点已完成，不能延期');
    if (deadlineMs(date) > deadlineMs(parent.dueDate)) affectedMilestones.push(change(parent));
  }
  return {
    targetType, targetId, targetTitle: target.title,
    parentMilestoneId: targetType === 'task' ? target.milestoneId || null : null,
    originalTargetDueDate: target.dueDate, newTargetDueDate: date,
    originalDueDate: project.dueDate,
    newDueDate: deadlineMs(date) > deadlineMs(project.dueDate) ? date : project.dueDate,
    affectedMilestones, affectedTasks,
  };
}

function milestoneSnapshot(milestone) {
  const { title, dueDate, status } = milestone;
  return { title, dueDate, status };
}

function milestoneProposal(payload, project) {
  const title = text(payload?.title, '节点名称', 100);
  const dueDate = validSchedule(payload?.dueDate, '节点截止日期');
  check(deadlineMs(dueDate) >= startMs(project.startDate), '节点截止日期不能早于项目开始日期');
  check(deadlineMs(dueDate) <= deadlineMs(project.dueDate), '节点截止日期超出项目周期，请先申请项目延期并获批');
  return { title, dueDate };
}

function validateMilestoneProposal(state, project, proposed, milestoneId) {
  // Pending proposals are checked against the live schedule without changing it.
  const milestones = milestoneId
    ? state.milestones.map((item) => item.id === milestoneId ? { ...item, ...proposed } : item)
    : [...state.milestones, { projectId: project.id, ...proposed }];
  validateSchedule({ ...state, milestones }, project);
}

export function progressAgainstPlan(items, now = Date.now()) {
  const total = items.length;
  const completed = items.filter((item) => item.status === 'done').length;
  const dueItems = items.filter((item) => deadlineMs(item.dueDate) <= now);
  const due = dueItems.length;
  const overdueCount = dueItems.filter((item) => item.status !== 'done').length;
  const actual = total ? (completed === total ? 100 : Math.min(99, Math.round(completed / total * 100))) : 0;
  const planned = total ? Math.round(due / total * 100) : 0;
  return { actual, planned, lag: Math.max(planned - actual, 0), total, completed, due, overdueCount };
}

export function projectScheduleProgress(state, projectId, now = Date.now()) {
  return progressAgainstPlan(state.milestones.filter((item) => item.projectId === projectId), now);
}

export function projectProgress(state, projectId) {
  return projectScheduleProgress(state, projectId).actual;
}

/** Read compatibility only: retain historical fields and never mutate the input. */
export function normalizeState(state) {
  check(state?.version === 1, '数据版本不兼容，请重新载入演示数据');
  const next = structuredClone(state);
  next.milestoneRequests ??= [];
  check(Array.isArray(next.milestoneRequests), '节点申请数据无效');
  for (const user of next.users) user.role = normalizeRole(user.role);
  for (const task of next.tasks) {
    if (task.status === 'blocked') task.status = 'doing';
  }
  for (const milestone of next.milestones) milestone.description ??= '';
  for (const project of next.projects) project.reviewerId ??= null;
  return next;
}

/** All ratios use tasks due within this date window, preserving a comparable cohort. */
export function memberStats(state, userId, start, end) {
  validSchedule(start, '统计开始日期');
  validSchedule(end, '统计结束日期');
  const windowStart = startMs(start);
  const windowEnd = deadlineMs(end);
  check(windowStart <= windowEnd, '统计结束日期不能早于开始日期');
  const tasks = state.tasks.filter((task) => taskOwners(task).includes(userId) && deadlineMs(task.dueDate) >= windowStart && deadlineMs(task.dueDate) <= windowEnd);
  const due = tasks.length;
  const completed = tasks.filter((task) => task.status === 'done').length;
  const onTime = tasks.filter(task => deadlineMs(personalSubmissionTime(task,userId)) <= deadlineMs(task.dueDate)).length;
  const firstReviewed = tasks.filter((task) => task.reviewCount > 0).length;
  const firstPassed = tasks.filter((task) => task.reviewCount > 0 && task.firstReviewPassed === true).length;
  const rate = (a, b) => b ? Math.round(a / b * 100) : null;
  return { due, completed, onTime, firstReviewed, firstPassed, completionRate: rate(completed, due), onTimeRate: rate(onTime, due), firstPassRate: rate(firstPassed, firstReviewed) };
}

// The single-ID fields in saved tasks only preserve the existing file format.
function taskStaff(users, project, input, previous) {
  let owners, reviewers;
  if ('ownerIds' in input || 'reviewerIds' in input) {
    check(!['ownerId','memberIds','reviewerId','extraReviewerIds'].some(key=>key in input), '请使用同一组任务人员字段');
    owners = peopleIds(input.ownerIds); reviewers = peopleIds(input.reviewerIds);
    check(owners.length, '请至少勾选一位负责人');
    check(reviewers.length, '请至少勾选一位验收人');
    if (previous) {
      // Reordering checkboxes never changes the task or invalidates a signature.
      const retainOrder = (ids,prior) => [...prior.filter(id=>ids.includes(id)), ...ids.filter(id=>!prior.includes(id))];
      owners=retainOrder(owners,taskOwners(previous)); reviewers=retainOrder(reviewers,taskReviewers(previous));
    }
  } else {
    const firstOwner = previous ? previous.ownerId : input.ownerId;
    const firstReviewer = previous ? input.reviewerId : input.reviewerId || project.ownerId;
    owners = [firstOwner,...peopleIds(input.memberIds ?? previous?.memberIds)];
    reviewers = [firstReviewer,...peopleIds(input.extraReviewerIds ?? previous?.extraReviewerIds)];
  }
  const owner = find(users,owners[0],'任务负责人');
  return {ownerId:owner.id,...nodeStaff(users,project,'task',owners.slice(1),reviewers,owner.id)};
}

function buildTask(users, project, milestone, payload, creatorId, at) {
  const staffing = taskStaff(users,project,payload);
  check(!payload.priority || ['high', 'normal', 'low'].includes(payload.priority), '优先级无效');
  return {
    id: uid('t'), projectId: project.id, milestoneId: milestone.id,
    title: text(payload.title, '任务名称', 100), ...staffing,
    originalDueDate: validSchedule(payload.dueDate, '截止日期'), dueDate: payload.dueDate,
    status: 'todo', priority: payload.priority || 'normal', description: optionalText(payload.description),
    acceptance: text(payload.acceptance, '验收标准'), deliverable: '', submittedAt: null,
    reviewedAt: null, reviewCount: 0, firstReviewPassed: null, reviewComment: '',
    createdBy: creatorId, createdAt: at,
  };
}

export function transact(state, action, payload = {}, actorId) {
  const next = normalizeState(state);
  const actor = find(next.users, actorId, '操作人员');
  const at = new Date().toISOString();
  const record = (projectId, message, changes) => next.logs.unshift({ id: uid('log'), at, actorId, projectId: projectId || null, message, ...(changes ? { changes } : {}) });

  if (action === 'createProject') {
    check(isAdminRole(actor.role), '仅管理员可以创建项目');
    const owner = find(next.users, payload.ownerId, '项目负责人');
    check(!payload.reviewerId, '项目验收人已停用，请在大节点中设置加验人');
    const memberIds = [...new Set([owner.id, ...(Array.isArray(payload.memberIds) ? payload.memberIds : [])])];
    memberIds.forEach((id) => find(next.users, id, '项目成员'));
    const project = {
      id: uid('p'), code: '',
      name: text(payload.name, '项目名称', 80), description: optionalText(payload.description),
      category: optionalText(payload.category, 40) || '综合项目', ownerId: owner.id, reviewerId: null, memberIds,
      startDate: validSchedule(payload.startDate, '开始日期'), originalDueDate: validSchedule(payload.dueDate, '截止日期'),
      dueDate: payload.dueDate, color: ['#375fbb', '#9b704a', '#66845b', '#8266a8'][next.projects.length % 4],
    };
    const stages = payload.stages === undefined ? [] : payload.stages;
    check(Array.isArray(stages) && stages.length <= 50, '每份计划最多可添加 50 个大节点');
    const milestones = [], tasks = [];
    for (const stage of stages) {
      check(stage && Array.isArray(stage.tasks), '请按大节点填写小任务');
      const milestone = {
        id: uid('m'), projectId: project.id, ...milestoneProposal(stage, project),
        description: optionalText(stage.description), originalDueDate: stage.dueDate,
        status: 'pending', acceptedAt: null,
      };
      Object.assign(milestone, stageStaff(next.users, project, stage));
      milestones.push(milestone);
      check(tasks.length + stage.tasks.length <= 200, '每份计划最多可添加 200 项小任务');
      for (const input of stage.tasks) {
        check(input && typeof input === 'object', '小任务格式无效');
        tasks.push(buildTask(next.users, project, milestone, input, actor.id, at));
      }
    }
    addParticipants(project, [...tasks.flatMap(taskOwners), ...tasks.flatMap(taskReviewers),
      ...milestones.flatMap(m=>m.memberIds || []), ...milestones.flatMap(stageReviewers)]);
    validateSchedule({ milestones, tasks }, project);
    (next.projectPlans ??= []).unshift({
      id: uid('plan'), projectId: project.id, project, milestones, tasks, status: 'pending',
      applicantId: actor.id, createdAt: at, reviewerId: null, reviewedAt: null, comment: '',
    });
    record(null, `提交新建项目“${project.name}”，含 ${milestones.length} 个大节点和 ${tasks.length} 项小任务`);
  } else if (action === 'reviewProjectPlan') {
    check(Object.keys(payload).every(key => ['id', 'approve', 'comment'].includes(key)) && typeof payload.approve === 'boolean', '审批内容无效');
    const plan = find(next.projectPlans || [], payload.id, '项目计划');
    check(plan.status === 'pending', '这份计划已处理');
    check(canApproveRequest(plan.project, plan, actor), '仅拟任项目负责人或管理员可以审批，员工不能自批');
    plan.comment = optionalText(payload.comment);
    if (payload.approve) {
      const { project, milestones, tasks } = plan;
      for (const id of project.memberIds) find(next.users, id, '项目成员');
      for (const task of tasks) nodeStaff(next.users, project, 'task', task.memberIds, taskReviewers(task), task.ownerId);
      for (const node of milestones) stageStaff(next.users, project, node);
      validateSchedule(plan, project);
      const number = next.projects.reduce((max, item) => Math.max(max, Number(/^DF-(\d+)$/.exec(item.code)?.[1]) || 0), 0) + 1;
      project.code = `DF-${String(number).padStart(3, '0')}`;
      next.projects.push(structuredClone(project));
      next.milestones.push(...structuredClone(milestones));
      next.tasks.push(...structuredClone(tasks));
    }
    plan.status = payload.approve ? 'approved' : 'rejected';
    plan.reviewerId = actor.id;
    plan.reviewedAt = at;
    record(payload.approve ? plan.projectId : null, `${payload.approve ? '批准' : '驳回'}整份新建项目计划“${plan.project.name}”`);
  } else if (action === 'setProjectReviewer') {
    throw new Error('项目验收人已停用，请在大节点中设置加验人');
  } else if (action === 'setMilestoneCoReviewer') {
    check(Object.keys(payload).every(key => ['id', 'reviewerId', 'memberIds', 'extraReviewerIds'].includes(key)) && Object.hasOwn(payload, 'reviewerId'), '请指定加验人或明确清除');
    const milestone = find(next.milestones, payload.id, '节点');
    const project = find(next.projects, milestone.projectId, '项目');
    manageProject(actor, project);
    check(milestone.status !== 'done', '已完成节点不能更改验收人');
    const staffing = stageStaff(next.users, project, {
      coReviewerId:payload.reviewerId, memberIds:payload.memberIds ?? milestone.memberIds,
      extraReviewerIds:payload.extraReviewerIds ?? milestone.extraReviewerIds,
    });
    check(JSON.stringify([milestone.memberIds || [],stageReviewers(milestone)]) !== JSON.stringify([staffing.memberIds,stageReviewers(staffing)]), '人员没有变化');
    Object.assign(milestone, staffing);
    addParticipants(project,[...milestone.memberIds,...stageReviewers(milestone)]);
    record(project.id, `更新“${milestone.title}”的负责人和验收人`, staffing);
  } else if (action === 'setTaskReviewer') {
    check(Object.keys(payload).every(key => ['id', 'ownerIds', 'reviewerIds', 'reviewerId', 'memberIds', 'extraReviewerIds'].includes(key)), '此操作只能调整任务负责人和验收人');
    const task = find(next.tasks, payload.id, '任务');
    const project = find(next.projects, task.projectId, '项目');
    manageProject(actor, project);
    check(task.status !== 'done', '已完成的任务不能改派验收人');
    const staffing = taskStaff(next.users,project,payload,task);
    const sameList = (a,b) => a.length===b.length && a.every(id=>b.includes(id));
    const changedOwners = !sameList(taskOwners(task),taskOwners(staffing));
    check(changedOwners || !sameList(taskReviewers(task),taskReviewers(staffing)), '人员没有变化');
    check(task.status !== 'review' || !changedOwners, '待验收任务不能更换负责人');
    if (changedOwners) restartDeliveries(task,'负责人名单已调整',at);
    if (!staffing.memberIds.length && !Object.hasOwn(task,'memberIds')) delete staffing.memberIds;
    if (!staffing.extraReviewerIds.length && !Object.hasOwn(task,'extraReviewerIds')) delete staffing.extraReviewerIds;
    Object.assign(task, staffing);
    addParticipants(project,[...taskOwners(task),...taskReviewers(task)]);
    if (task.reviewSignatures?.length) task.reviewSignatures=[];
    record(project.id, `更新“${task.title}”的负责人和验收人`, staffing);
  } else if (action === 'createTask') {
    const project = find(next.projects, payload.projectId, '项目');
    requireProjectAccess(actor, project);
    check(typeof payload.milestoneId === 'string' && payload.milestoneId.length > 0, '请先申请并获批，再选择任务所属的里程碑');
    const milestone = find(next.milestones, payload.milestoneId, '节点');
    check(milestone.projectId === project.id, '节点不属于该项目');
    check(milestone.status !== 'done', '已验收节点不能添加任务');
    const task = buildTask(next.users, project, milestone, payload, actor.id, at);
    next.tasks.push(task);
    addParticipants(project,[...taskOwners(task),...taskReviewers(task)]);
    validateSchedule(next, project);
    record(project.id, `创建任务“${task.title}”，由 ${taskOwners(task).map(id=>find(next.users,id,'任务负责人').name).join('、')} 负责`);
  } else if (['deleteTask', 'deleteMilestone', 'deleteProject'].includes(action)) {
    check(Object.keys(payload).every(key => ['id', 'confirm'].includes(key)), '删除操作的参数无效');
    check(payload.confirm === true, '请先确认删除');
    const projectDeletion = action === 'deleteProject', milestoneDeletion = action === 'deleteMilestone';
    check(projectDeletion ? actor.role === 'superadmin' : isAdminRole(actor.role), projectDeletion ? '仅总管理员可以删除整个项目' : '仅管理员可以删除节点');
    const target = find(next[projectDeletion ? 'projects' : milestoneDeletion ? 'milestones' : 'tasks'], payload.id, projectDeletion ? '项目' : '节点');
    const project = projectDeletion ? target : find(next.projects, target.projectId, '项目');
    requireProjectAccess(actor, project);
    const removedMilestones = next.milestones.filter(item => projectDeletion ? item.projectId === project.id : milestoneDeletion && item.id === target.id);
    const milestoneIds = new Set(removedMilestones.map(item => item.id));
    const removedTasks = next.tasks.filter(item => projectDeletion ? item.projectId === project.id : milestoneDeletion ? item.projectId === project.id && milestoneIds.has(item.milestoneId) : item.id === target.id);
    const taskIds = new Set(removedTasks.map(item => item.id));
    const removedExtensions = next.extensions.filter(request => request.projectId === project.id && (projectDeletion || request.status === 'pending' && (request.affectedTasks?.some(item => taskIds.has(item.id)) || request.affectedMilestones?.some(item => milestoneIds.has(item.id)))));
    const removedRequests = next.milestoneRequests.filter(request => request.projectId === project.id && (projectDeletion || request.status === 'pending' && milestoneIds.has(request.milestoneId)));
    next.tasks = next.tasks.filter(item => !taskIds.has(item.id));
    next.milestones = next.milestones.filter(item => !milestoneIds.has(item.id));
    next.extensions = next.extensions.filter(item => !removedExtensions.includes(item));
    next.milestoneRequests = next.milestoneRequests.filter(item => !removedRequests.includes(item));
    const history = projectDeletion ? next.logs.filter(item => item.projectId === project.id) : [];
    if (projectDeletion) {
      if (next.projectPlans) next.projectPlans = next.projectPlans.filter(plan => plan.projectId !== project.id);
      next.projects = next.projects.filter(item => item.id !== project.id);
      next.logs = next.logs.filter(item => item.projectId !== project.id);
    }
    const pendingCount = [...removedExtensions, ...removedRequests].filter(item => item.status === 'pending').length;
    const changes = {
      tasks: { before: structuredClone(removedTasks), after: [] },
      ...(removedMilestones.length ? { milestones: { before: structuredClone(removedMilestones), after: [] } } : {}),
      ...(removedExtensions.length ? { extensions: { before: structuredClone(removedExtensions), after: [] } } : {}),
      ...(removedRequests.length ? { milestoneRequests: { before: structuredClone(removedRequests), after: [] } } : {}),
      ...(projectDeletion ? { project: { before: structuredClone(project), after: null }, projectLogs: { before: structuredClone(history), after: [] } } : {}),
    };
    record(projectDeletion ? null : project.id, `删除${projectDeletion ? '项目' : milestoneDeletion ? '大节点' : '小节点'}“${target.name || target.title}”${projectDeletion ? `（${project.id}）` : ''}${pendingCount ? `，同时撤销 ${pendingCount} 项关联待审批申请` : ''}`, changes);
  } else if (action === 'editTaskContent') {
    contentFields(payload, ['id', 'title', 'description', 'acceptance']);
    const task = find(next.tasks, payload.id, '任务');
    const project = find(next.projects, task.projectId, '项目');
    manageProject(actor, project);
    const content = {
      title: text(payload.title, '任务名称', 100),
      description: Object.hasOwn(payload, 'description') ? optionalText(payload.description) : task.description || '',
      acceptance: Object.hasOwn(payload, 'acceptance') ? text(payload.acceptance, '验收标准') : task.acceptance,
    };
    check(!['review', 'done'].includes(task.status) || content.acceptance === task.acceptance, '已提交验收或已完成任务的验收标准不能修改');
    const changes = contentChanges(task, content);
    check(Object.keys(changes).length > 0, '任务内容没有变化，无需保存');
    Object.assign(task, content);
    record(project.id, `编辑小节点“${task.title}”的文字内容`, changes);
  } else if (action === 'updateTask') {
    const task = find(next.tasks, payload.id, '任务');
    const project = find(next.projects, task.projectId, '项目');
    canChangeTask(actor, task, project);
    check(payload.status !== 'blocked' && payload.blocker == null, '受阻功能已移除，请更新任务状态或说明');
    if (payload.status != null) {
      check(['todo', 'doing'].includes(payload.status), '任务必须提交成果并通过验收后才能完成');
      check(payload.status !== 'todo' || !task.deliveries?.length, '已有成员提交成果，任务须保持进行中');
      task.status = payload.status;
    }
    if (payload.description != null) {
      manageProject(actor, project);
      task.description = optionalText(payload.description);
    }
    record(project.id, `更新任务“${task.title}”`);
  } else if (action === 'submitTask') {
    const task = find(next.tasks, payload.id, '任务');
    requireProjectAccess(actor, find(next.projects, task.projectId, '项目'));
    check(taskOwners(task).includes(actor.id) || isAdminRole(actor.role), '仅任务负责人或管理员可以提交成果');
    check(['todo', 'doing'].includes(task.status), '该任务已提交或已完成');
    const owners = taskOwners(task);
    check(canSubmitTask(task,actor), '多人任务须由每位成员本人分别提交，每轮仅提交一次');
    const deliverable = text(payload.deliverable, '成果说明或链接', 4000);
    if (owners.length > 1) {
      (task.deliveries ??= []).push({ownerId:actor.id, at, deliverable});
      const ready = owners.every(id => task.deliveries.some(item => item.ownerId === id));
      task.status = ready ? 'review' : 'doing';
      if (ready) {
        task.submittedAt = at;
        task.deliverable = task.deliveries.map(item => find(next.users,item.ownerId,'执行成员').name + '：' + item.deliverable).join('\n');
      }
      record(task.projectId, `提交“${task.title}”的个人成果（${task.deliveries.length}/${owners.length}），${ready?'已交齐，等待验收':'等待其他成员提交'}`);
    } else {
      task.deliverable = deliverable;
      task.submittedBy = actor.id;
      task.submittedAt = at;
      task.status = 'review';
      record(task.projectId, `提交任务“${task.title}”的成果，等待验收`);
    }
    task.reviewSignatures = [];
  } else if (action === 'reviewTask') {
    const task = find(next.tasks, payload.id, '任务');
    requireProjectAccess(actor, find(next.projects, task.projectId, '项目'));
    check(task.status === 'review', '仅待验收任务可以进行验收');
    check(canReviewTask(task, actor), '仅尚未签字的指定验收人或总管理员可以验收任务');
    check(typeof payload.approve === 'boolean', '请选择通过或退回');
    const comment = payload.approve ? optionalText(payload.comment) : text(payload.comment, '退回原因');
    const seats = taskSignSeats(task, actor);
    const seat = payload.as ?? seats[0];
    check(seats.includes(seat), '你不能代替该验收人签字');
    task.reviewSignatures ??= [];
    if (payload.approve) task.reviewSignatures.push({actorId:actor.id, reviewerId:seat, at, comment});
    const complete = task.reviewSignatures.length === taskReviewers(task).length;
    task.reviewComment = comment;
    if (!payload.approve || complete) {
      if (task.reviewCount === 0) task.firstReviewPassed = payload.approve;
      task.reviewCount += 1;
      task.reviewedAt = at;
      task.status = payload.approve ? 'done' : 'doing';
    }
    if (!payload.approve) {
      restartDeliveries(task,comment,at);
      task.reviewSignatures = [];
    }
    const result = !payload.approve ? '退回修改' : complete ? '验收通过' : '已签字，等待其余验收人';
    record(task.projectId, `${result}：“${task.title}”${comment ? '；'+comment : ''}`, { reviewerId:seat });
  } else if (action === 'editMilestoneContent') {
    contentFields(payload, ['id', 'title', 'description']);
    const milestone = find(next.milestones, payload.id, '节点');
    const project = find(next.projects, milestone.projectId, '项目');
    manageProject(actor, project);
    const content = {
      title: text(payload.title, '节点名称', 100),
      description: Object.hasOwn(payload, 'description') ? optionalText(payload.description) : milestone.description,
    };
    const changes = contentChanges(milestone, content);
    check(Object.keys(changes).length > 0, '节点内容没有变化，无需保存');
    Object.assign(milestone, content);
    record(project.id, `编辑大节点“${milestone.title}”的文字内容`, changes);
  } else if (action === 'createMilestone' || action === 'requestMilestone' && payload.kind === 'create' && isAdminRole(actor.role)) {
    check(isAdminRole(actor.role), '仅管理员或总管理员可以直接创建大节点');
    const project = find(next.projects, payload.projectId, '项目');
    requireProjectAccess(actor, project);
    check(!payload.milestoneId, '新增节点不能指定现有节点');
    const proposed = { ...milestoneProposal(payload, project), ...stageStaff(next.users, project, payload) };
    validateMilestoneProposal(next, project, proposed, null);
    next.milestones.push({ id: uid('m'), projectId: project.id, ...proposed,
      description: optionalText(payload.description), originalDueDate: proposed.dueDate,
      status: 'pending', acceptedAt: null, createdBy: actor.id, createdAt: at });
    addParticipants(project, [...(proposed.memberIds || []), ...stageReviewers(proposed)]);
    record(project.id, `直接创建大节点“${proposed.title}”，已生效`);
  } else if (action === 'requestMilestone') {
    const project = find(next.projects, payload.projectId, '项目');
    requireProjectAccess(actor, project);
    check(['create', 'update'].includes(payload.kind), '节点申请类型无效');
    const proposed = milestoneProposal(payload, project);
    if (payload.kind === 'create' && (payload.memberIds?.length || payload.extraReviewerIds?.length)) {
      Object.assign(proposed,stageStaff(next.users, project, payload));
    }
    const reason = optionalText(payload.reason);
    let milestoneId = null;
    let before = null;
    if (payload.kind === 'update') {
      const milestone = find(next.milestones, payload.milestoneId, '节点');
      check(milestone.projectId === project.id, '节点不属于该项目');
      check(milestone.status !== 'done', '已完成节点不能修改');
      check(!next.milestoneRequests.some((item) => item.milestoneId === milestone.id && item.status === 'pending'), '该节点已有待审批的修改申请');
      check(milestone.title !== proposed.title || deadlineMs(milestone.dueDate) !== deadlineMs(proposed.dueDate), '节点计划没有实际变化，无需提交申请');
      milestoneId = milestone.id;
      before = milestoneSnapshot(milestone);
    } else {
      check(payload.milestoneId == null || payload.milestoneId === '', '新增节点申请不能指定现有节点');
      check(!next.milestoneRequests.some((item) => item.projectId === project.id && item.kind === 'create' && item.status === 'pending' && item.proposed.title === proposed.title), '该项目已有同名节点的待审批新增申请');
    }
    validateMilestoneProposal(next, project, proposed, milestoneId);
    next.milestoneRequests.unshift({
      id: uid('mr'), projectId: project.id, kind: payload.kind, milestoneId, applicantId: actor.id,
      before, proposed, reason, status: 'pending', createdAt: at,
      reviewedAt: null, reviewerId: null, comment: '',
    });
    record(project.id, `申请${payload.kind === 'create' ? '新增' : '修改'}节点“${proposed.title}”；待后台审批，当前计划保持生效`);
  } else if (action === 'reviewMilestoneRequest') {
    const request = find(next.milestoneRequests, payload.id, '节点申请');
    const project = find(next.projects, request.projectId, '项目');
    requireProjectAccess(actor, project);
    check(canApproveProject(project, actor), '仅项目负责人或管理员可以审批申请');
    check(actor.id !== request.applicantId || isAdminRole(actor.role), '不能审批自己提交的申请，请由管理员处理');
    check(request.status === 'pending', '该节点申请已处理');
    check(typeof payload.approve === 'boolean', '请选择批准或驳回');
    const comment = optionalText(payload.comment);
    let planChanged = false;
    if (payload.approve) {
      const applicant = find(next.users, request.applicantId, '申请人');
      check(isAdminRole(applicant.role) || applicant.id === project.ownerId || project.memberIds.includes(applicant.id), '申请人已无项目访问权限，请驳回后由现有项目成员重新申请');
      check(['create', 'update'].includes(request.kind), '节点申请类型无效');
      const proposed = milestoneProposal(request.proposed, project);
      optionalText(request.reason);
      if (request.kind === 'update') {
        const milestone = find(next.milestones, request.milestoneId, '节点');
        check(milestone.projectId === project.id, '节点不属于该项目');
        check(milestone.status !== 'done', '已完成节点不能修改');
        check(request.before && ['title', 'status'].every((key) => milestone[key] === request.before[key]) && deadlineMs(milestone.dueDate) === deadlineMs(request.before.dueDate), '节点计划已变化，请驳回后重新提交申请');
        planChanged = milestone.title !== proposed.title || deadlineMs(milestone.dueDate) !== deadlineMs(proposed.dueDate);
        // Previously valid weight-only requests may still be closed; the retired
        // field remains in their audit record but never changes the live plan.
        const historicalWeightChange = Object.hasOwn(request.before, 'weight') && Object.hasOwn(request.proposed, 'weight') && request.before.weight !== request.proposed.weight;
        check(planChanged || historicalWeightChange, '节点计划没有实际变化，无需批准');
        validateMilestoneProposal(next, project, proposed, milestone.id);
        // Keep the first agreed deadline and all task dates intact.
        Object.assign(milestone, proposed);
      } else {
        if (request.proposed.memberIds || request.proposed.coReviewerId) Object.assign(proposed,stageStaff(next.users,project,request.proposed));
        check(request.milestoneId == null && request.before == null, '新增节点申请数据无效');
        validateMilestoneProposal(next, project, proposed, null);
        next.milestones.push({
          id: uid('m'), projectId: project.id, ...proposed, description: '',
          originalDueDate: proposed.dueDate, status: 'pending', acceptedAt: null,
        });
        addParticipants(project,[...(proposed.memberIds || []),...stageReviewers(proposed)]);
        planChanged = true;
      }
    }
    request.status = payload.approve ? 'approved' : 'rejected';
    request.reviewedAt = at;
    request.reviewerId = actor.id;
    request.comment = comment;
    record(request.projectId, `${payload.approve ? '批准' : '驳回'}${request.kind === 'create' ? '新增' : '修改'}节点申请“${request.proposed.title}”${payload.approve ? (planChanged ? '，节点计划已生效，任务日期保持不变' : '，记录已结案，当前计划保持不变') : '，原计划继续生效'}${comment ? `；${comment}` : ''}`);
  } else if (action === 'completeMilestone') {
    check(Object.keys(payload).every(key => ['id', 'as'].includes(key)), '签字必须由当前账号本人进行');
    const milestone = find(next.milestones, payload.id, '节点');
    const project = find(next.projects, milestone.projectId, '项目');
    requireProjectAccess(actor, project);
    check(milestone.status !== 'done', '节点已验收');
    const tasks = next.tasks.filter(task => task.projectId === project.id && task.milestoneId === milestone.id);
    check(tasks.length > 0, '请先为节点添加任务和交付物');
    check(tasks.every(task => task.status === 'done'), '节点下所有任务通过验收后才可完成节点');
    const slots = milestoneSignSlots(project, milestone, actor, tasks);
    const position = payload.as === undefined ? slots[0] : payload.as;
    check(slots.includes(position), '当前账号没有该签字权限，或已在此节点签字');
    milestone.signatures ??= [];
    milestone.signatures.push({ actorId: actor.id, as: position, at });
    const required = stageSeats(project, milestone).map(([slot]) => slot);
    const complete = required.every(slot => milestone.signatures.some(signature => signature.as === slot));
    if (complete) {
      milestone.status = 'done';
      milestone.acceptedAt = at;
    }
    record(project.id, `在“${milestone.title}”签署${position === 'owner' ? '负责人' : '加验人'}意见，${complete ? '节点验收完成' : '等待其余人员验收'}`);
  } else if (action === 'requestExtension') {
    const project = find(next.projects, payload.projectId, '项目');
    requireProjectAccess(actor, project);
    check(!next.extensions.some((item) => item.projectId === project.id && item.status === 'pending'), '该项目已有待审批的延期申请');
    check(payload.targetType == null || ['project', 'milestone', 'task'].includes(payload.targetType), '延期节点类型无效');
    const nodePlan = payload.targetType && payload.targetType !== 'project' ? nodeExtensionPlan(next, payload) : null;
    const newDueDate = nodePlan?.newDueDate || validSchedule(payload.newDueDate, '申请截止日期');
    if (!nodePlan) check(deadlineMs(newDueDate) > deadlineMs(project.dueDate), '申请日期必须晚于当前截止日期');
    check(deadlineMs(nodePlan?.newTargetDueDate || newDueDate) >= Date.now(), '申请截止时间不能早于当前时间');
    const prepareAdjustments = (value, collection, label) => {
      check(value == null || Array.isArray(value), `${label}调整列表无效`);
      const adjustments = value || [];
      check(new Set(adjustments.map((item) => item.id)).size === adjustments.length, `${label}调整不能重复`);
      return adjustments.map((item) => {
        const target = find(collection, item.id, label);
        check(target.projectId === project.id, `${label}不属于该项目`);
        check(target.status !== 'done', `已完成的${label}不能延期`);
        const dueDate = validSchedule(item.newDueDate, `${label}调整日期`);
        check(deadlineMs(dueDate) > deadlineMs(target.dueDate), `${label}调整日期必须晚于当前日期`);
        check(deadlineMs(dueDate) <= deadlineMs(newDueDate), `${label}调整日期不能晚于项目新截止日期`);
        return { id: target.id, originalDueDate: target.dueDate, newDueDate: dueDate };
      });
    };
    const affectedMilestones = prepareAdjustments(nodePlan?.affectedMilestones || payload.affectedMilestones, next.milestones, '节点');
    const affectedTasks = prepareAdjustments(nodePlan?.affectedTasks || payload.affectedTasks, next.tasks, '任务');
    // Validate the proposed schedule on a separate copy; pending requests never alter live dates.
    const proposed = structuredClone(next);
    const proposedProject = find(proposed.projects, project.id, '项目');
    proposedProject.dueDate = newDueDate;
    affectedMilestones.forEach((item) => { find(proposed.milestones, item.id, '节点').dueDate = item.newDueDate; });
    affectedTasks.forEach((item) => { find(proposed.tasks, item.id, '任务').dueDate = item.newDueDate; });
    validateSchedule(proposed, proposedProject);
    const extension = {
      id: uid('e'), projectId: project.id, applicantId: actor.id, originalDueDate: project.dueDate,
      ...(nodePlan || {}), newDueDate, reason: optionalText(payload.reason), plan: text(payload.plan, '后续安排'),
      impact: text(payload.impact, '影响范围'), status: 'pending', affectedMilestones, affectedTasks,
      createdAt: at, reviewedAt: null, reviewerId: null, comment: '',
    };
    next.extensions.unshift(extension);
    record(project.id, `申请${nodePlan ? `节点“${nodePlan.targetTitle}”` : '项目'}延期：${nodePlan?.originalTargetDueDate || project.dueDate} → ${nodePlan?.newTargetDueDate || newDueDate}；待审批，当前计划保持生效`);
  } else if (action === 'reviewExtension') {
    const extension = find(next.extensions, payload.id, '延期申请');
    const project = find(next.projects, extension.projectId, '项目');
    requireProjectAccess(actor, project);
    check(canApproveProject(project, actor, 'extension'), '仅项目负责人或总管理员可以审批申请');
    check(actor.id !== extension.applicantId || actor.role === 'superadmin', '不能审批自己提交的延期申请，请由总管理员处理');
    check(extension.status === 'pending', '该延期申请已处理');
    check(typeof payload.approve === 'boolean', '请选择批准或驳回');
    const comment = optionalText(payload.comment);
    if (payload.approve) {
      check(deadlineMs(project.dueDate) === deadlineMs(extension.originalDueDate), '项目计划已变化，请重新提交延期申请');
      validSchedule(extension.newDueDate, '申请截止日期');
      if (extension.targetType && extension.targetType !== 'project') {
        const planned = nodeExtensionPlan(next, { ...extension, newDueDate: extension.newTargetDueDate });
        check(deadlineMs(planned.originalTargetDueDate) === deadlineMs(extension.originalTargetDueDate)
          && planned.parentMilestoneId === extension.parentMilestoneId
          && JSON.stringify(planned.affectedMilestones) === JSON.stringify(extension.affectedMilestones)
          && JSON.stringify(planned.affectedTasks) === JSON.stringify(extension.affectedTasks)
          && deadlineMs(planned.newDueDate) === deadlineMs(extension.newDueDate), '节点计划已变化，请驳回后重新提交延期申请');
      } else check(deadlineMs(extension.newDueDate) > deadlineMs(project.dueDate), '申请日期必须晚于当前截止日期');
      check(deadlineMs(extension.newTargetDueDate || extension.newDueDate) >= Date.now(), '申请的新截止日期已经过去，请驳回后重新申请');
      project.dueDate = extension.newDueDate;
      for (const item of extension.affectedMilestones) {
        const target = find(next.milestones, item.id, '节点');
        check(target.projectId === project.id && target.status !== 'done', '相关节点已完成或变更，请重新申请');
        check(!item.originalDueDate || deadlineMs(item.originalDueDate) === deadlineMs(target.dueDate), '节点计划已变化，请驳回后重新提交延期申请');
        check(deadlineMs(item.newDueDate) > deadlineMs(target.dueDate), '节点计划已变化，请驳回后重新提交延期申请');
        target.dueDate = item.newDueDate;
      }
      for (const item of extension.affectedTasks) {
        const target = find(next.tasks, item.id, '任务');
        check(target.projectId === project.id && target.status !== 'done', '相关任务已完成或变更，请重新申请');
        check(!item.originalDueDate || deadlineMs(item.originalDueDate) === deadlineMs(target.dueDate), '任务计划已变化，请驳回后重新提交延期申请');
        check(deadlineMs(item.newDueDate) > deadlineMs(target.dueDate), '任务计划已变化，请驳回后重新提交延期申请');
        target.dueDate = item.newDueDate;
      }
      validateSchedule(next, project);
    }
    extension.status = payload.approve ? 'approved' : 'rejected';
    extension.reviewedAt = at;
    extension.reviewerId = actor.id;
    extension.comment = comment;
    record(project.id, `${payload.approve ? '批准' : '驳回'}${extension.targetTitle ? `节点“${extension.targetTitle}”` : '项目'}延期申请${payload.approve ? `，截止日期调整为 ${extension.newTargetDueDate || project.dueDate}，保留原计划` : '，原计划继续生效'}${comment ? `；${comment}` : ''}`);
  } else if (action === 'addUser') {
    check(isAdminRole(actor.role), '仅管理员可以添加成员');
    check(ROLES.includes(payload.role), '成员角色无效');
    check(actor.role === 'superadmin' || payload.role === 'member', '仅总管理员可以添加管理员');
    const user = {
      id: uid('u'), name: text(payload.name, '姓名', 30), title: text(payload.title, '岗位', 60),
      department: text(payload.department, '部门', 60), role: payload.role,
      color: ['#52756e', '#526ba0', '#977951', '#8a6e9b'][next.users.length % 4],
    };
    next.users.push(user);
    record(null, `添加成员 ${user.name} · ${user.department}`);
  } else {
    throw new Error('不支持的操作');
  }
  for (const milestone of next.milestones) {
    if (milestone.status === 'done' || !milestone.signatures?.length || action === 'completeMilestone') continue;
    const before = state.milestones.find(item => item.id === milestone.id);
    const children = snapshot => snapshot.tasks.filter(task => task.projectId === milestone.projectId && task.milestoneId === milestone.id);
    const projectDeadline = snapshot => snapshot.projects.find(project => project.id === milestone.projectId)?.dueDate;
    const changed = !before || ['title', 'description', 'dueDate', 'coReviewerId'].some(key => before[key] !== milestone[key])
      || ['memberIds','extraReviewerIds'].some(key => JSON.stringify(before?.[key] || []) !== JSON.stringify(milestone[key] || []))
      || projectDeadline(state) !== projectDeadline(next) || JSON.stringify(children(state)) !== JSON.stringify(children(next));
    if (changed) {
      const previous = milestone.signatures;
      milestone.signatures = [];
      record(milestone.projectId, `“${milestone.title}”的验收依据已变更，原签字失效`, { signatures: { before: previous, after: [] } });
    }
  }
  return next;
}

export function createSeedState() {
  const now = today();
  const d = (n) => addDays(now, n);
  const at = (n, hour = '09') => `${d(n)}T${hour}:00:00+08:00`;
  const users = [
    { id: 'u-admin', name: '周予安', role: 'admin', title: '运营总监', department: '管理中心', color: '#546a98' },
    { id: 'u-manager', name: '陈亦舟', role: 'member', title: '项目负责人', department: '项目管理', color: '#94784e' },
    { id: 'u-engineer', name: '林知远', role: 'member', title: '硬件工程师', department: '产品研发', color: '#4e7b72' },
    { id: 'u-design', name: '许知夏', role: 'member', title: '设计师', department: '品牌设计', color: '#a17169' },
    { id: 'u-ops', name: '方以宁', role: 'member', title: '交付负责人', department: '运营交付', color: '#81709d' },
    { id: 'u-qa', name: '陆景和', role: 'member', title: '测试工程师', department: '质量管理', color: '#65825c' },
  ];
  // The legacy project reviewer field is retained only for historical compatibility.
  const projects = [
    { id: 'p-mower', code: 'DF-001', name: '智能割草机器人 · 样机验证', description: '完成样机的场景测试与问题闭环，形成可验收的验证报告。此项目与成员均为演示数据。', category: '产品研发', ownerId: 'u-manager', reviewerId: null, memberIds: ['u-manager', 'u-engineer', 'u-design', 'u-qa'], startDate: d(-25), originalDueDate: d(12), dueDate: d(12), color: '#557658' },
    { id: 'p-pcb', code: 'DF-002', name: '电子控制板 · 研发交付', description: '完成控制板设计评审、样板联调和交付资料归档。演示项目。', category: '电子研发', ownerId: 'u-manager', reviewerId: null, memberIds: ['u-manager', 'u-engineer', 'u-qa'], startDate: d(-20), originalDueDate: d(7), dueDate: d(7), color: '#a4804d' },
    { id: 'p-site', code: 'DF-003', name: '品牌官网 · 内容与体验升级', description: '完善品牌内容、页面设计和响应式体验，完成内部验收。演示项目。', category: '品牌建设', ownerId: 'u-manager', reviewerId: null, memberIds: ['u-manager', 'u-design', 'u-ops'], startDate: d(-18), originalDueDate: d(5), dueDate: d(5), color: '#677cad' },
    { id: 'p-delivery', code: 'DF-004', name: '交付流程 · 标准化试运行', description: '明确项目交接标准、责任人与异常处理流程，完成一轮试运行。演示项目。', category: '运营管理', ownerId: 'u-ops', reviewerId: null, memberIds: ['u-ops', 'u-manager', 'u-qa'], startDate: d(-30), originalDueDate: d(-2), dueDate: d(6), color: '#8a749b' },
  ];
  const milestones = [
    { id: 'm-mower-1', projectId: 'p-mower', title: '测试方案与准备', due: -10, done: true },
    { id: 'm-mower-2', projectId: 'p-mower', title: '核心场景测试', due: 3 },
    { id: 'm-mower-3', projectId: 'p-mower', title: '问题闭环与报告验收', due: 12 },
    { id: 'm-pcb-1', projectId: 'p-pcb', title: '设计评审通过', due: -7, done: true },
    { id: 'm-pcb-2', projectId: 'p-pcb', title: '样板联调完成', due: 2 },
    { id: 'm-pcb-3', projectId: 'p-pcb', title: '交付资料验收', due: 7 },
    { id: 'm-site-1', projectId: 'p-site', title: '内容结构确认', due: -8, done: true },
    { id: 'm-site-2', projectId: 'p-site', title: '视觉方案通过', due: -2, done: true },
    { id: 'm-site-3', projectId: 'p-site', title: '页面体验验收', due: 5 },
    { id: 'm-delivery-1', projectId: 'p-delivery', title: '交接标准确认', due: -15, done: true },
    { id: 'm-delivery-2', projectId: 'p-delivery', title: '流程模板验收', due: -8, done: true },
    { id: 'm-delivery-3', projectId: 'p-delivery', title: '试运行复盘完成', due: 6, original: -2 },
  ].map(({ due, original, done, ...m }) => ({ ...m, description: '', originalDueDate: d(original ?? due), dueDate: d(due), status: done ? 'done' : 'pending', acceptedAt: done ? at(due) : null }));
  const seeds = [
    ['t-01', 'p-mower', 'm-mower-1', '整理样机场景测试清单', 'u-qa', -11, 'done', 'normal'],
    ['t-02', 'p-mower', 'm-mower-2', '完成坡地行走连续测试', 'u-qa', 0, 'doing', 'high'],
    ['t-03', 'p-mower', 'm-mower-2', '排查避障传感器误触发', 'u-engineer', -1, 'doing', 'high'],
    ['t-04', 'p-mower', 'm-mower-2', '提交样机外观细节检查', 'u-design', 1, 'review', 'normal'],
    ['t-05', 'p-mower', 'm-mower-3', '汇总样机问题闭环报告', 'u-qa', 10, 'todo', 'normal'],
    ['t-06', 'p-pcb', 'm-pcb-1', '完成控制板原理图评审', 'u-engineer', -8, 'done', 'high'],
    ['t-07', 'p-pcb', 'm-pcb-2', '联调电机控制接口', 'u-engineer', 0, 'doing', 'high'],
    ['t-08', 'p-pcb', 'm-pcb-2', '执行样板上电测试', 'u-qa', 2, 'todo', 'high'],
    ['t-09', 'p-pcb', 'm-pcb-3', '整理版本及交付文件', 'u-engineer', 7, 'todo', 'normal'],
    ['t-10', 'p-site', 'm-site-1', '确认官网信息结构', 'u-design', -9, 'done', 'normal'],
    ['t-11', 'p-site', 'm-site-2', '提交首页视觉方案', 'u-design', -2, 'done', 'normal'],
    ['t-12', 'p-site', 'm-site-3', '补齐产品页内容与图片', 'u-ops', 0, 'review', 'normal'],
    ['t-13', 'p-site', 'm-site-3', '检查移动端阅读体验', 'u-design', 3, 'doing', 'normal'],
    ['t-14', 'p-site', 'm-site-3', '汇总上线前检查意见', 'u-ops', 5, 'todo', 'low'],
    ['t-15', 'p-delivery', 'm-delivery-1', '梳理项目交接责任表', 'u-manager', -16, 'done', 'normal'],
    ['t-16', 'p-delivery', 'm-delivery-2', '确认交付验收记录模板', 'u-qa', -9, 'done', 'normal'],
    ['t-17', 'p-delivery', 'm-delivery-3', '完成首轮交接演练', 'u-qa', 1, 'doing', 'high'],
    ['t-18', 'p-delivery', 'm-delivery-3', '提交试运行复盘与修订', 'u-manager', 6, 'todo', 'normal'],
  ];
  const tasks = seeds.map(([id, projectId, milestoneId, title, ownerId, due, status, priority]) => {
    const reviewed = status === 'done';
    const submitted = reviewed || status === 'review';
    return {
      id, projectId, milestoneId, title, ownerId,
      reviewerId: projectId === 'p-delivery' ? 'u-ops' : 'u-manager',
      originalDueDate: d(id === 't-17' ? -3 : id === 't-18' ? -2 : due), dueDate: d(due), status, priority,
      description: '按约定范围推进，相关讨论与最终成果请记录在任务内。此记录用于功能演示。',
      acceptance: '提交完整记录与成果说明，由指定验收人确认内容完整、问题已说明。',
      deliverable: submitted ? '已提交演示成果说明，关键检查项已完成，待负责人确认。' : '',
      submittedAt: submitted ? at(Math.min(due, -1)) : null,
      reviewedAt: reviewed ? at(due, '15') : null, reviewCount: reviewed ? (id === 't-11' ? 2 : 1) : 0,
      firstReviewPassed: reviewed ? id !== 't-11' : null, reviewComment: reviewed ? '演示成果已达到当前验收标准。' : '',
    };
  });
  const extensions = [
    { id: 'e-pending', projectId: 'p-pcb', applicantId: 'u-manager', originalDueDate: d(7), newDueDate: d(12), reason: '关键连接器交期调整，样板联调需要顺延。', plan: '先完成可独立测试的模块，物料到齐后集中联调并补齐交付文件。', impact: '样板联调与资料交付节点顺延，其他项目暂不受影响。', status: 'pending', affectedMilestones: [{ id: 'm-pcb-2', newDueDate: d(7) }, { id: 'm-pcb-3', newDueDate: d(12) }], affectedTasks: [{ id: 't-07', newDueDate: d(5) }, { id: 't-08', newDueDate: d(7) }, { id: 't-09', newDueDate: d(12) }], createdAt: at(-1, '14'), reviewedAt: null, reviewerId: null, comment: '' },
    { id: 'e-approved', projectId: 'p-delivery', applicantId: 'u-ops', originalDueDate: d(-2), newDueDate: d(6), reason: '试运行增加一轮跨部门交接演练。', plan: '补充演练记录后再完成复盘验收。', impact: '仅调整试运行节点及两项关联任务。', status: 'approved', affectedMilestones: [{ id: 'm-delivery-3', newDueDate: d(6) }], affectedTasks: [{ id: 't-17', newDueDate: d(1) }, { id: 't-18', newDueDate: d(6) }], createdAt: at(-6), reviewedAt: at(-5, '14'), reviewerId: 'u-admin', comment: '同意增加一轮验证，请按调整后的计划完成。' },
  ];
  const logs = [
    { id: 'l-1', at: at(-1, '16'), actorId: 'u-design', projectId: 'p-mower', message: '提交“样机外观细节检查”，等待验收' },
    { id: 'l-2', at: at(-1, '14'), actorId: 'u-manager', projectId: 'p-pcb', message: '提交项目延期申请，申请顺延 5 天，等待后台审批' },
    { id: 'l-3', at: at(-2, '15'), actorId: 'u-manager', projectId: 'p-site', message: '验收通过“首页视觉方案”，视觉方案节点完成' },
    { id: 'l-4', at: at(-5, '14'), actorId: 'u-admin', projectId: 'p-delivery', message: '批准试运行延期 8 天，同步调整关联任务；原计划保留' },
  ];
  return { version: 1, users, projects, milestones, tasks, extensions, milestoneRequests: [], logs };
}
