import { createSeedState, normalizeState, transact } from '../public/client/domain.js';
import { sanitizeStateForActor } from '../public/client/access.js';

const WORKSPACE_ID = 'main';
const ROLES = new Set(['admin', 'manager', 'member']);
const COMMANDS = new Set(['createProject', 'createTask', 'updateTask', 'submitTask', 'reviewTask', 'requestMilestone', 'reviewMilestoneRequest', 'completeMilestone', 'requestExtension', 'reviewExtension']);
const MAX_BODY_BYTES = 65536;

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
  if (!identity || typeof identity.userId !== 'string' || !identity.userId.trim() || typeof identity.email !== 'string') {
    fail(401, 'AUTH_REQUIRED', '请先使用 ChatGPT 账号登录');
  }
  let normalized;
  try { normalized = email(identity.email); } catch { fail(401, 'AUTH_REQUIRED', '无法确认登录邮箱，请重新登录'); }
  return { authId: identity.userId, email: normalized, displayName: typeof identity.displayName === 'string' ? identity.displayName.trim().slice(0, 30) : '' };
}

async function body(request) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    fail(403, 'ORIGIN_REJECTED', '请求来源无效，请从平台页面重试');
  }
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, 'JSON_REQUIRED', '请求必须使用 JSON 格式');
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) fail(413, 'BODY_TOO_LARGE', '提交内容过长');
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) fail(413, 'BODY_TOO_LARGE', '提交内容过长');
  let value;
  try { value = JSON.parse(raw); } catch { fail(400, 'INVALID_JSON', '提交内容格式不正确'); }
  requireValue(value && typeof value === 'object' && !Array.isArray(value), '提交内容格式不正确');
  return value;
}

function revisionMatches(value, expected) {
  requireValue(Number.isSafeInteger(value) && value >= 1, '请先刷新平台数据再操作');
  if (value !== expected) fail(409, 'REVISION_CONFLICT', '数据已被其他人更新，请刷新后重试；本次修改尚未保存');
}

async function readWorkspace(db) {
  const row = await db.prepare('SELECT payload, revision FROM workspace WHERE id = ?').bind(WORKSPACE_ID).first();
  if (!row) return null;
  const value = JSON.parse(row.payload);
  if (!value || !Array.isArray(value.accounts) || !value.state || !Number.isSafeInteger(row.revision)) throw new Error('Invalid workspace');
  // Normalize retired statuses only in the loaded copy. Reading does not reset
  // business history, change deadlines or advance the stored revision.
  value.state = normalizeState(value.state);
  return { ...value, revision: row.revision };
}

async function saveWorkspace(db, next, previousRevision) {
  const result = await db.prepare('UPDATE workspace SET payload = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
    .bind(JSON.stringify({ state: next.state, accounts: next.accounts }), WORKSPACE_ID, previousRevision).run();
  if (result.meta?.changes !== 1) fail(409, 'REVISION_CONFLICT', '数据已被其他人更新，请刷新后重试；本次修改尚未保存');
  return { ...next, revision: previousRevision + 1 };
}

async function bootstrap(db, env, identity) {
  let configured;
  try { configured = email(env.FIRST_ADMIN_EMAIL); } catch { fail(503, 'SETUP_REQUIRED', '平台尚未配置首位管理员，请联系平台负责人'); }
  if (identity.email !== configured) fail(403, 'ACCOUNT_NOT_PROVISIONED', '当前账号尚未开通，请联系管理员添加你的 ChatGPT 登录邮箱');
  const state = createSeedState();
  const owner = state.users.find((user) => user.id === 'u-admin');
  // Hosting may use the login email as its display-name fallback. Keep that
  // authentication detail out of business profiles shared with project members.
  owner.name = identity.displayName && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.displayName) ? identity.displayName : '管理员';
  const at = new Date().toISOString();
  const accounts = [{ id: identifier('a'), userId: owner.id, email: identity.email, authId: identity.authId, status: 'active', createdAt: at, updatedAt: at, lastLoginAt: at }];
  state.logs.unshift({ id: identifier('log'), at, actorId: owner.id, projectId: null, message: '完成管理员账号绑定，启用独立账号与共享数据' });
  await db.prepare('INSERT OR IGNORE INTO workspace (id, payload, revision) VALUES (?, ?, 1)')
    .bind(WORKSPACE_ID, JSON.stringify({ state, accounts })).run();
  return readWorkspace(db);
}

