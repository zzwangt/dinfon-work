import { isAdminRole } from '../public/client/roles.js';
// Events commit in the same workspace CAS as the business change. Read receipts
// live separately, so opening a notification never conflicts with a task edit.
// Old workspaces start with an empty event stream; historical logs are not replayed.
import { canApproveRequest, canSignMilestone, canReviewTask } from '../public/client/approval-access.js';

const schemaReady = new WeakMap();

async function initializeReadReceipts(db) {
  if (!schemaReady.has(db)) {
    const ready = db.prepare('CREATE TABLE IF NOT EXISTS notification_reads (account_id TEXT NOT NULL, notification_id TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY (account_id, notification_id))').run();
    schemaReady.set(db, ready);
    ready.catch(() => schemaReady.delete(db));
  }
  await schemaReady.get(db);
}

const projectMembers = (project) => new Set([project?.ownerId, ...(project?.memberIds || [])].filter(Boolean));
const hasProjectAccess = (state, user, projectId) => {
  const project = state.projects.find((entry) => entry.id === projectId);
  return Boolean(project && (isAdminRole(user?.role) || projectMembers(project).has(user?.id)));
};
const newEntry = (before, after) => after.find((entry) => !before.some((old) => old.id === entry.id));

export function workspacePayload(workspace) {
  return JSON.stringify({ state: workspace.state, accounts: workspace.accounts, notifications: workspace.notifications || [], ...(workspace.accountPolicyVersion ? { accountPolicyVersion: workspace.accountPolicyVersion } : {}) });
}

