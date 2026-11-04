import { isAdminRole, isSuperAdminRole, ROLE_LABELS } from '../public/client/roles.js';
import { createSeedState, normalizeState, transact } from '../public/client/domain.js';
import { sanitizeStateForActor } from '../public/client/access.js';
import { canApproveProject, canManageProjectPlan } from '../public/client/approval-access.js';
import { AuthError, normalizeLogin, validatePassword, validPasswordHash, hashPassword, verifyPassword, configuredOrigin, sessionCookie, sessionToken, issueSession, readSession, revokeSession, consumeAuthAttempt, clearAuthAttempts } from './auth.mjs';
import { workspacePayload, appendNotifications, unreadNotifications, markNotificationsRead } from './notifications.mjs';
import { handleFileApi, initializeFileSchema } from './files.mjs';

const WORKSPACE_ID = 'main';
const ROLES = new Set(['superadmin', 'admin', 'member']);
const COMMANDS = new Set(['createProject', 'reviewProjectPlan', 'setMilestoneCoReviewer', 'setTaskReviewer', 'createTask', 'deleteTask', 'deleteMilestone', 'deleteProject', 'updateTask', 'editTaskContent', 'submitTask', 'reviewTask', 'editMilestoneContent', 'requestMilestone', 'reviewMilestoneRequest', 'completeMilestone', 'requestExtension', 'reviewExtension']);
const MAX_BODY_BYTES = 65536;
export const MAX_PLAN_BYTES = 2 * 1024 * 1024;

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const requireValue = (value, message) => { if (!value) fail(400, 'INVALID_INPUT', message); };
const identifier = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization', 'X-Content-Type-Options': 'nosniff' } });
}

function string(value, label, max = 100, optional = false) {
  if (optional && value == null) return '';
  requireValue(typeof value === 'string' && (optional || value.trim()) && value.trim().length <= max, `请填写有效的${label}（最多 ${max} 字）`);
  return value.trim();
}

function email(value) {
  const normalized = string(value, '登录邮箱', 254).toLowerCase();
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized), '请填写有效的登录邮箱');
  return normalized;
}

function authenticate(identity) {
  // Only the internal cookie-authenticated adapter constructs localAccountId.
  // The public HTTP route never forwards identity headers or JSON into this API.
  if (identity?.localAccountId && typeof identity.localAccountId === 'string') return { localAccountId: identity.localAccountId };
  if (!identity || typeof identity.userId !== 'string' || !identity.userId.trim() || typeof identity.email !== 'string') {
    fail(401, 'AUTH_REQUIRED', '请先使用 ChatGPT 账号登录');
  }
  let normalized;
  try { normalized = email(identity.email); } catch { fail(401, 'AUTH_REQUIRED', '无法确认登录邮箱，请重新登录'); }
  return { authId: identity.userId, email: normalized, displayName: typeof identity.displayName === 'string' ? identity.displayName.trim().slice(0, 30) : '' };
}

async function body(request, limit = MAX_BODY_BYTES) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    fail(403, 'ORIGIN_REJECTED', '请求来源无效，请从平台页面重试');
  }
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, 'JSON_REQUIRED', '请求必须使用 JSON 格式');
  if (Number(request.headers.get('Content-Length') || 0) > limit) fail(413, 'BODY_TOO_LARGE', '提交内容过长');
  const raw = await request.text();
  const size = new TextEncoder().encode(raw).byteLength;
  if (size > limit) fail(413, 'BODY_TOO_LARGE', '提交内容过长');
  let value;
  try { value = JSON.parse(raw); } catch { fail(400, 'INVALID_JSON', '提交内容格式不正确'); }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), '提交内容格式不正确');
  if (size > MAX_BODY_BYTES && value.action !== 'createProject') fail(413, 'BODY_TOO_LARGE', '提交内容过长');
  return value;
}

function revisionMatches(value, expected) {
  requireValue(Number.isSafeInteger(value) && value >= 1, '请先刷新平台数据再操作');
  if (value !== expected) fail(409, 'REVISION_CONFLICT', '数据已被其他人更新，请刷新后重试；本次修改尚未保存');
}

