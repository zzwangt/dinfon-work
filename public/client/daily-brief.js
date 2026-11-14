import { canApproveRequest, canViewProjectPlan, milestoneSignSlots, taskOwners, taskSignSeats } from './approval-access.js';
import { datePart, deadlineMs, startMs } from './time.js';

function nodeEntry(node, project, kind) {
  return { id: node.id, title: node.title, projectId: project.id, projectName: project.name, dueDate: node.dueDate, status: node.status, kind };
}

function byDueDate(a, b) {
  const aDue = deadlineMs(a.dueDate);
  const bDue = deadlineMs(b.dueDate);
  if (!Number.isFinite(aDue)) return Number.isFinite(bDue) ? 1 : 0;
  return Number.isFinite(bDue) ? aDue - bDue : -1;
}

function byLatest(a, b) {
  return (startMs(b.at) || 0) - (startMs(a.at) || 0);
}

function approvalEntry(request, project, kind, title = project.name) {
  return { id: request.id, title, projectId: project.id, projectName: project.name, kind, at: request.createdAt };
}

// The server's session snapshot and unread notices are already scoped to this account.
export function buildDailyBrief({ state, actor, notifications = [], now = Date.now() }) {
  const timestamp = new Date(now);
  const time = timestamp.getTime();
  const day = Number.isFinite(time) ? datePart(timestamp.toISOString()) : '';
  const brief = {
    day, overdueTasks: [], todayTasks: [], upcomingTasks: [], waitingTasks: [], reviewTasks: [],
    signMilestones: [], approvals: [], activityGroups: [], unreadNotifications: [],
  };
  if (!state || !actor?.id || !day) return brief;

  const projects = new Map((state.projects || []).map(project => [project.id, project]));
  const tasks = state.tasks || [];
  const tasksByMilestone = new Map();
  for (const task of tasks) {
    const project = projects.get(task.projectId);
    if (!project) continue;
    const children = tasksByMilestone.get(task.milestoneId) || [];
    children.push(task);
    tasksByMilestone.set(task.milestoneId, children);

    const entry = nodeEntry(task, project, 'task');
    if (task.status === 'review' && taskSignSeats(task, actor).length) {
      brief.reviewTasks.push(entry);
      continue;
    }
    const owners = taskOwners(task);
    if (task.status === 'done' || !owners.includes(actor.id)) continue;
    const alreadyDelivered = owners.length > 1 && task.deliveries?.some(item => item.ownerId === actor.id);
    if (task.status === 'review' || alreadyDelivered) {
      brief.waitingTasks.push({ ...entry, reason: task.status === 'review' ? '等待验收' : '等其他负责人提交' });
      continue;
    }
    if (task.status !== 'todo' && task.status !== 'doing') continue;
    const due = deadlineMs(task.dueDate);
    if (!Number.isFinite(due)) continue;
    if (due < time) brief.overdueTasks.push(entry);
    else if (datePart(task.dueDate) === day) brief.todayTasks.push(entry);
    else brief.upcomingTasks.push(entry);
  }
  for (const node of state.milestones || []) {
    const project = projects.get(node.projectId);
    if (milestoneSignSlots(project, node, actor, tasksByMilestone.get(node.id)).length) {
      brief.signMilestones.push(nodeEntry(node, project, 'milestone'));
    }
  }
  for (const entries of [brief.overdueTasks, brief.todayTasks, brief.upcomingTasks, brief.waitingTasks, brief.reviewTasks, brief.signMilestones]) {
    entries.sort(byDueDate);
  }

  for (const plan of state.projectPlans || []) {
    if (plan.project && canViewProjectPlan(plan, actor) && canApproveRequest(plan.project, plan, actor)) {
      brief.approvals.push(approvalEntry(plan, plan.project, 'plan'));
    }
  }
  for (const request of state.milestoneRequests || []) {
    const project = projects.get(request.projectId);
    if (canApproveRequest(project, request, actor)) {
      brief.approvals.push(approvalEntry(request, project, 'nodeRequest', request.proposed?.title));
    }
  }
  for (const request of state.extensions || []) {
    const project = projects.get(request.projectId);
    if (canApproveRequest(project, request, actor)) {
      brief.approvals.push(approvalEntry(request, project, 'extension', request.targetTitle));
    }
  }
  brief.approvals.sort(byLatest);

  const names = new Map((state.users || []).map(user => [user.id, user.name]));
  const activityByProject = new Map();
  for (const log of state.logs || []) {
    const project = projects.get(log.projectId);
    if (!project || !log.message?.trim() || datePart(log.at) !== day || startMs(log.at) > time) continue;
    let group = activityByProject.get(project.id);
    if (!group) {
      group = { projectId: project.id, projectName: project.name, count: 0, events: [] };
      activityByProject.set(project.id, group);
    }
    group.events.push({ id: log.id, at: log.at, actorName: names.get(log.actorId) || '', message: log.message });
    group.count += 1;
  }
  for (const group of activityByProject.values()) group.events.sort(byLatest);
  brief.activityGroups = [...activityByProject.values()].sort((a, b) => byLatest(a.events[0], b.events[0]));
  brief.unreadNotifications = [...notifications].sort((a, b) => byLatest({ at: a.createdAt }, { at: b.createdAt }));
  return brief;
}
