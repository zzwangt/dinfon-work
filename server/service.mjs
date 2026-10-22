import { createSeedState, normalizeState, transact } from '../public/client/domain.js';
import { sanitizeStateForActor } from '../public/client/access.js';
import { AuthError, normalizeLogin, validatePassword, validPasswordHash, hashPassword, verifyPassword, configuredOrigin, sessionCookie, sessionToken, issueSession, readSession, revokeSession, consumeAuthAttempt, clearAuthAttempts } from './auth.mjs';

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

function session(workspace, identity) {
  const { account, actor } = lookupAccount(workspace, identity);
  const state = sanitizeStateForActor(workspace.state, actor.id);
  return {
    actor: state.users.find((user) => user.id === actor.id),
    account: { id: account.id, email: account.email || '', login: account.login || '', role: actor.role, status: account.status },
    state,
    revision: workspace.revision,
    capabilities: { manageAccounts: actor.role === 'admin', manageAllData: actor.role === 'admin', createProjects: actor.role !== 'member' },
  };
}

function accountList(workspace) {
  return workspace.accounts.map((account) => {
    const user = workspace.state.users.find((entry) => entry.id === account.userId);
    return {
      id: account.id, userId: account.userId, email: account.email || '', login: account.login || '', name: user?.name || '', role: user?.role,
      status: account.status, linked: Boolean(account.login || account.authId), createdAt: account.createdAt,
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

function assignAccountProjects(workspace, user, projectIds, actor) {
  requireValue(Array.isArray(projectIds) && projectIds.every((id) => typeof id === 'string') && new Set(projectIds).size === projectIds.length, '项目权限格式不正确，请重新选择项目');
  const selected = new Set(projectIds);
  requireValue(projectIds.every((id) => workspace.state.projects.some((project) => project.id === id)), '选择的项目不存在，请刷新后重试');
  requireValue(workspace.state.projects.every((project) => project.ownerId !== user.id || selected.has(project.id)), '项目负责人不能移除自己负责的项目，请先调整项目负责人');
  let changes = 0;
  for (const project of workspace.state.projects) {
    const member = project.memberIds.includes(user.id);
    if (member === selected.has(project.id)) continue;
    project.memberIds = selected.has(project.id) ? [...project.memberIds, user.id] : project.memberIds.filter((id) => id !== user.id);
    changes += 1;
  }
  if (changes) log(workspace, actor.id, `更新成员 ${user.name} 的项目权限：参与 ${selected.size} 个项目；既有任务负责人保持不变`);
}

function provisionAccount(workspace, data, actor, local = false) {
  const normalized = local && !data.email ? '' : email(data.email);
  const login = local ? normalizeLogin(data.login) : '';
  const name = string(data.name, '姓名', 30);
  requireValue(ROLES.has(data.role), '请选择有效的账号角色');
  requireValue(!normalized || !workspace.accounts.some((account) => account.email === normalized), '此邮箱已经开通账号');
  if (local) requireValue(!workspace.accounts.some((account) => account.login === login), '此账号已存在');
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
  if (data.projectIds !== undefined) assignAccountProjects(workspace, user, data.projectIds, actor);
  const at = new Date().toISOString();
  const account = { id: identifier('a'), userId: user.id, email: normalized, authId: null, status: 'active', createdAt: at, updatedAt: at, lastLoginAt: null, ...(local ? { login } : {}) };
  workspace.accounts.push(account);
  log(workspace, actor.id, `开通${data.role === 'admin' ? '管理' : data.role === 'manager' ? '项目负责人' : '员工'}账号：${name}`);
  return account;
}

function changeAccount(workspace, id, data, actor, currentAccount) {
  const account = workspace.accounts.find((entry) => entry.id === id);
  if (!account) fail(404, 'NOT_FOUND', '账号不存在');
  const user = workspace.state.users.find((entry) => entry.id === account.userId);
  requireValue(user, '关联成员不存在');
  requireValue(data.role != null || data.status != null || data.active != null || data.projectIds !== undefined, '请选择要修改的角色、账号状态或项目权限');
  if (data.login != null || data.password != null || data.email != null || data.userId != null || data.authId != null || data.existingUserId != null) fail(400, 'IMMUTABLE_IDENTITY', '登录账号不可直接更改，请通过重置密码操作修改密码');
  const role = data.role ?? user.role;
  requireValue(ROLES.has(role), '请选择有效的账号角色');
  if (data.active != null) requireValue(typeof data.active === 'boolean', '账号状态无效');
  const status = data.status ?? (data.active == null ? account.status : data.active ? 'active' : 'disabled');
  requireValue(['active', 'disabled'].includes(status), '账号状态无效');
  if (data.status != null && data.active != null) requireValue((status === 'active') === data.active, '账号状态不一致');
  if (account.id === currentAccount.id && (status === 'disabled' || role !== 'admin')) fail(400, 'SELF_LOCKOUT', '不能停用或降级当前登录的管理账号');
  const remainingAdmins = workspace.accounts.filter((entry) => entry.id !== account.id && entry.status === 'active' && workspace.state.users.find((person) => person.id === entry.userId)?.role === 'admin');
  if (user.role === 'admin' && account.status === 'active' && (role !== 'admin' || status !== 'active') && !remainingAdmins.length) fail(400, 'LAST_ADMIN', '必须保留至少一个有效管理账号');
  if (data.projectIds !== undefined) assignAccountProjects(workspace, user, data.projectIds, actor);
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

function workspaceUpdate(db, workspace, previousRevision) {
  return db.prepare('UPDATE workspace SET payload = ?, revision = revision + 1 WHERE id = ? AND revision = ?')
    .bind(JSON.stringify({ state: workspace.state, accounts: workspace.accounts }), WORKSPACE_ID, previousRevision);
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
  owner.name = typeof env.INITIAL_ADMIN_NAME === 'string' && env.INITIAL_ADMIN_NAME.trim() ? env.INITIAL_ADMIN_NAME.trim().slice(0, 30) : '管理员';
  if (env.SEED_DEMO_DATA !== 'true' && env.SEED_DEMO_DATA !== true) {
    state.users = [owner];
    for (const key of ['projects', 'milestones', 'tasks', 'extensions', 'milestoneRequests', 'logs']) state[key] = [];
  }
  const now = new Date().toISOString();
  const account = { id: identifier('a'), userId: owner.id, login, email: '', authId: null, status: 'active', createdAt: now, updatedAt: now, lastLoginAt: null };
  state.logs.unshift({ id: identifier('log'), at: now, actorId: owner.id, projectId: null, message: '完成平台初始化，启用独立账号登录' });
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO workspace (id, payload, revision) VALUES (?, ?, 1)').bind(WORKSPACE_ID, JSON.stringify({ state, accounts: [account] })),
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
  if (!account || actor?.role !== 'admin') fail(400, 'ADMIN_REQUIRED', '请选择现有的有效管理账号进行迁移');
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
  if (!account || actor?.role !== 'admin') fail(400, 'ADMIN_REQUIRED', '请填写现有的有效管理账号');
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

function localSession(workspace, credential) {
  const identity = { localAccountId: credential.account_id };
  const { account, actor } = lookupAccount(workspace, identity);
  const mustChangePassword = Boolean(credential.must_change);
  const accountView = { id: account.id, login: credential.login, email: account.email || '', role: actor.role, status: account.status, mustChangePassword };
  if (mustChangePassword) {
    // A temporary password permits only changing that password or signing out.
    // No projects, employee directory, tasks, or business history are disclosed.
    return { actor: { id: actor.id, name: actor.name, role: actor.role }, account: accountView, mustChangePassword, capabilities: {}, revision: workspace.revision };
  }
  return { ...session(workspace, identity), account: accountView, mustChangePassword: false };
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
      const response = json(localSession(saved, current));
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
    if (path === '/api/session' && method === 'GET') return json(localSession(workspace, credential));
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
      const response = json(localSession(latestWorkspace, refreshed));
      response.headers.set('Set-Cookie', cookie);
      return response;
    }
    if (credential.must_change) fail(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改初始密码，再进入工作平台');
    if (path === '/api/accounts' && method === 'GET') {
      adminOnly(actor);
      return json({ accounts: await localAccountList(db, workspace), users: sanitizeStateForActor(workspace.state, actor.id).users, revision: workspace.revision });
    }
    if (path === '/api/accounts' && method === 'POST') {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      const next = structuredClone(workspace);
      const added = provisionAccount(next, data, actor, true);
      if (await db.prepare('SELECT account_id FROM auth_credentials WHERE login = ?').bind(added.login).first()) fail(400, 'LOGIN_EXISTS', '此账号已存在');
      const passwordHash = await hashPassword(data.password);
      const results = await db.batch([
        workspaceUpdate(db, next, workspace.revision),
        db.prepare('INSERT INTO auth_credentials (account_id, login, password_hash, must_change, version, updated_at) SELECT ?, ?, ?, 1, 1, ? WHERE changes() = 1')
          .bind(added.id, added.login, passwordHash, added.updatedAt),
      ]);
      assertChanged(results[0]);
      next.revision += 1;
      return json({ ...localSession(next, credential), accounts: await localAccountList(db, next) }, 201);
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
      return json({ ...localSession(next, credential), accounts: await localAccountList(db, next) });
    }
    const accountId = path.match(/^\/api\/accounts\/([^/]+)$/)?.[1];
    if (accountId && method === 'PATCH') {
      adminOnly(actor);
      const data = await body(request);
      revisionMatches(data.revision, workspace.revision);
      const next = structuredClone(workspace);
      changeAccount(next, accountId, data, actor, account);
      const statements = [workspaceUpdate(db, next, workspace.revision)];
      if (accountId !== account.id) {
        statements.push(db.prepare('UPDATE auth_credentials SET version = version + 1 WHERE account_id = ? AND changes() = 1').bind(accountId));
        statements.push(db.prepare('DELETE FROM auth_sessions WHERE account_id = ? AND changes() = 1').bind(accountId));
      }
      const results = await db.batch(statements);
      assertChanged(results[0]);
      next.revision += 1;
      return json({ ...localSession(next, credential), accounts: await localAccountList(db, next) });
    }
    // Business commands reuse the tested project-level authorization engine.
    const response = await handleApi(request, env, identity);
    if (!response.ok) return response;
    const result = await response.json();
    if (result.account) result.account = { ...result.account, login: credential.login, mustChangePassword: false };
    return json({ ...result, mustChangePassword: false }, response.status);
  } catch (error) { return httpError(error); }
}