/** Called only after the domain command succeeds, before its atomic CAS save. */
export function appendNotifications(previous, next, actorId, action, payload = {}) {
  next.notifications = [...(previous.notifications || [])];
  const state = next.state;
  const admins = state.users.filter((user) => isAdminRole(user.role)).map((user) => user.id);
  const projectAudience = (projectId) => [...projectMembers(state.projects.find((project) => project.id === projectId)), ...admins];
  const createdAt = state.logs.find((entry) => !previous.state.logs.some((old) => old.id === entry.id))?.at || new Date().toISOString();
  const emitted = new Set();
  const emit = (recipients, data) => {
    for (const account of next.accounts) {
      const user = state.users.find((entry) => entry.id === account.userId);
      if (account.status !== 'active' || !user || user.id === actorId || !recipients.includes(user.id)) continue;
      if (!hasProjectAccess(action === 'deleteProject' ? previous.state : state, user, data.projectId)) continue;
      // One operation appears once per recipient, even when they hold several roles.
      const key = `${account.id}:${data.entityId}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      next.notifications.unshift({ id: `n-${crypto.randomUUID()}`, accountId: account.id, action, createdAt, ...data });
    }
  };
  const projectNotice = (project, title, entityId = project.id, recipients = projectAudience(project.id)) =>
    emit(recipients, { category: 'projects', projectId: project.id, entityId, title, target: `#projects/${project.id}` });

  const signatureNotice = node => {
    const project = state.projects.find(item => item.id === node?.projectId);
    if (!project || !node) return;
    next.notifications = next.notifications.filter(entry => entry.action !== 'milestoneSignatureNeeded' || entry.entityId !== node.id);
    const signers = [project.ownerId, node.coReviewerId].filter(id => {
      const user = state.users.find(person => person.id === id);
      return user && canSignMilestone(project, node, user, state.tasks);
    });
    emit(signers, {action:'milestoneSignatureNeeded', category:'projects', projectId:project.id, entityId:node.id,
      title:`阶段待你签字：${node.title}`, target:`#projects/${project.id}`});
  };

  if (action === 'createProject') {
    const project = newEntry(previous.state.projects, state.projects);
    if (project) projectNotice(project, `你参与的项目已建立：${project.name}`);
  } else if (['deleteTask', 'deleteMilestone', 'deleteProject'].includes(action)) {
    const wholeProject = action === 'deleteProject';
    const target = previous.state[wholeProject ? 'projects' : action === 'deleteMilestone' ? 'milestones' : 'tasks'].find(entry => entry.id === payload.id);
    const project = previous.state.projects.find(entry => entry.id === (wholeProject ? target?.id : target?.projectId));
    if (target && project) {
      emit([...projectMembers(project), ...admins], { category: 'projects', projectId: project.id, entityId: project.id,
        title: `${wholeProject ? '项目' : action === 'deleteMilestone' ? '大节点' : '小节点'}已删除：${target.name || target.title}`, target: wholeProject ? '#overview' : `#projects/${project.id}` });
    }
  } else if (action === 'setMilestoneCoReviewer') {
    const node = state.milestones.find(item => item.id === payload.id);
    const project = state.projects.find(item => item.id === node?.projectId);
    if (node && project) {
      signatureNotice(node);
      projectNotice(project, `阶段加验人已更新：${node.title}`, node.id, [project.ownerId, node.coReviewerId]);
    }
  } else if (['createTask', 'updateTask', 'editTaskContent', 'setTaskReviewer', 'submitTask', 'reviewTask'].includes(action)) {
    const task = action === 'createTask' ? newEntry(previous.state.tasks, state.tasks) : state.tasks.find((entry) => entry.id === payload.id);
    if (!task) return next;
    const before = previous.state.tasks.find((entry) => entry.id === task.id);
    if (action === 'updateTask' && before?.status === task.status && before?.description === task.description) return next;
    const project = state.projects.find((entry) => entry.id === task.projectId);
    if (['submitTask', 'reviewTask', 'setTaskReviewer'].includes(action)) {
      next.notifications = next.notifications.filter(entry => entry.action !== 'submitTask' || entry.entityId !== task.id);
    }
    if (action === 'reviewTask' && task.status === 'done') signatureNotice(state.milestones.find(node => node.id === task.milestoneId));
    if (action === 'submitTask' || (action === 'setTaskReviewer' && task.status === 'review')) {
      const reviewer = state.users.find(user => user.id === task.reviewerId);
      if (reviewer && canReviewTask(task, reviewer)) emit([reviewer.id], {action:'submitTask', category:'tasks', projectId:task.projectId, entityId:task.id, title:`任务待验收：${task.title}`, target:'#tasks'});
      if (action === 'submitTask') return next;
    }
    const label = action === 'setTaskReviewer' ? '任务验收人已更新' : action === 'createTask' ? '新增任务' : action === 'editTaskContent' ? '任务内容已更新' : action === 'reviewTask' ? (task.status === 'done' ? '任务验收通过' : '任务退回修改') : before?.status !== task.status ? (task.status === 'doing' ? '任务已开始' : '任务恢复待办') : '任务说明已更新';
    emit(action === 'editTaskContent' ? projectAudience(task.projectId) : [task.ownerId, task.reviewerId, project?.ownerId, ...admins], {
      category: 'tasks', projectId: task.projectId, entityId: task.id,
      title: `${label}：${task.title}`, target: '#tasks',
    });
  } else if (['requestMilestone', 'requestExtension', 'reviewMilestoneRequest', 'reviewExtension'].includes(action)) {
    const milestone = action.includes('Milestone');
    const before = milestone ? previous.state.milestoneRequests || [] : previous.state.extensions;
    const after = milestone ? state.milestoneRequests || [] : state.extensions;
    const requesting = action.startsWith('request');
    const request = requesting ? newEntry(before, after) : after.find((entry) => entry.id === payload.id);
    if (!request) return next;
    const project = state.projects.find((entry) => entry.id === request.projectId);
    const label = milestone ? '节点申请' : '延期申请';
    const subject = milestone ? request.proposed.title : project.name;
    emit(requesting ? [project.ownerId, ...state.users.filter(user => user.role === 'superadmin').map(user => user.id)] : [request.applicantId], {
      category: 'approvals', projectId: project.id, entityId: request.id,
      title: `${label}${requesting ? '待审批' : request.status === 'approved' ? '已批准' : '已驳回'}：${subject}`,
      target: '#approvals',
    });
    if (!requesting && request.status === 'approved') {
      projectNotice(project, `${milestone ? '节点计划已更新' : '项目截止时间已调整'}：${subject}`, request.id);
    }
  } else if (action === 'completeMilestone' || action === 'editMilestoneContent') {
    const node = state.milestones.find((entry) => entry.id === payload.id);
    const project = state.projects.find((entry) => entry.id === node?.projectId);
    if (action === 'completeMilestone' && node?.status !== 'done') { signatureNotice(node); return next; }
    if (node && project) projectNotice(project, `${action === 'editMilestoneContent' ? '大节点内容已更新' : '大节点已完成'}：${node.title}`, node.id);
  } else if (action === 'accountMemberships') {
    for (const project of state.projects) {
      const before = previous.state.projects.find((entry) => entry.id === project.id);
      const oldMembers = projectMembers(before);
      const members = projectMembers(project);
      const added = [...members].filter((id) => !oldMembers.has(id));
      const removed = [...oldMembers].filter((id) => !members.has(id));
      const newAccounts = next.accounts.filter((account) => !previous.accounts.some((old) => old.id === account.id) && members.has(account.userId));
      const newlyJoined = [...new Set([...added, ...newAccounts.map((account) => account.userId)])];
      if (newlyJoined.length) projectNotice(project, `你已加入项目：${project.name}`, project.id, newlyJoined);
      if (added.length || removed.length) {
        const names = (ids) => ids.map((id) => state.users.find((user) => user.id === id)?.name || '成员').join('、');
        const changes = [added.length ? `${names(added)}加入` : '', removed.length ? `${names(removed)}移出` : ''].filter(Boolean).join('；');
        projectNotice(project, `项目成员已更新：${project.name}（${changes}）`);
      }
    }
  }
  return next;
}

function visibleNotifications(workspace, account, actor) {
  if (account.status !== 'active') return [];
  return (workspace.notifications || []).filter((entry) => {
    if (entry.accountId !== account.id) return false;
    if (entry.action === 'deleteProject' && entry.category === 'projects' && !workspace.state.projects.some(project => project.id === entry.projectId)) return true;
    if (!hasProjectAccess(workspace.state, actor, entry.projectId)) return false;
    if (entry.category === 'tasks') {
      const task = workspace.state.tasks.find(item => item.id === entry.entityId);
      if (!task) return false;
      if (entry.action === 'submitTask') return task.status === 'review' && task.reviewerId === actor.id && canReviewTask(task, actor);
    }
    if (entry.action === 'milestoneSignatureNeeded') {
      const node = workspace.state.milestones.find(item => item.id === entry.entityId);
      const project = workspace.state.projects.find(item => item.id === node?.projectId);
      if (!node || !project || ![node.coReviewerId, project.ownerId].includes(actor.id)) return false;
      if (node.coReviewerId && !workspace.accounts.some(account => account.userId === node.coReviewerId && account.status === 'active' && workspace.state.users.find(user => user.id === account.userId)?.role === 'admin')) return false;
      return canSignMilestone(project, node, actor, workspace.state.tasks);
    }
    if (entry.action === 'requestMilestone' || entry.action === 'requestExtension') {
      const project = workspace.state.projects.find((item) => item.id === entry.projectId);
      const requests = entry.action === 'requestMilestone' ? workspace.state.milestoneRequests || [] : workspace.state.extensions;
      return canApproveRequest(project, requests.find((item) => item.id === entry.entityId), actor);
    }
    return true;
  });
}

export async function unreadNotifications(db, workspace, account, actor) {
  const visible = visibleNotifications(workspace, account, actor);
  if (!visible.length) return [];
  await initializeReadReceipts(db);
  const row = await db.prepare("SELECT COALESCE(json_group_array(notification_id), '[]') AS ids FROM notification_reads WHERE account_id = ?").bind(account.id).first();
  const read = new Set(JSON.parse(row?.ids || '[]'));
  return visible.filter((entry) => !read.has(entry.id)).map((entry) => ({
    id: entry.id, category: entry.category, projectId: entry.projectId, entityId: entry.entityId,
    action: entry.action, title: entry.title, createdAt: entry.createdAt, target: entry.target,
  }));
}

/** The service validates ids. The recipient always comes from authentication. */
export async function markNotificationsRead(db, workspace, account, actor, ids) {
  const requested = new Set(ids);
  const visibleIds = visibleNotifications(workspace, account, actor).filter((entry) => requested.has(entry.id)).map((entry) => entry.id);
  if (visibleIds.length) {
    await initializeReadReceipts(db);
    await db.prepare('INSERT OR IGNORE INTO notification_reads (account_id, notification_id, read_at) SELECT ?, value, ? FROM json_each(?)')
      .bind(account.id, new Date().toISOString(), JSON.stringify(visibleIds)).run();
  }
  return unreadNotifications(db, workspace, account, actor);
}
