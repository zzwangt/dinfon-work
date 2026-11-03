/** Project approval roles are explicit; administrator access alone is not enough. */
export function canApproveProject(project, actorId) {
  return Boolean(project && actorId && (project.ownerId === actorId || project.reviewerId === actorId));
}

export function canApproveRequest(project, request, actorId) {
  return Boolean(request && request.projectId === project?.id && request.status === 'pending'
    && request.applicantId !== actorId && canApproveProject(project, actorId));
}
