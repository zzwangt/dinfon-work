/**
 * Shared server/client authorization policy for business data.
 * The server must derive actorId from its authenticated session, never from a
 * request-body identity. Authentication records must live outside business state.
 */

const COLLECTIONS = ['users', 'projects', 'milestones', 'tasks', 'extensions', 'logs'];
const USER_FIELDS = ['id', 'name', 'role', 'title', 'department', 'color'];
const ROLES = new Set(['admin', 'manager', 'member']);
const EMPLOYEE_ROUTES = new Set(['overview', 'projects', 'tasks', 'weekly', 'approvals', 'my-account']);

function profile(user) {
  const result = {};
  for (const field of USER_FIELDS) {
    if (Object.hasOwn(user, field)) result[field] = user[field];
  }
  return result;
}

/**
 * Return a detached, minimal business-state snapshot suitable for an API reply.
 * An included user's profile never grants access to that user's other projects.
 * Unknown top-level fields (accounts, sessions, login metadata, etc.) are omitted.
 */
export function sanitizeStateForActor(state, actorId) {
  if (!state || state.version !== 1 || !COLLECTIONS.every((key) => Array.isArray(state[key]))) {
    throw new Error('业务数据结构不兼容，无法确定访问权限');
  }
  const allMilestoneRequests = state.milestoneRequests === undefined ? [] : state.milestoneRequests;
  if (!Array.isArray(allMilestoneRequests)) throw new Error('节点申请数据结构不兼容，无法确定访问权限');
  if (typeof actorId !== 'string' || !actorId) throw new Error('请先登录有效账号');
  const actor = state.users.find((user) => user.id === actorId);
  if (!actor || !ROLES.has(actor.role)) throw new Error('账号不存在或没有有效访问角色');

  if (actor.role === 'admin') {
    return structuredClone({
      version: state.version,
      users: state.users.map(profile),
      projects: state.projects,
      milestones: state.milestones,
      tasks: state.tasks,
      extensions: state.extensions,
      milestoneRequests: allMilestoneRequests,
      logs: state.logs,
    });
  }

  const projects = state.projects.filter((project) =>
    project.ownerId === actorId || (Array.isArray(project.memberIds) && project.memberIds.includes(actorId)));
  const projectIds = new Set(projects.map((project) => project.id));
  const tasks = state.tasks.filter((task) => projectIds.has(task.projectId));
  const milestones = state.milestones.filter((milestone) => projectIds.has(milestone.projectId));
  const extensions = state.extensions.filter((extension) => projectIds.has(extension.projectId));
  const milestoneRequests = allMilestoneRequests.filter((request) => projectIds.has(request.projectId));
  const logs = state.logs.filter((log) => projectIds.has(log.projectId));

  // Keep the actor even when they have no projects so their account page and
  // navigation can render. Global logs and other people's projects stay absent.
  const userIds = new Set([actorId]);
  for (const project of projects) {
    userIds.add(project.ownerId);
    for (const id of project.memberIds || []) userIds.add(id);
  }
  for (const task of tasks) {
    userIds.add(task.ownerId);
    userIds.add(task.reviewerId);
  }
  for (const extension of extensions) {
    userIds.add(extension.applicantId);
    userIds.add(extension.reviewerId);
  }
  for (const request of milestoneRequests) {
    userIds.add(request.applicantId);
    userIds.add(request.reviewerId);
  }
  for (const log of logs) userIds.add(log.actorId);

  return structuredClone({
    version: state.version,
    users: state.users.filter((user) => userIds.has(user.id)).map(profile),
    projects, milestones, tasks, extensions, milestoneRequests, logs,
  });
}

/**
 * Route authorization only; individual write operations still require server-side
 * domain authorization. A project id in the URL never grants project access.
 */
export function canAccessRoute(actor, route) {
  if (!actor || !ROLES.has(actor.role) || typeof route !== 'string') return false;
  const routeName = route.trim().replace(/^#?\/?/, '').split(/[/?#]/, 1)[0];
  if (!routeName) return false;
  return actor.role === 'admin' || EMPLOYEE_ROUTES.has(routeName);
}
