import { isAdminRole, isSuperAdminRole } from './roles.js';

const idOf = actor => typeof actor === 'string' ? actor : actor?.id;

export function canApproveProject(project, actor, kind = 'plan') {
  if (!project || !idOf(actor)) return false;
  if (project.ownerId === idOf(actor)) return true;
  return kind === 'extension' ? isSuperAdminRole(actor?.role) : isAdminRole(actor?.role);
}

export const canManageProjectPlan = canApproveProject;

export function canApproveRequest(project, request, actor) {
  if (!request || request.projectId !== project?.id || request.status !== 'pending') return false;
  const kind = Object.hasOwn(request, 'newDueDate') ? 'extension' : 'plan';
  if (!canApproveProject(project, actor, kind)) return false;
  if (request.applicantId !== idOf(actor)) return true;
  return kind === 'extension' ? isSuperAdminRole(actor?.role) : isAdminRole(actor?.role);
}

export function canViewProjectPlan(plan, actor) {
  return Boolean(actor?.id && (isAdminRole(actor.role) || plan.applicantId === actor.id || plan.project.ownerId === actor.id));
}

// Single-person records use the same roster without a storage migration.
const roster = (first, rest = []) => [...new Set([first, ...rest].filter(Boolean))];
export const taskOwners = task => roster(task.ownerId, task.memberIds);
export const taskReviewers = task => roster(task.reviewerId, task.extraReviewerIds);
export const stageReviewers = stage => roster(stage.coReviewerId, stage.extraReviewerIds);
export function stageSeats(project, stage) {
  return [['owner',project.ownerId], ...stageReviewers(stage).map((id,index) => [index ? 'coReviewer:' + id : 'coReviewer', id])];
}

export function canSubmitTask(task, actor) {
  if (!task || !actor) return false;
  const owners = taskOwners(task);
  if (owners.length === 1) return owners.includes(actor.id) || ['admin','superadmin'].includes(actor.role);
  return owners.includes(actor.id) && !(task.deliveries || []).some(item => item.ownerId === actor.id);
}

export function personalSubmissionTime(task, ownerId) {
  return taskOwners(task).length > 1
    ? task.deliveries?.find(item => item.ownerId === ownerId)?.at
    : task.submittedAt;
}

export function taskSignSeats(task, actor) {
  if (!task || !actor?.id) return [];
  const signatures = task.reviewSignatures || [];
  if (signatures.some(item => item.actorId === actor.id)) return [];
  const open = taskReviewers(task).filter(id => !signatures.some(item => item.reviewerId === id));
  if (isSuperAdminRole(actor.role)) return open.includes(actor.id) ? [actor.id] : open;
  return open.includes(actor.id) ? [actor.id] : [];
}
export const canReviewTask = (task, actor) => taskSignSeats(task, actor).length > 0;

/** Each approval represents one actual signer in one required position. */
export function milestoneSignSlots(project, milestone, actor, tasks = []) {
  if (!actor?.id || !project || !milestone || project.id !== milestone.projectId || milestone.status === 'done') return [];
  const children = tasks.filter(task => task.projectId === project.id && task.milestoneId === milestone.id);
  if (!children.length || children.some(task => task.status !== 'done')) return [];
  const signatures = milestone.signatures || [];
  if (signatures.some(signature => signature.actorId === actor.id)) return [];
  const open = stageSeats(project, milestone).filter(([slot]) => !signatures.some(signature => signature.as === slot));
  if (actor.id === project.ownerId) return open.filter(([slot]) => slot === 'owner').map(([slot]) => slot);
  if (isSuperAdminRole(actor.role)) return open.filter(([slot]) => slot !== 'owner').map(([slot]) => slot);
  return open.filter(([,id]) => id === actor.id).map(([slot]) => slot);
}

export function canSignMilestone(project, milestone, actor, tasks = []) {
  return milestoneSignSlots(project, milestone, actor, tasks).length > 0;
}
