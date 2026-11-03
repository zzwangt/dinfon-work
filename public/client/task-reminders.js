/**
 * Persistent work reminders are derived from the current business state, never
 * from unread notifications. Reading a message cannot finish a task.
 */
export function taskReminderSummary(state, actorId) {
  const actor = state?.users?.find(user => user.id === actorId);
  const validActor = actorId && ['admin', 'manager', 'member'].includes(actor?.role);
  const visibleProjects = validActor ? (state.projects || []).filter(project =>
    actor.role === 'admin' || project.ownerId === actorId || project.memberIds?.includes(actorId)) : [];
  const projectIds = new Set(visibleProjects.map(project => project.id));
  const pending = (state?.tasks || []).filter(task => projectIds.has(task.projectId) && task.status !== 'done');
  const owned = pending.filter(task => task.ownerId === actorId);
  const review = pending.filter(task => task.status === 'review' && task.ownerId !== actorId &&
    (actor.role === 'admin' || task.reviewerId === actorId));
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