async function readWorkspace(db) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.prepare('SELECT payload, revision FROM workspace WHERE id = ?').bind(WORKSPACE_ID).first();
    if (!row) return null;
    const value = JSON.parse(row.payload);
    if (!value || !Array.isArray(value.accounts) || !value.state || !Number.isSafeInteger(row.revision)) throw new Error('Invalid workspace');
    value.state = normalizeState(value.state);
    if (value.accountPolicyVersion !== 2) {
      // One durable upgrade only. Never elect a new administrator after policy v2
      // was installed, even if an operator has damaged the sole owner's record.
      const activeAdmins = value.accounts.filter(account => account.status === 'active' && isAdminRole(value.state.users.find(user => user.id === account.userId)?.role))
        .sort((a,b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
      const existing = activeAdmins.filter(account => value.state.users.find(user => user.id === account.userId)?.role === 'superadmin');
      requireValue(existing.length <= 1, '存在多个总管理员，请先由服务器操作员核对账号');
      const ownerAccount = existing[0] || activeAdmins.find(account => account.isSuperAdmin === true) || activeAdmins[0];
      if (!ownerAccount) fail(503, 'ROLE_MIGRATION_REQUIRED', '没有有效管理账号，无法迁移总管理员，请联系服务器操作员');
      value.state.users.find(user => user.id === ownerAccount.userId).role = 'superadmin';
      value.accountPolicyVersion = 2;
      for (const account of value.accounts) delete account.isSuperAdmin;
      log(value, ownerAccount.userId, '升级账号权限：启用总管理员，原项目负责人账号改为员工；项目分工与登录凭据保留');
      const result = await db.prepare('UPDATE workspace SET payload = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
        .bind(workspacePayload(value), WORKSPACE_ID, row.revision).run();
      if (result.meta?.changes !== 1) continue;
      return { ...value, revision: row.revision + 1 };
    }
    for (const account of value.accounts) delete account.isSuperAdmin;
    return { ...value, revision: row.revision };
  }
  fail(409, 'REVISION_CONFLICT', '账号权限更新期间数据发生变化，请刷新后重试');
}

async function saveWorkspace(db, next, previousRevision) {
  const result = await db.prepare('UPDATE workspace SET payload = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
    .bind(workspacePayload(next), WORKSPACE_ID, previousRevision).run();
  if (result.meta?.changes !== 1) fail(409, 'REVISION_CONFLICT', '数据已被其他人更新，请刷新后重试；本次修改尚未保存');
  return { ...next, revision: previousRevision + 1 };
}

async function bootstrap(db, env, identity) {
  let configured;
  try { configured = email(env.FIRST_ADMIN_EMAIL); } catch { fail(503, 'SETUP_REQUIRED', '平台尚未配置首位管理员，请联系平台负责人'); }
  if (identity.email !== configured) fail(403, 'ACCOUNT_NOT_PROVISIONED', '当前账号尚未开通，请联系管理员添加你的 ChatGPT 登录邮箱');
  const state = createSeedState();
  const owner = state.users.find((user) => user.id === 'u-admin');
  owner.role = 'superadmin';
  // Hosting may use the login email as its display-name fallback. Keep that
  // authentication detail out of business profiles shared with project members.
  owner.name = identity.displayName && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.displayName) ? identity.displayName : '管理员';
  const at = new Date().toISOString();
  const accounts = [{ id: identifier('a'), userId: owner.id, email: identity.email, authId: identity.authId, status: 'active', createdAt: at, updatedAt: at, lastLoginAt: at }];
  state.logs.unshift({ id: identifier('log'), at, actorId: owner.id, projectId: null, message: '完成管理员账号绑定，启用独立账号与共享数据' });
  await db.prepare('INSERT OR IGNORE INTO workspace (id, payload, revision) VALUES (?, ?, 1)')
    .bind(WORKSPACE_ID, JSON.stringify({ state, accounts, accountPolicyVersion: 2 })).run();
  return readWorkspace(db);
}

function lookupAccount(workspace, identity) {
  if (identity.localAccountId) {
    const account = workspace.accounts.find((entry) => entry.id === identity.localAccountId);
    if (!account || account.status !== 'active') fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
    const actor = workspace.state.users.find((user) => user.id === account.userId);
    if (!actor || !ROLES.has(actor.role)) fail(403, 'ACCOUNT_INVALID', '账号角色无效，请联系管理员');
    return { account, actor };
  }
  const byId = workspace.accounts.find((account) => account.authId === identity.authId);
  const account = byId || workspace.accounts.find((entry) => entry.email === identity.email);
  if (!account) fail(403, 'ACCOUNT_NOT_PROVISIONED', '当前账号尚未开通，请联系管理员添加你的 ChatGPT 登录邮箱');
  if (account.authId && account.authId !== identity.authId) fail(403, 'IDENTITY_MISMATCH', '此邮箱已绑定其他登录身份，请联系管理员核实');
  // The authenticated subject is stable. A changed email is not silently allowed
  // to take over a second provisioned account or change the account's binding.
  if (account.email !== identity.email) fail(403, 'IDENTITY_MISMATCH', '登录邮箱与已绑定账号不一致，请联系管理员核实');
  if (account.status !== 'active') fail(403, 'ACCOUNT_DISABLED', '账号已停用，请联系管理员');
  const actor = workspace.state.users.find((user) => user.id === account.userId);
  if (!actor || !ROLES.has(actor.role)) fail(403, 'ACCOUNT_INVALID', '账号角色无效，请联系管理员');
  return { account, actor };
}

async function context(db, env, identity, { bind = false } = {}) {
  let workspace = await readWorkspace(db);
  if (!workspace) {
    if (!bind) fail(403, 'ACCOUNT_NOT_PROVISIONED', '请先登录平台完成账号初始化');
    workspace = await bootstrap(db, env, identity);
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { account, actor } = lookupAccount(workspace, identity);
    if (!identity.localAccountId && !bind && !account.authId) fail(403, 'SESSION_REQUIRED', '请先进入平台完成首次登录绑定');
    const shouldTouch = !identity.localAccountId && bind && (!account.authId || !account.lastLoginAt || Date.now() - Date.parse(account.lastLoginAt) > 10 * 60 * 1000);
    if (!shouldTouch) return { workspace, account, actor };
    const next = structuredClone(workspace);
    const target = next.accounts.find((entry) => entry.id === account.id);
    target.authId = identity.authId;
    target.lastLoginAt = new Date().toISOString();
    target.updatedAt = target.lastLoginAt;
    try {
      workspace = await saveWorkspace(db, next, workspace.revision);
      const current = lookupAccount(workspace, identity);
      return { workspace, ...current };
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || attempt === 2) throw error;
      workspace = await readWorkspace(db);
    }
  }
}

async function activeLoginUsers(db, workspace, identity) {
  // Only IDs are read. An old business profile by itself has no login capability.
  const result = identity.localAccountId
    ? await db.prepare("SELECT COALESCE(json_group_array(account_id), '[]') AS ids FROM auth_credentials").first()
    : null;
  const credentialIds = result && new Set(JSON.parse(result.ids));
  return new Set(workspace.accounts.filter(account => account.status === 'active' &&
    (credentialIds ? credentialIds.has(account.id) : Boolean(account.email))).map(account => account.userId));
}

async function session(db, workspace, identity) {
  const { account, actor } = lookupAccount(workspace, identity);
  const state = sanitizeStateForActor(workspace.state, actor.id);
  const activeUsers = await activeLoginUsers(db, workspace, identity);
  const managesPlan = isSuperAdminRole(actor.role) || state.projects.some(project => project.ownerId === actor.id);
  const milestoneReviewerOptions = managesPlan ? workspace.state.users
    .filter(user => user.role === 'admin' && activeUsers.has(user.id))
    .map(({id, name, title}) => ({id, name, title})) : [];
  return {
    milestoneReviewerOptions,
    taskReviewerIds: state.users.filter(user => activeUsers.has(user.id)).map(user => user.id),
    actor: state.users.find((user) => user.id === actor.id),
    account: { id: account.id, email: account.email || '', login: account.login || '', role: actor.role, status: account.status },
    state,
    notifications: await unreadNotifications(db, workspace, account, actor),
    revision: workspace.revision,
    capabilities: { manageAccounts: isAdminRole(actor.role), manageAllData: isAdminRole(actor.role), createProjects: isAdminRole(actor.role), manageMaintenance: isSuperAdminRole(actor.role) },
  };
}

