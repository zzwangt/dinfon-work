import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
// OWASP's 32 MiB scrypt profile: N=2^15, r=8, p=3. A bounded worker
// count prevents password requests from allocating unbounded native memory.
const COST = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const SESSION_SECONDS = 12 * 60 * 60;
const DUMMY_HASH = `$scrypt$32768$8$3$${'A'.repeat(22)}$${'A'.repeat(86)}`;
let activeDerivations = 0;

export class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export function normalizeLogin(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._@-]{2,63}$/i.test(value.trim())) {
    throw new AuthError(400, 'INVALID_LOGIN', '账号需为 3–64 位英文字母、数字、点、横线、下划线或 @，并以字母或数字开头');
  }
  return value.trim().toLowerCase();
}

export function validatePassword(value) {
  if (typeof value !== 'string' || Array.from(value).length < 12 || Array.from(value).length > 128) {
    throw new AuthError(400, 'INVALID_PASSWORD', '密码需为 12–128 个字符，可使用长句；请勿重复使用其他网站的密码');
  }
  return value;
}

export function validPasswordHash(hash) {
  return typeof hash === 'string' && /^\$scrypt\$32768\$8\$3\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(hash);
}

async function derivePassword(password, salt) {
  if (activeDerivations >= 4) throw new AuthError(429, 'AUTH_BUSY', '登录请求较多，请稍后重试');
  activeDerivations += 1;
  try { return await derive(password, salt, 64, COST); }
  finally { activeDerivations -= 1; }
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return `$scrypt$32768$8$3$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, hash) {
  const validInput = typeof password === 'string' && Array.from(password).length <= 128;
  const validHash = validPasswordHash(hash);
  const parts = (validHash ? hash : DUMMY_HASH).split('$');
  const key = await derivePassword(validInput ? password : '', Buffer.from(parts[5], 'base64url'));
  const matches = timingSafeEqual(key, Buffer.from(parts[6], 'base64url'));
  return validInput && validHash && matches;
}

export async function initializeAuthSchema(db) {
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS auth_credentials (account_id TEXT PRIMARY KEY NOT NULL, login TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, credential_version INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS auth_sessions_account ON auth_sessions (account_id)',
    'CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions (expires_at)',
    'CREATE TABLE IF NOT EXISTS auth_rate_limits (bucket TEXT PRIMARY KEY NOT NULL, attempts INTEGER NOT NULL, window_end INTEGER NOT NULL)',
  ]) await db.prepare(sql).run();
}

export function configuredOrigin(env) {
  let url;
  try { url = new URL(env.SITE_ORIGIN); } catch { throw new AuthError(503, 'SETUP_REQUIRED', '平台访问地址尚未配置，请联系管理员'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.origin !== env.SITE_ORIGIN || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new AuthError(503, 'SETUP_REQUIRED', '平台访问地址需为 HTTPS 域名，本机调试可使用 localhost');
  }
  return url.origin;
}

function cookieName(env) { return configuredOrigin(env).startsWith('https:') ? '__Host-dinfon_session' : 'dinfon_session'; }
export function sessionToken(request, env) {
  const matches = (request.headers.get('Cookie') || '').split(';').map((entry) => entry.trim()).filter((entry) => entry.startsWith(`${cookieName(env)}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(matches[0].indexOf('=') + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function sessionCookie(env, token = '', clear = false) {
  const secure = configuredOrigin(env).startsWith('https:');
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_SECONDS}${secure ? '; Secure' : ''}`;
}

export async function issueSession(db, env, credential, oldToken = null) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const statements = [db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(now)];
  if (oldToken) statements.push(db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(digest(oldToken)));
  // The expensive password check may overlap a reset, role change or disable.
  // Session issuance is the final authorization boundary: never insert a cookie
  // for a superseded credential, even if it was valid when hashing began.
  statements.push(db.prepare("INSERT INTO auth_sessions (token_hash, account_id, credential_version, expires_at, created_at) SELECT ?, c.account_id, c.version, ?, ? FROM auth_credentials c WHERE c.account_id = ? AND c.version = ? AND c.must_change = ? AND EXISTS (SELECT 1 FROM workspace w, json_each(w.payload, '$.accounts') a WHERE w.id = 'main' AND json_extract(a.value, '$.id') = c.account_id AND json_extract(a.value, '$.status') = 'active')")
    .bind(digest(token), now + SESSION_SECONDS * 1000, now, credential.account_id, credential.version, credential.must_change));
  const results = await db.batch(statements);
  if (results.at(-1)?.meta?.changes !== 1) throw new AuthError(401, 'AUTH_REQUIRED', '账号信息已更新，请使用最新密码重新登录');
  return sessionCookie(env, token);
}

export async function readSession(db, request, env) {
  const token = sessionToken(request, env);
  if (!token) return null;
  return db.prepare('SELECT c.*, s.token_hash FROM auth_sessions s JOIN auth_credentials c ON c.account_id = s.account_id AND c.version = s.credential_version WHERE s.token_hash = ? AND s.expires_at > ?')
    .bind(digest(token), Date.now()).first();
}

export async function revokeSession(db, request, env) {
  const token = sessionToken(request, env);
  if (token) await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(digest(token)).run();
}

// Counts are persistent and increment atomically before expensive hashing. The
// runtime supplies CLIENT_IP from the socket/trusted proxy, never arbitrary headers.
export async function consumeAuthAttempt(db, bucket, limit = 10) {
  const now = Date.now();
  const key = digest(bucket);
  await db.prepare('DELETE FROM auth_rate_limits WHERE window_end <= ?').bind(now).run();
  const row = await db.prepare('INSERT INTO auth_rate_limits (bucket, attempts, window_end) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts, window_end')
    .bind(key, now + 15 * 60 * 1000).first();
  if (row.attempts > limit) throw new AuthError(429, 'AUTH_RATE_LIMITED', '尝试次数过多，请 15 分钟后再试');
}

export async function clearAuthAttempts(db, bucket) {
  await db.prepare('DELETE FROM auth_rate_limits WHERE bucket = ?').bind(digest(bucket)).run();
}
