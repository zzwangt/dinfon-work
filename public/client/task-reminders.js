import { isAdminRole, normalizeRole } from './roles.js';
/**
 * Persistent work reminders are derived from the current business state, never
 * from unread notifications. Reading a message cannot finish a task.
 */
export function taskReminderSummary(state, actorId) {
  const actor = state?.users?.find(user => user.id === actorId);
  const validActor = actorId && ['superadmin', 'admin', 'member'].includes(normalizeRole(actor?.role));
  const visibleProjects = validActor ? (state.projects || []).filter(project =>
    isAdminRole(actor.role) || project.ownerId === actorId || project.memberIds?.includes(actorId)) : [];
  const projectIds = new Set(visibleProjects.map(project => project.id));
  const pending = (state?.tasks || []).filter(task => projectIds.has(task.projectId) && task.status !== 'done');
  const owned = pending.filter(task => task.ownerId === actorId);
  const review = pending.filter(task => task.status === 'review' &&
    (isAdminRole(actor.role) || task.reviewerId === actorId) &&
    (task.ownerId !== actorId || task.reviewerId === actorId));
  const ownedTaskIds = owned.map(task => task.id);
  const reviewTaskIds = review.map(task => task.id);
  const taskIds = [...new Set([...ownedTaskIds, ...reviewTaskIds])];
  const projectCounts = Object.fromEntries(visibleProjects.map(project => [project.id, 0]));
  for (const task of pending) projectCounts[task.projectId] += 1;
  return {
    count: taskIds.length,
    ownedCount: ownedTaskIds.length,
    reviewCount: reviewTaskIds.length,
    pendingCount: pending.length,
    ownedTaskIds,
    reviewTaskIds,
    taskIds,
    pendingTaskIds: pending.map(task => task.id),
    projectCounts,
  };
}

/** Pending applications remain reminders until approved or rejected. */
export function approvalReminderSummary(state, actorId) {
  const actor = state?.users?.find(user => user.id === actorId);
  const validActor = actorId && ['superadmin', 'admin', 'member'].includes(normalizeRole(actor?.role));
  const visibleProjects = validActor ? (state.projects || []).filter(project =>
    isAdminRole(actor.role) || project.ownerId === actorId || project.memberIds?.includes(actorId)) : [];
  const projectIds = new Set(visibleProjects.map(project => project.id));
  // Match the approval page and the shared access policy: employees can see
  // applications in their current projects, including their own submissions.
  const pendingIds = items => (items || []).filter(item =>
    projectIds.has(item.projectId) && item.status === 'pending').map(item => item.id);
  const nodeIds = pendingIds(state?.milestoneRequests);
  const extensionIds = pendingIds(state?.extensions);
  return {
    count: nodeIds.length + extensionIds.length,
    nodeCount: nodeIds.length,
    extensionCount: extensionIds.length,
    nodeIds,
    extensionIds,
  };
}