function accountList(workspace) {
  return workspace.accounts.map((account) => {
    const user = workspace.state.users.find((entry) => entry.id === account.userId);
    return {
      id: account.id, userId: account.userId, email: account.email || '', login: account.login || '', name: user?.name || '', role: user?.role,
      title: user?.title || '', department: user?.department || '',
      status: account.status, linked: Boolean(account.login || account.authId), createdAt: account.createdAt,
      updatedAt: account.updatedAt, lastLoginAt: account.lastLoginAt || null,
    };
  });
}

function adminOnly(actor) {
  if (!isAdminRole(actor.role)) fail(403, 'ADMIN_REQUIRED', '仅管理账号可以执行此操作');
}

function superadminOnly(actor) {
  if (!isSuperAdminRole(actor.role)) fail(403, 'SUPERADMIN_REQUIRED', '仅总管理员可以管理备份与升级');
}

function manageAccountTarget(actor, user) {
  adminOnly(actor);
  if (!isSuperAdminRole(actor.role) && user?.role !== 'member') fail(403, 'ACCOUNT_MANAGER_REQUIRED', '管理员只能管理员工账号；管理账号由总管理员处理');
}

function log(workspace, actorId, message, projectId = null) {
  workspace.state.logs.unshift({ id: identifier('log'), at: new Date().toISOString(), actorId, projectId, message });
}

function accessibleCommand(workspace, actor, action, payload) {
  if (action === 'createProject') {
    adminOnly(actor);
    return;
  }
  const scope = sanitizeStateForActor(workspace.state, actor.id);
  if (action === 'reviewProjectPlan') {
    const plan = scope.projectPlans.find(item => item.id === payload.id);
    if (!plan) fail(404, 'NOT_FOUND', '项目计划不存在或无权查看');
    if (!canApproveProject(plan.project, actor)) fail(403, 'PROJECT_APPROVER_REQUIRED', '仅拟任项目负责人或总管理员可以审批');
    return scope;
  }
  let projectId = payload.projectId;
  if (action === 'deleteProject') projectId = payload.id;
  if (['updateTask', 'deleteTask', 'editTaskContent', 'submitTask', 'reviewTask', 'setTaskReviewer'].includes(action)) projectId = workspace.state.tasks.find((task) => task.id === payload.id)?.projectId;
  if (['completeMilestone', 'editMilestoneContent', 'deleteMilestone', 'setMilestoneCoReviewer'].includes(action)) projectId = workspace.state.milestones.find((milestone) => milestone.id === payload.id)?.projectId;
  const approval = action === 'reviewExtension' || action === 'reviewMilestoneRequest';
  if (approval) {
    const requests = action === 'reviewExtension' ? workspace.state.extensions : workspace.state.milestoneRequests || [];
    projectId = requests.find((request) => request.id === payload.id)?.projectId;
  }
  const project = scope.projects.find(item => item.id === projectId);
  if (!project) fail(404, 'NOT_FOUND', '项目或任务不存在，或你没有访问权限');
  if (approval && !canApproveProject(project, actor)) fail(403, 'PROJECT_APPROVER_REQUIRED', '仅项目负责人或总管理员可以审批申请');
  const planChange = ['editMilestoneContent', 'editTaskContent', 'setTaskReviewer', 'setMilestoneCoReviewer'].includes(action)
    || (action === 'updateTask' && Object.hasOwn(payload, 'description'));
  if (planChange && !canManageProjectPlan(project, actor)) fail(403, 'PROJECT_PLAN_REQUIRED', '仅项目负责人或总管理员可以修改节点计划');
  if (['deleteTask', 'deleteMilestone'].includes(action)) adminOnly(actor);
  if (action === 'deleteProject' && !isSuperAdminRole(actor.role)) fail(403, 'SUPERADMIN_REQUIRED', '仅总管理员可以删除整个项目');
  return scope;
}

function assignAccountProjects(workspace, user, projectIds, actor) {
  requireValue(Array.isArray(projectIds) && projectIds.every((id) => typeof id === 'string') && new Set(projectIds).size === projectIds.length, '项目权限格式不正确，请重新选择项目');
  const selected = new Set(projectIds);
  requireValue(projectIds.every((id) => workspace.state.projects.some((project) => project.id === id)), '选择的项目不存在，请刷新后重试');
  requireValue(workspace.state.projects.every((project) => project.ownerId !== user.id || selected.has(project.id)), '项目负责人不能移除自己负责的项目，请先调整项目负责人');
  for (const project of workspace.state.projects) {
    const member = project.memberIds.includes(user.id);
    if (!selected.has(project.id) && project.reviewerId === user.id) {
      project.reviewerId = null;
      log(workspace, actor.id, `移除项目验收人 ${user.name}`, project.id);
    }
    if (member === selected.has(project.id)) continue;
    project.memberIds = selected.has(project.id) ? [...project.memberIds, user.id] : project.memberIds.filter((id) => id !== user.id);
    log(workspace, actor.id, `将成员 ${user.name} ${selected.has(project.id) ? '加入' : '移出'}项目“${project.name}”；既有任务负责人保持不变`, project.id);
  }
}

function provisionAccount(workspace, data, actor, local = false) {
  const normalized = local && !data.email ? '' : email(data.email);
  const login = local ? normalizeLogin(data.login) : '';
  const name = string(data.name, '姓名', 30);
  requireValue(['admin', 'member'].includes(data.role), '只能开通管理员或员工账号');
  if (!isSuperAdminRole(actor.role) && data.role !== 'member') fail(403, 'ACCOUNT_MANAGER_REQUIRED', '仅总管理员可以开通管理员账号');
  requireValue(!normalized || !workspace.accounts.some((account) => account.email === normalized), '此邮箱已经开通账号');
  if (local) requireValue(!workspace.accounts.some((account) => account.login === login), '此账号已存在');
  let user;
  if (data.existingUserId) {
    user = workspace.state.users.find((entry) => entry.id === data.existingUserId);
    requireValue(user, '要关联的项目成员不存在');
    manageAccountTarget(actor, user);
    requireValue(!workspace.accounts.some((account) => account.userId === user.id), '此项目成员已关联登录账号');
    user.name = name;
    user.role = data.role;
    if (data.title != null) user.title = string(data.title, '岗位', 60, true);
    if (data.department != null) user.department = string(data.department, '部门', 60, true);
  } else {
    user = {
      id: identifier('u'), name, role: data.role,
      title: string(data.title, '岗位', 60, true) || ROLE_LABELS[data.role],
      department: string(data.department, '部门', 60, true) || '未分配部门',
      color: ['#52756e', '#526ba0', '#977951', '#8a6e9b'][workspace.state.users.length % 4],
    };
    workspace.state.users.push(user);
  }
  if (data.projectIds !== undefined) assignAccountProjects(workspace, user, data.projectIds, actor);
  const at = new Date().toISOString();
  const account = { id: identifier('a'), userId: user.id, email: normalized, authId: null, status: 'active', createdAt: at, updatedAt: at, lastLoginAt: null, ...(local ? { login } : {}) };
  workspace.accounts.push(account);
  log(workspace, actor.id, `开通${ROLE_LABELS[data.role]}账号：${name}`);
  return account;
}