function lookupAccount(workspace, identity) {
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
    if (!bind && !account.authId) fail(403, 'SESSION_REQUIRED', '请先进入平台完成首次登录绑定');
    const shouldTouch = bind && (!account.authId || !account.lastLoginAt || Date.now() - Date.parse(account.lastLoginAt) > 10 * 60 * 1000);
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

function session(workspace, identity) {
  const { account, actor } = lookupAccount(workspace, identity);
  const state = sanitizeStateForActor(workspace.state, actor.id);
  return {
    actor: state.users.find((user) => user.id === actor.id),
    account: { id: account.id, email: account.email, role: actor.role, status: account.status },
    state,
    revision: workspace.revision,
    capabilities: { manageAccounts: actor.role === 'admin', manageAllData: actor.role === 'admin', createProjects: actor.role !== 'member' },
  };
}

function accountList(workspace) {
  return workspace.accounts.map((account) => {
    const user = workspace.state.users.find((entry) => entry.id === account.userId);
    return {
      id: account.id, userId: account.userId, email: account.email, name: user?.name || '', role: user?.role,
      status: account.status, linked: Boolean(account.authId), createdAt: account.createdAt,
      updatedAt: account.updatedAt, lastLoginAt: account.lastLoginAt || null,
    };
  });
}

function adminOnly(actor) {
  if (actor.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '仅管理账号可以执行此操作');
}

function log(workspace, actorId, message) {
  workspace.state.logs.unshift({ id: identifier('log'), at: new Date().toISOString(), actorId, projectId: null, message });
}

function accessibleCommand(workspace, actor, action, payload) {
  if (actor.role === 'admin' || action === 'createProject') return;
  const scope = sanitizeStateForActor(workspace.state, actor.id);
  let projectId = payload.projectId;
  if (['updateTask', 'submitTask', 'reviewTask'].includes(action)) projectId = workspace.state.tasks.find((task) => task.id === payload.id)?.projectId;
  if (action === 'completeMilestone') projectId = workspace.state.milestones.find((milestone) => milestone.id === payload.id)?.projectId;
  if (action === 'reviewExtension' || action === 'reviewMilestoneRequest') { adminOnly(actor); return; }
  if (!scope.projects.some((project) => project.id === projectId)) fail(404, 'NOT_FOUND', '项目或任务不存在，或你没有访问权限');
}

function provisionAccount(workspace, data, actor) {
  const normalized = email(data.email);
  const name = string(data.name, '姓名', 30);
  requireValue(ROLES.has(data.role), '请选择有效的账号角色');
  requireValue(!workspace.accounts.some((account) => account.email === normalized), '此邮箱已经开通账号');
  let user;
  if (data.existingUserId) {
    user = workspace.state.users.find((entry) => entry.id === data.existingUserId);
    requireValue(user, '要关联的项目成员不存在');
    requireValue(!workspace.accounts.some((account) => account.userId === user.id), '此项目成员已关联登录账号');
    user.name = name;
    user.role = data.role;
    if (data.title != null) user.title = string(data.title, '岗位', 60, true);
    if (data.department != null) user.department = string(data.department, '部门', 60, true);
  } else {
    user = {
      id: identifier('u'), name, role: data.role,
      title: string(data.title, '岗位', 60, true) || (data.role === 'member' ? '项目成员' : data.role === 'manager' ? '项目负责人' : '管理员'),
      department: string(data.department, '部门', 60, true) || '未分配部门',
      color: ['#52756e', '#526ba0', '#977951', '#8a6e9b'][workspace.state.users.length % 4],
    };
    workspace.state.users.push(user);
  }
  const at = new Date().toISOString();
  workspace.accounts.push({ id: identifier('a'), userId: user.id, email: normalized, authId: null, status: 'active', createdAt: at, updatedAt: at, lastLoginAt: null });
  log(workspace, actor.id, `开通${data.role === 'admin' ? '管理' : data.role === 'manager' ? '项目负责人' : '员工'}账号：${name}`);
}

function changeAccount(workspace, id, data, actor, currentAccount) {
  const account = workspace.accounts.find((entry) => entry.id === id);
  if (!account) fail(404, 'NOT_FOUND', '账号不存在');
  const user = workspace.state.users.find((entry) => entry.id === account.userId);
  requireValue(user, '关联成员不存在');
  requireValue(data.role != null || data.status != null || data.active != null, '请选择要修改的角色或账号状态');
  if (data.email != null || data.userId != null || data.authId != null || data.existingUserId != null) fail(400, 'IMMUTABLE_IDENTITY', '登录身份绑定不可直接更改');
  const role = data.role ?? user.role;
  requireValue(ROLES.has(role), '请选择有效的账号角色');
  if (data.active != null) requireValue(typeof data.active === 'boolean', '账号状态无效');
  const status = data.status ?? (data.active == null ? account.status : data.active ? 'active' : 'disabled');
  requireValue(['active', 'disabled'].includes(status), '账号状态无效');
  if (data.status != null && data.active != null) requireValue((status === 'active') === data.active, '账号状态不一致');
  if (account.id === currentAccount.id && (status === 'disabled' || role !== 'admin')) fail(400, 'SELF_LOCKOUT', '不能停用或降级当前登录的管理账号');
  const remainingAdmins = workspace.accounts.filter((entry) => entry.id !== account.id && entry.status === 'active' && workspace.state.users.find((person) => person.id === entry.userId)?.role === 'admin');
  if (user.role === 'admin' && account.status === 'active' && (role !== 'admin' || status !== 'active') && !remainingAdmins.length) fail(400, 'LAST_ADMIN', '必须保留至少一个有效管理账号');
  user.role = role;
  account.status = status;
  account.updatedAt = new Date().toISOString();
  log(workspace, actor.id, `更新账号 ${user.name}：${role === 'admin' ? '管理员' : role === 'manager' ? '项目负责人' : '员工'}，${status === 'active' ? '启用' : '停用'}`);
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
      return json(session(workspace, identity));
    }
    const { workspace, actor, account } = await context(env.DB, env, identity);
    if (path === '/api/accounts' && method === 'GET') {
      adminOnly(actor);
      return json({ accounts: accountList(workspace), users: sanitizeStateForActor(workspace.state, actor.id).users, revision: workspace.revision });
    }
    if (path === '/api/command' && method === 'POST') {
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      requireValue(COMMANDS.has(data.action), '不支持的业务操作');
      requireValue(data.payload == null || (typeof data.payload === 'object' && !Array.isArray(data.payload)), '操作内容格式不正确');
      const payload = data.payload || {};
      accessibleCommand(workspace, actor, data.action, payload);
      if (data.action === 'reviewMilestoneRequest' && payload.approve === true) {
        const application = workspace.state.milestoneRequests.find((entry) => entry.id === payload.id);
        if (application && !workspace.accounts.some((entry) => entry.userId === application.applicantId && entry.status === 'active')) {
          fail(400, 'APPLICANT_DISABLED', '申请人账号已停用或不存在，请驳回此申请后由有效成员重新提交');
        }
      }
      let state;
      try { state = transact(workspace.state, data.action, payload, actor.id); }
      catch (error) { fail(400, 'COMMAND_REJECTED', error instanceof Error ? error.message : '操作未通过校验'); }
      const saved = await saveWorkspace(env.DB, { ...workspace, state }, workspace.revision);
      return json(session(saved, identity));
    }
    const accountId = path.match(/^\/api\/accounts\/([^/]+)$/)?.[1];
    if ((path === '/api/accounts' && method === 'POST') || (accountId && method === 'PATCH')) {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      const next = structuredClone(workspace);
      if (accountId) changeAccount(next, accountId, data, actor, account);
      else provisionAccount(next, data, actor);
      const saved = await saveWorkspace(env.DB, next, workspace.revision);
      return json({ ...session(saved, identity), accounts: accountList(saved) }, accountId ? 200 : 201);
    }
    fail(404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status);
    // Do not expose database contents, SQL, authentication data, or stack traces.
    console.error('Management API request failed');
    return json({ error: '服务暂时无法处理请求，请稍后重试', code: 'INTERNAL_ERROR' }, 500);
  }
}
