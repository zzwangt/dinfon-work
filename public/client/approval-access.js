import { isSuperAdminRole } from './roles.js';

const idOf = actor => typeof actor === 'string' ? actor : actor?.id;

export function canApproveProject(project, actor) {
  return Boolean(project && idOf(actor) && (project.ownerId === idOf(actor) || isSuperAdminRole(actor?.role)));
}

export const canManageProjectPlan = canApproveProject;

export function canApproveRequest(project, request, actor) {
  return Boolean(request && request.projectId === project?.id && request.status === 'pending'
    && canApproveProject(project, actor) && (request.applicantId !== idOf(actor) || isSuperAdminRole(actor?.role)));
}

export function canReviewTask(task, actor) {
  if (!task || !actor?.id) return false;
  return isSuperAdminRole(actor.role) || (task.reviewerId === actor.id && task.ownerId !== actor.id);
}

/** Each approval represents one actual signer in one required position. */
export function milestoneSignSlots(project, milestone, actor, tasks = []) {
  if (!actor?.id || !project || !milestone || project.id !== milestone.projectId || milestone.status === 'done') return [];
  const children = tasks.filter(task => task.projectId === project.id && task.milestoneId === milestone.id);
  if (!children.length || children.some(task => task.status !== 'done')) return [];
  const signatures = milestone.signatures || [];
  if (signatures.some(signature => signature.actorId === actor.id)) return [];
  const required = milestone.coReviewerId ? ['owner', 'coReviewer'] : ['owner'];
  const open = required.filter(position => !signatures.some(signature => signature.as === position));
  if (actor.id === project.ownerId) return open.filter(position => position === 'owner');
  if (isSuperAdminRole(actor.role)) return open;
  if (actor.role === 'admin' && actor.id === milestone.coReviewerId) return open.filter(position => position === 'coReviewer');
  return [];
}

export function canSignMilestone(project, milestone, actor, tasks = []) {
  return milestoneSignSlots(project, milestone, actor, tasks).length > 0;
}