function revokePendingStageSignatures(workspace, userId, actorId) {
  for (const node of workspace.state.milestones) {
    if (node.status === 'done' || node.coReviewerId !== userId || !node.signatures?.length) continue;
    const before = node.signatures;
    node.signatures = [];
    log(workspace, actorId, `阶段加验管理员已失效，清除“${node.title}”的未完成签字`, node.projectId);
    workspace.state.logs[0].changes = { signatures: { before, after: [] } };
  }
}

function changeAccount(workspace, id, data, actor, currentAccount) {
  const account = workspace.accounts.find((entry) => entry.id === id);
  if (!account) fail(404, 'NOT_FOUND', '账号不存在');
  const user = workspace.state.users.find((entry) => entry.id === account.userId);
  requireValue(user, '关联成员不存在');
  manageAccountTarget(actor, user);
  requireValue(data.role != null || data.status != null || data.active != null || data.projectIds !== undefined || data.title !== undefined || data.department !== undefined, '请选择要修改的账号资料、状态或项目权限');
  if (data.login != null || data.password != null || data.email != null || data.userId != null || data.authId != null || data.existingUserId != null) fail(400, 'IMMUTABLE_IDENTITY', '账号身份不可直接更改，请通过重置密码操作修改密码');
  const role = data.role ?? user.role;
  requireValue(ROLES.has(role), '请选择有效的账号角色');
  if (role === 'superadmin' && user.role !== 'superadmin') fail(400, 'SINGLE_SUPERADMIN', '平台仅保留一个总管理员，不能另行提升账号');
  if (!isSuperAdminRole(actor.role) && role !== 'member') fail(403, 'ACCOUNT_MANAGER_REQUIRED', '仅总管理员可以调整管理员权限');
  if (data.active != null) requireValue(typeof data.active === 'boolean', '账号状态无效');
  const status = data.status ?? (data.active == null ? account.status : data.active ? 'active' : 'disabled');
  requireValue(['active', 'disabled'].includes(status), '账号状态无效');
  if (data.status != null && data.active != null) requireValue((status === 'active') === data.active, '账号状态不一致');
  if (account.id === currentAccount.id && (status !== 'active' || role !== user.role)) fail(400, 'SELF_LOCKOUT', '不能停用或降级当前登录的管理账号');
  if (user.role === 'superadmin' && (role !== 'superadmin' || status !== 'active')) fail(400, 'SUPERADMIN_PROTECTED', '总管理员不能停用或降级');
  if (data.title !== undefined) user.title = string(data.title, '职位', 60, true);
  if (data.department !== undefined) user.department = string(data.department, '部门', 60, true);
  if (data.projectIds !== undefined) assignAccountProjects(workspace, user, data.projectIds, actor);
  if (user.role === 'admin' && account.status === 'active' && (role !== 'admin' || status !== 'active')) revokePendingStageSignatures(workspace, user.id, actor.id);
  user.role = role;
  account.status = status;
  account.updatedAt = new Date().toISOString();
  log(workspace, actor.id, `更新账号 ${user.name}：${ROLE_LABELS[role]}，${status === 'active' ? '启用' : '停用'}${data.title !== undefined ? `；职位：${user.title || '未设置'}` : ''}${data.department !== undefined ? `；部门：${user.department || '未设置'}` : ''}`);
}

function deleteAccount(workspace, id, actor, currentAccount) {
  const account = workspace.accounts.find((entry) => entry.id === id);
  if (!account) fail(404, 'NOT_FOUND', '账号不存在或已删除');
  if (account.id === currentAccount.id) fail(400, 'SELF_LOCKOUT', '不能删除当前登录账号，请使用另一位管理员账号操作');
  const user = workspace.state.users.find((entry) => entry.id === account.userId);
  manageAccountTarget(actor, user);
  if (user?.role === 'superadmin') fail(400, 'SUPERADMIN_PROTECTED', '总管理员不能删除');
  // Authentication is removed separately; business identities remain stable so
  // project ownership, deliverables, approvals and audit trails stay intact.
  if (user?.role === 'admin') revokePendingStageSignatures(workspace, user.id, actor.id);
  workspace.accounts = workspace.accounts.filter((entry) => entry.id !== id);
  log(workspace, actor.id, `删除账号：${user?.name || '成员'}；项目、任务与审批历史保留`);
}

/**
 * identity MUST come from verified hosting authentication, never HTTP JSON or
 * unverified caller-provided headers. DB and FIRST_ADMIN_EMAIL are server-only.
 */
export async function handleApi(request, env, authenticatedIdentity) {
  try {
    const identity = authenticate(authenticatedIdentity);
    if (!env?.DB) fail(503, 'DATABASE_UNAVAILABLE', '共享数据库暂不可用，请稍后重试');
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const method = request.method.toUpperCase();
    if (path === '/api/session' && method === 'GET') {
      const { workspace } = await context(env.DB, env, identity, { bind: true });
      return json(await session(env.DB, workspace, identity));
    }
    const { workspace, actor, account } = await context(env.DB, env, identity);
    if (path === '/api/accounts' && method === 'GET') {
      adminOnly(actor);
      const snapshot = await session(env.DB, workspace, identity);
      return json({ ...snapshot, accounts: accountList(workspace), users: snapshot.state.users });
    }
    if (path === '/api/notifications/read' && method === 'POST') {
      const data = await body(request);
      requireValue(Array.isArray(data.ids) && data.ids.length <= 1000 && data.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 100), '通知列表格式不正确');
      // Read receipts do not touch the business revision. A stale page can mark
      // its own visible events read without overwriting newer project changes.
      await markNotificationsRead(env.DB, workspace, account, actor, data.ids);
      const latest = await readWorkspace(env.DB);
      const current = lookupAccount(latest, identity);
      return json({ notifications: await unreadNotifications(env.DB, latest, current.account, current.actor) });
    }
    if (path === '/api/command' && method === 'POST') {
      const data = await body(request, MAX_PLAN_BYTES);
      revisionMatches(data.revision, workspace.revision);
      requireValue(COMMANDS.has(data.action), '不支持的业务操作');
      requireValue(data.payload == null || (typeof data.payload === 'object' && !Array.isArray(data.payload)), '操作内容格式不正确');
      const payload = data.payload || {};
      const scope = accessibleCommand(workspace, actor, data.action, payload);
      if (data.action === 'createTask' || data.action === 'setTaskReviewer' || (data.action === 'setMilestoneCoReviewer' && payload.reviewerId)) {
        const reviewerId = payload.reviewerId || (data.action === 'createTask' && workspace.state.projects.find(project => project.id === payload.projectId)?.ownerId);
        const activeUsers = await activeLoginUsers(env.DB, workspace, identity);
        requireValue((data.action === 'setMilestoneCoReviewer' || scope.users.some(user => user.id === reviewerId)) && activeUsers.has(reviewerId), '请选择可见且已启用登录的验收人账号');
        if (data.action === 'setMilestoneCoReviewer') {
          requireValue(workspace.state.users.find(user => user.id === reviewerId)?.role === 'admin', '阶段加验人必须是启用的普通管理员');
        }
      }
      if (data.action === 'completeMilestone') {
        const node = workspace.state.milestones.find(item => item.id === payload.id);
        if (node?.coReviewerId) {
          const available = await activeLoginUsers(env.DB, workspace, identity);
          requireValue(available.has(node.coReviewerId) && workspace.state.users.find(user => user.id === node.coReviewerId)?.role === 'admin', '指定的阶段加验管理员已失效，请项目负责人或总管理员重新设置');
        }
      }
      if (data.action === 'reviewMilestoneRequest' && payload.approve === true) {
        const application = workspace.state.milestoneRequests.find((entry) => entry.id === payload.id);
        if (application && !workspace.accounts.some((entry) => entry.userId === application.applicantId && entry.status === 'active')) {
          fail(400, 'APPLICANT_DISABLED', '申请人账号已停用或不存在，请驳回此申请后由有效成员重新提交');
        }
      }
      let state;
      try { state = transact(workspace.state, data.action, payload, actor.id); }
      catch (error) { fail(400, 'COMMAND_REJECTED', error instanceof Error ? error.message : '操作未通过校验'); }
      if (data.action === 'createProject' || (data.action === 'reviewProjectPlan' && payload.approve)) {
        const plan = data.action === 'createProject' ? state.projectPlans[0] : state.projectPlans.find(item => item.id === payload.id);
        const active = await activeLoginUsers(env.DB, workspace, identity);
        const people = [plan.applicantId, ...plan.project.memberIds, ...plan.tasks.map(task => task.reviewerId), ...plan.milestones.map(node => node.coReviewerId).filter(Boolean)];
        requireValue(people.every(id => active.has(id)), '计划中包含未启用登录的人员，请调整人员后重新提交');
      }
      const next = appendNotifications(workspace, { ...workspace, state }, actor.id, data.action, payload);
      let saved;
      if (['deleteTask', 'deleteMilestone', 'deleteProject'].includes(data.action)) {
        await initializeFileSchema(env.DB);
        const removedTasks = workspace.state.tasks.filter(task => !next.state.tasks.some(item => item.id === task.id)).map(task => task.id);
        const removedMilestones = workspace.state.milestones.filter(node => !next.state.milestones.some(item => item.id === node.id)).map(node => node.id);
        const removedProjects = workspace.state.projects.filter(project => !next.state.projects.some(item => item.id === project.id)).map(project => project.id);
        const results = await env.DB.batch([
          workspaceUpdate(env.DB, next, workspace.revision),
          env.DB.prepare("DELETE FROM project_files WHERE changes() = 1 AND (project_id IN (SELECT value FROM json_each(?)) OR (entity_type = 'task' AND entity_id IN (SELECT value FROM json_each(?))) OR (entity_type = 'milestone' AND entity_id IN (SELECT value FROM json_each(?))))").bind(JSON.stringify(removedProjects), JSON.stringify(removedTasks), JSON.stringify(removedMilestones)),
        ]);
        assertChanged(results[0]);
        saved = { ...next, revision: workspace.revision + 1 };
      } else saved = await saveWorkspace(env.DB, next, workspace.revision);
      return json(await session(env.DB, saved, identity));
    }
    const accountId = path.match(/^\/api\/accounts\/([^/]+)$/)?.[1];
    if (accountId && method === 'DELETE') {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      const next = structuredClone(workspace);
      deleteAccount(next, accountId, actor, account);
      const saved = await saveWorkspace(env.DB, next, workspace.revision);
      return json({ ...await session(env.DB, saved, identity), accounts: accountList(saved) });
    }
    if ((path === '/api/accounts' && method === 'POST') || (accountId && method === 'PATCH')) {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      const next = structuredClone(workspace);
      if (accountId) changeAccount(next, accountId, data, actor, account);
      else provisionAccount(next, data, actor, false);
      appendNotifications(workspace, next, actor.id, 'accountMemberships');
      const saved = await saveWorkspace(env.DB, next, workspace.revision);
      return json({ ...await session(env.DB, saved, identity), accounts: accountList(saved) }, accountId ? 200 : 201);
    }
    fail(404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
    // Do not expose database contents, SQL, authentication data, or stack traces.
    console.error('Management API request failed');
    return json({ error: '服务暂时无法处理请求，请稍后重试', code: 'INTERNAL_ERROR' }, 500);
  }
}

function workspaceUpdate(db, workspace, previousRevision) {
  return db.prepare('UPDATE workspace SET payload = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
    .bind(workspacePayload(workspace), WORKSPACE_ID, previousRevision);
}

function assertChanged(result) {
  if (result?.meta?.changes !== 1) fail(409, 'REVISION_CONFLICT', '数据已被其他人更新，请刷新后重试；本次修改尚未保存');
}

/** Called by the local setup/runtime, never exposed as an HTTP endpoint. */
export async function initializeLocalWorkspace(env) {
  const existing = await readWorkspace(env.DB);
  if (existing) {
    const credential = await env.DB.prepare('SELECT account_id FROM auth_credentials LIMIT 1').first();
    return { initialized: false, requiresMigration: !credential };
  }
  const login = normalizeLogin(env.INITIAL_ADMIN_LOGIN);
  if (!validPasswordHash(env.INITIAL_ADMIN_PASSWORD_HASH)) fail(503, 'SETUP_REQUIRED', '请先运行本机初始化命令创建管理账号');
  const state = createSeedState();
  const owner = state.users.find((user) => user.id === 'u-admin');
  owner.role = 'superadmin';
  owner.name = typeof env.INITIAL_ADMIN_NAME === 'string' && env.INITIAL_ADMIN_NAME.trim() ? env.INITIAL_ADMIN_NAME.trim().slice(0, 30) : '管理员';
  if (env.SEED_DEMO_DATA !== 'true' && env.SEED_DEMO_DATA !== true) {
    state.users = [owner];
    for (const key of ['projects', 'milestones', 'tasks', 'extensions', 'milestoneRequests', 'logs']) state[key] = [];
  }
  const now = new Date().toISOString();
  const account = { id: identifier('a'), userId: owner.id, login, email: '', authId: null, status: 'active', createdAt: now, updatedAt: now, lastLoginAt: null };
  state.logs.unshift({ id: identifier('log'), at: now, actorId: owner.id, projectId: null, message: '完成平台初始化，启用独立账号登录' });
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO workspace (id, payload, revision) VALUES (?, ?, 1)').bind(WORKSPACE_ID, JSON.stringify({ state, accounts: [account], accountPolicyVersion: 2 })),
    env.DB.prepare('INSERT INTO auth_credentials (account_id, login, password_hash, must_change, version, updated_at) SELECT ?, ?, ?, 0, 1, ? WHERE changes() = 1')
      .bind(account.id, login, env.INITIAL_ADMIN_PASSWORD_HASH, now),
  ]);
  return { initialized: true, requiresMigration: false };
}

/** Explicit offline migration: select an existing administrator; never auto-bind
 * a new password to an existing identity based on email or env configuration. */
export async function provisionInitialCredential(env, { accountId }) {
  const workspace = await readWorkspace(env.DB);
  if (!workspace) fail(400, 'WORKSPACE_REQUIRED', '现有平台数据不存在，请先初始化');
  if (await env.DB.prepare('SELECT account_id FROM auth_credentials LIMIT 1').first()) fail(409, 'ALREADY_INITIALIZED', '平台已有独立账号，不能重新绑定首位管理员');
  const account = workspace.accounts.find((entry) => entry.id === accountId && entry.status === 'active');
  const actor = workspace.state.users.find((entry) => entry.id === account?.userId);
  if (!account || !isSuperAdminRole(actor?.role)) fail(400, 'ADMIN_REQUIRED', '请选择现有的有效管理账号进行迁移');
  if (!validPasswordHash(env.INITIAL_ADMIN_PASSWORD_HASH)) fail(400, 'INVALID_PASSWORD_HASH', '管理员密码摘要无效');
  account.login = normalizeLogin(env.INITIAL_ADMIN_LOGIN);
  account.updatedAt = new Date().toISOString();
  log(workspace, actor.id, '通过本机管理命令迁移独立登录账号，保留项目与成员记录');
  const results = await env.DB.batch([
    workspaceUpdate(env.DB, workspace, workspace.revision),
    env.DB.prepare('INSERT INTO auth_credentials (account_id, login, password_hash, must_change, version, updated_at) SELECT ?, ?, ?, 0, 1, ? WHERE changes() = 1')
      .bind(account.id, account.login, env.INITIAL_ADMIN_PASSWORD_HASH, account.updatedAt),
  ]);
  assertChanged(results[0]);
  return { migrated: true, accountId: account.id };
}

/** Local operator recovery only. Possession of the server/database is required;
 * there is no HTTP recovery route and no default or emailed reset password. */
export async function recoverLocalAdmin(env, { login, password }) {
  const normalized = normalizeLogin(login);
  const workspace = await readWorkspace(env.DB);
  const credential = await env.DB.prepare('SELECT * FROM auth_credentials WHERE login = ?').bind(normalized).first();
  const account = workspace?.accounts.find((entry) => entry.id === credential?.account_id && entry.status === 'active');
  const actor = workspace?.state.users.find((entry) => entry.id === account?.userId);
  if (!account || !isSuperAdminRole(actor?.role)) fail(400, 'ADMIN_REQUIRED', '请填写现有的有效管理账号');
  const passwordHash = await hashPassword(password);
  account.updatedAt = new Date().toISOString();
  log(workspace, actor.id, '通过本机管理命令恢复管理账号密码，已退出全部设备；下次登录须修改密码');
  const results = await env.DB.batch([
    workspaceUpdate(env.DB, workspace, workspace.revision),
    env.DB.prepare('UPDATE auth_credentials SET password_hash = ?, must_change = 1, version = version + 1, updated_at = ? WHERE account_id = ? AND changes() = 1')
      .bind(passwordHash, account.updatedAt, account.id),
    env.DB.prepare('DELETE FROM auth_sessions WHERE account_id = ? AND changes() = 1').bind(account.id),
  ]);
  assertChanged(results[0]);
  return { recovered: true, accountId: account.id };
}

async function localSession(db, workspace, credential) {
  const identity = { localAccountId: credential.account_id };
  const { account, actor } = lookupAccount(workspace, identity);
  const mustChangePassword = Boolean(credential.must_change);
  const accountView = { id: account.id, login: credential.login, email: account.email || '', role: actor.role, status: account.status, mustChangePassword };
  if (mustChangePassword) {
    // A temporary password permits only changing that password or signing out.
    // No projects, employee directory, tasks, or business history are disclosed.
    return { actor: { id: actor.id, name: actor.name, role: actor.role }, account: accountView, mustChangePassword, capabilities: {}, revision: workspace.revision };
  }
  const snapshot = await session(db, workspace, identity);
  return { ...snapshot, capabilities: { ...snapshot.capabilities, files: true }, account: accountView, mustChangePassword: false };
}

async function localAccountList(db, workspace) {
  const list = accountList(workspace);
  for (const account of list) {
    const credential = await db.prepare('SELECT login, must_change FROM auth_credentials WHERE account_id = ?').bind(account.id).first();
    account.login = credential?.login || '';
    account.linked = Boolean(credential);
    account.mustChangePassword = Boolean(credential?.must_change);
  }
  return list;
}

async function touchLocalLogin(db, accountId) {
  // Separate CAS retries prevent simultaneous sign-ins overwriting task edits.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const workspace = await readWorkspace(db);
    const account = workspace?.accounts.find((entry) => entry.id === accountId);
    if (!account || account.status !== 'active') fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
    account.lastLoginAt = new Date().toISOString();
    account.updatedAt = account.lastLoginAt;
    try { return await saveWorkspace(db, workspace, workspace.revision); }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 409 || attempt === 2) throw error; }
  }
}

function httpError(error) {
  if (error instanceof ApiError || error instanceof AuthError) {
    const response = json({ error: error.message, code: error.code }, error.status);
    if (error.status === 429) response.headers.set('Retry-After', error.code === 'AUTH_BUSY' ? '5' : '900');
    return response;
  }
  console.error('Management authentication request failed');
  return json({ error: '服务暂时无法处理请求，请稍后重试', code: 'INTERNAL_ERROR' }, 500);
}

/** Public adapter. Identity comes exclusively from a verified opaque session.
 * It deliberately ignores ChatGPT headers, authorization tokens and JSON roles. */
export async function handleHttpApi(request, env) {
  try {
    if (!env?.DB) fail(503, 'DATABASE_UNAVAILABLE', '共享数据库暂不可用，请稍后重试');
    const origin = configuredOrigin(env);
    if (new URL(request.url).origin !== origin) fail(403, 'ORIGIN_REJECTED', '请求来源无效，请从平台页面重试');
    const path = new URL(request.url).pathname.replace(/\/$/, '');
    const method = request.method.toUpperCase();
    const db = env.DB;
    if (path === '/api/auth/login' && method === 'POST') {
      const data = await body(request);
      await consumeAuthAttempt(db, `login-ip:${env.CLIENT_IP || 'unavailable'}`, 300);
      let login = '';
      try { login = normalizeLogin(data.login); } catch { /* Same response as a missing account. */ }
      await consumeAuthAttempt(db, `login:${login || 'invalid'}`);
      const credential = login ? await db.prepare('SELECT * FROM auth_credentials WHERE login = ?').bind(login).first() : null;
      const correct = await verifyPassword(data.password, credential?.password_hash);
      const workspace = await readWorkspace(db);
      const account = workspace?.accounts.find((entry) => entry.id === credential?.account_id);
      if (!correct || !credential || !account || account.status !== 'active') fail(401, 'INVALID_CREDENTIALS', '账号或密码不正确，或账号尚未开通');
      const saved = await touchLocalLogin(db, account.id);
      const current = await db.prepare('SELECT * FROM auth_credentials WHERE account_id = ?').bind(account.id).first();
      if (!current || current.version !== credential.version || current.must_change !== credential.must_change) fail(401, 'AUTH_REQUIRED', '账号信息已更新，请使用最新密码重新登录');
      await clearAuthAttempts(db, `login:${login}`);
      const cookie = await issueSession(db, env, current, sessionToken(request, env));
      const response = json(await localSession(db, saved, current));
      response.headers.set('Set-Cookie', cookie);
      return response;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      await body(request);
      await revokeSession(db, request, env);
      const response = json({ ok: true });
      response.headers.set('Set-Cookie', sessionCookie(env, '', true));
      return response;
    }
    const credential = await readSession(db, request, env);
    if (!credential) fail(401, 'AUTH_REQUIRED', '请使用管理员为你开通的账号登录');
    const workspace = await readWorkspace(db);
    if (!workspace) fail(503, 'SETUP_REQUIRED', '平台尚未初始化，请联系管理员');
    const identity = { localAccountId: credential.account_id };
    const { account, actor } = lookupAccount(workspace, identity);
    if (path === '/api/session' && method === 'GET') return json(await localSession(db, workspace, credential));
    if (path === '/api/auth/password' && method === 'POST') {
      const data = await body(request);
      validatePassword(data.newPassword);
      await consumeAuthAttempt(db, `password:${account.id}`);
      if (!await verifyPassword(data.currentPassword, credential.password_hash)) fail(400, 'INVALID_CURRENT_PASSWORD', '当前密码不正确');
      if (data.currentPassword === data.newPassword) fail(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同');
      const passwordHash = await hashPassword(data.newPassword);
      const now = new Date().toISOString();
      // A version comparison prevents a stale request overwriting an admin reset.
      const changed = await db.batch([
        db.prepare('UPDATE auth_credentials SET password_hash = ?, must_change = 0, version = version + 1, updated_at = ? WHERE account_id = ? AND version = ?')
          .bind(passwordHash, now, account.id, credential.version),
        db.prepare('DELETE FROM auth_sessions WHERE account_id = ? AND changes() = 1').bind(account.id),
      ]);
      assertChanged(changed[0]);
      // Keep the version we actually changed. A concurrent admin reset must not
      // grant this request a session for a newer password it never verified.
      const refreshed = { ...credential, version: credential.version + 1, must_change: 0 };
      const latestWorkspace = await readWorkspace(db);
      await clearAuthAttempts(db, `password:${account.id}`);
      const cookie = await issueSession(db, env, refreshed);
      const response = json(await localSession(db, latestWorkspace, refreshed));
      response.headers.set('Set-Cookie', cookie);
      return response;
    }
    if (credential.must_change) fail(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码，再进入工作平台');
    if (path === '/api/maintenance' || path.startsWith('/api/maintenance/')) {
      superadminOnly(actor);
      if (!env.MAINTENANCE) fail(503, 'MAINTENANCE_UNAVAILABLE', '当前服务尚未启用备份与升级，请使用新版启动入口');
      return await env.MAINTENANCE.handle(request, { actor, account, authorize: async () => {
        const currentCredential = await readSession(db, request, env);
        if (!currentCredential) fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
        if (currentCredential.must_change) fail(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码，再进入工作平台');
        const currentWorkspace = await readWorkspace(db);
        if (!currentWorkspace) fail(503, 'SETUP_REQUIRED', '平台尚未初始化，请联系管理员');
        const current = lookupAccount(currentWorkspace, identity);
        superadminOnly(current.actor);
        return current;
      } });
    }
    if (path === '/api/files' || path.startsWith('/api/files/')) {
      return await handleFileApi(request, { db, authorize: async () => {
        const currentCredential = await readSession(db, request, env);
        if (!currentCredential) fail(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
        if (currentCredential.must_change) fail(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码，再进入工作平台');
        const currentWorkspace = await readWorkspace(db);
        if (!currentWorkspace) fail(503, 'SETUP_REQUIRED', '平台尚未初始化，请联系管理员');
        return { workspace: currentWorkspace, credential: currentCredential, ...lookupAccount(currentWorkspace, identity) };
      } });
    }
    if (path === '/api/accounts' && method === 'GET') {
      adminOnly(actor);
      const snapshot = await localSession(db, workspace, credential);
      return json({ ...snapshot, accounts: await localAccountList(db, workspace), users: snapshot.state.users });
    }
    if (path === '/api/accounts' && method === 'POST') {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      const next = structuredClone(workspace);
      const added = provisionAccount(next, data, actor, true);
      appendNotifications(workspace, next, actor.id, 'accountMemberships');
      if (await db.prepare('SELECT account_id FROM auth_credentials WHERE login = ?').bind(added.login).first()) fail(400, 'LOGIN_EXISTS', '此账号已存在');
      const passwordHash = await hashPassword(data.password);
      const results = await db.batch([
        workspaceUpdate(db, next, workspace.revision),
        db.prepare('INSERT INTO auth_credentials (account_id, login, password_hash, must_change, version, updated_at) SELECT ?, ?, ?, 1, 1, ? WHERE changes() = 1')
          .bind(added.id, added.login, passwordHash, added.updatedAt),
      ]);
      assertChanged(results[0]);
      next.revision += 1;
      return json({ ...await localSession(db, next, credential), accounts: await localAccountList(db, next) }, 201);
    }
    const resetAccountId = path.match(/^\/api\/accounts\/([^/]+)\/password$/)?.[1];
    if (resetAccountId && method === 'POST') {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      if (resetAccountId === account.id) fail(400, 'USE_PASSWORD_CHANGE', '请在“我的账号”中修改自己的密码');
      const next = structuredClone(workspace);
      const target = next.accounts.find((entry) => entry.id === resetAccountId);
      if (!target) fail(404, 'NOT_FOUND', '账号不存在');
      manageAccountTarget(actor, next.state.users.find(user => user.id === target.userId));
      const targetCredential = await db.prepare('SELECT * FROM auth_credentials WHERE account_id = ?').bind(target.id).first();
      if (!targetCredential) fail(400, 'MIGRATION_REQUIRED', '此旧账号尚未绑定独立登录，请通过本机迁移命令处理');
      const passwordHash = await hashPassword(data.password);
      target.updatedAt = new Date().toISOString();
      log(next, actor.id, `重置账号密码：${next.state.users.find((user) => user.id === target.userId)?.name || '成员'}；下次登录须修改密码`);
      const results = await db.batch([
        workspaceUpdate(db, next, workspace.revision),
        db.prepare('UPDATE auth_credentials SET password_hash = ?, must_change = 1, version = version + 1, updated_at = ? WHERE account_id = ? AND changes() = 1')
          .bind(passwordHash, target.updatedAt, target.id),
        db.prepare('DELETE FROM auth_sessions WHERE account_id = ? AND changes() = 1').bind(target.id),
      ]);
      assertChanged(results[0]);
      next.revision += 1;
      return json({ ...await localSession(db, next, credential), accounts: await localAccountList(db, next) });
    }
    const accountId = path.match(/^\/api\/accounts\/([^/]+)$/)?.[1];
    if (accountId && method === 'DELETE') {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      const next = structuredClone(workspace);
      deleteAccount(next, accountId, actor, account);
      const results = await db.batch([
        workspaceUpdate(db, next, workspace.revision),
        db.prepare('DELETE FROM auth_credentials WHERE account_id = ? AND changes() = 1').bind(accountId),
        db.prepare('DELETE FROM auth_sessions WHERE account_id = ? AND changes() = 1').bind(accountId),
      ]);
      assertChanged(results[0]);
      next.revision += 1;
      return json({ ...await localSession(db, next, credential), accounts: await localAccountList(db, next) });
    }
    if (accountId && method === 'PATCH') {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      const next = structuredClone(workspace);
      changeAccount(next, accountId, data, actor, account);
      appendNotifications(workspace, next, actor.id, 'accountMemberships');
      const statements = [workspaceUpdate(db, next, workspace.revision)];
      const previousAccount = workspace.accounts.find((entry) => entry.id === accountId);
      const updatedAccount = next.accounts.find((entry) => entry.id === accountId);
      const previousRole = workspace.state.users.find((entry) => entry.id === previousAccount.userId)?.role;
      const updatedRole = next.state.users.find((entry) => entry.id === updatedAccount.userId)?.role;
      const membershipChanged = !isAdminRole(previousRole) && workspace.state.projects.some((project) => project.memberIds.includes(previousAccount.userId) !== next.state.projects.find((entry) => entry.id === project.id)?.memberIds.includes(previousAccount.userId));
      const accessChanged = previousAccount.status !== updatedAccount.status || previousRole !== updatedRole || membershipChanged;
      if (accountId !== account.id && accessChanged) {
        statements.push(db.prepare('UPDATE auth_credentials SET version = version + 1 WHERE account_id = ? AND changes() = 1').bind(accountId));
        statements.push(db.prepare('DELETE FROM auth_sessions WHERE account_id = ? AND changes() = 1').bind(accountId));
      }
      const results = await db.batch(statements);
      assertChanged(results[0]);
      next.revision += 1;
      return json({ ...await localSession(db, next, credential), accounts: await localAccountList(db, next) });
    }
    // Business commands reuse the tested project-level authorization engine.
    const response = await handleApi(request, env, identity);
    if (!response.ok) return response;
    const result = await response.json();
    if (result.account) result.account = { ...result.account, login: credential.login, mustChangePassword: false };
    if (result.capabilities) result.capabilities.files = true;
    return json({ ...result, mustChangePassword: false }, response.status);
  } catch (error) { return httpError(error); }
}
