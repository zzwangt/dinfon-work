import { isAdminRole } from '../public/client/roles.js';
import { createHash } from 'node:crypto';
import { workspacePayload } from './notifications.mjs';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
const schemas = new WeakMap();
const columns = 'id, project_id, entity_type, entity_id, name, size, mime_type, uploaded_by, uploaded_at';

class FileError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new FileError(status, code, message); };
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store, private', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } });

export async function initializeFileSchema(db) {
  if (!schemas.has(db)) {
    const ready = (async () => {
      await db.prepare('CREATE TABLE IF NOT EXISTS project_files (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, mime_type TEXT NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL)').run();
      await db.prepare('CREATE INDEX IF NOT EXISTS project_files_project ON project_files (project_id, uploaded_at)').run();
      await db.prepare('CREATE INDEX IF NOT EXISTS project_files_entity ON project_files (project_id, entity_type, entity_id)').run();
    })();
    schemas.set(db, ready);
    ready.catch(() => schemas.delete(db));
  }
  await schemas.get(db);
}

function identifier(value, label) {
  if (typeof value !== 'string' || !value || value.length > 150 || /[\u0000-\u001f\u007f]/u.test(value)) fail(400, 'INVALID_INPUT', `请选择有效的${label}`);
  return value;
}
function projectFor(context, projectId) {
  const project = context.workspace.state.projects.find(item => item.id === projectId);
  if (!project || !(isAdminRole(context.actor.role) || project.ownerId === context.actor.id || project.memberIds?.includes(context.actor.id))) fail(404, 'NOT_FOUND', '项目或文件不存在，或你无权访问');
  return project;
}
function entityFor(context, projectId, entityType, entityId) {
  if (!['task', 'milestone'].includes(entityType)) fail(400, 'INVALID_INPUT', '请选择任务或大节点');
  const entity = context.workspace.state[entityType === 'task' ? 'tasks' : 'milestones'].find(item => item.id === entityId && item.projectId === projectId);
  if (!entity) fail(404, 'NOT_FOUND', '节点不存在或不属于该项目');
  return entity;
}
function canDelete(context, project, row) {
  return isAdminRole(context.actor.role) || project.ownerId === context.actor.id || row.uploaded_by === context.actor.id;
}
function metadata(context, project, row) {
  return { id: row.id, projectId: row.project_id, entityType: row.entity_type, entityId: row.entity_id, name: row.name, size: row.size, mimeType: row.mime_type, uploadedBy: row.uploaded_by, uploaderName: context.workspace.state.users.find(user => user.id === row.uploaded_by)?.name || '已移除成员', uploadedAt: row.uploaded_at, canDelete: canDelete(context, project, row) };
}
function sameOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'ORIGIN_REJECTED', '请求来源无效，请从平台页面重试');
}
async function limitedBody(request, maxBytes) {
  if (Number(request.headers.get('Content-Length') || 0) > maxBytes) fail(413, 'BODY_TOO_LARGE', '文件过大，每个文件最多 20 MB');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', '文件过大，每个文件最多 20 MB'); }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
function filename(value) {
  const name = String(value || '').normalize('NFC').trim();
  if (!name || name === '.' || name === '..' || Array.from(name).length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(name)) fail(400, 'INVALID_FILENAME', '文件名无效，请使用不超过 180 个字且不含路径或控制字符的文件名');
  return name;
}
function writeGuard(context) {
  // Use the project permission and session verified for this workspace revision.
  return {
    sql: "EXISTS (SELECT 1 FROM workspace WHERE id = 'main' AND revision = ?) AND EXISTS (SELECT 1 FROM auth_sessions s JOIN auth_credentials c ON c.account_id = s.account_id AND c.version = s.credential_version WHERE s.token_hash = ? AND c.account_id = ? AND c.version = ? AND c.must_change = 0 AND s.expires_at > ?)",
    values: [context.workspace.revision, context.credential.token_hash, context.account.id, context.credential.version, Date.now()],
  };
}
function assertWritten(result) {
  if (result.meta?.changes !== 1) fail(409, 'FILE_CONFLICT', '账号或项目权限已更新，请刷新后重试；本次修改尚未保存');
}

async function saveAttachment(db, context, row, statement) {
  const { workspace, actor } = context;
  const milestoneId = row.entity_type === 'task'
    ? workspace.state.tasks.find(task => task.id === row.entity_id && task.projectId === row.project_id)?.milestoneId
    : row.entity_id;
  const milestone = workspace.state.milestones.find(node => node.id === milestoneId && node.projectId === row.project_id);
  if (!milestone?.signatures?.length || milestone.status === 'done') {
    assertWritten(await statement.run());
    return;
  }
  // Both reviewers must sign the same evidence. Only a file change during
  // an unfinished signed review also needs to update the business snapshot.
  const next = structuredClone(workspace);
  const node = next.state.milestones.find(item => item.id === milestoneId);
  next.state.logs.unshift({
    id: 'log-' + crypto.randomUUID(), at: new Date().toISOString(), actorId: actor.id, projectId: row.project_id,
    message: '“' + node.title + '”的验收附件已变更，原签字失效',
    changes: { signatures: { before: node.signatures, after: [] } },
  });
  node.signatures = [];
  const updateState = db.prepare("UPDATE workspace SET payload = ?, revision = revision + 1 WHERE id = 'main' AND revision = ? AND changes() = 1")
    .bind(workspacePayload(next), workspace.revision);
  const [fileWrite, stateWrite] = await db.batch([statement, updateState]);
  assertWritten(fileWrite);
  assertWritten(stateWrite);
}

/** Called only after cookie authentication and forced-password-change checks.
 * Reauthorize after reading uploads so a slow upload cannot retain revoked access.
 */
export async function handleFileApi(request, { db, authorize }) {
  try {
    const url = new URL(request.url), path = url.pathname.replace(/\/$/, ''), method = request.method.toUpperCase();
    await initializeFileSchema(db);
    if (path === '/api/files' && method === 'GET') {
      const projectId = identifier(url.searchParams.get('projectId'), '项目');
      const context = await authorize(), project = projectFor(context, projectId);
      if (url.searchParams.get('summary') === 'counts') {
        const result = await db.prepare('SELECT entity_type AS type, entity_id AS id, COUNT(*) AS total FROM project_files WHERE project_id = ? GROUP BY entity_type, entity_id').bind(projectId).all();
        return json({ counts: result.results });
      }
      const entityType = url.searchParams.get('entityType'), entityId = url.searchParams.get('entityId');
      if (entityType || entityId) entityFor(context, projectId, entityType, identifier(entityId, '节点'));
      const includeTaskFiles = url.searchParams.get('includeTaskFiles') === 'true';
      if (includeTaskFiles && entityType !== 'milestone') fail(400, 'INVALID_INPUT', '请选择需要汇总文件的大节点');
      let filter = entityType ? ' AND entity_type = ? AND entity_id = ?' : '';
      let values = entityType ? [entityType, entityId] : [];
      if (includeTaskFiles) {
        const taskIds = context.workspace.state.tasks.filter(task => task.projectId === projectId && task.milestoneId === entityId).map(task => task.id);
        // Resolve current membership without rewriting existing attachment metadata.
        // A JSON parameter avoids both interpolated identifiers and SQL variable limits.
        filter = ' AND ((entity_type = ? AND entity_id = ?) OR (entity_type = ? AND entity_id IN (SELECT value FROM json_each(?))))';
        values = ['milestone', entityId, 'task', JSON.stringify(taskIds)];
      }
      const query = `SELECT ${columns} FROM project_files WHERE project_id = ?${filter} ORDER BY uploaded_at DESC, id DESC`;
      const result = await db.prepare(query).bind(projectId, ...values).all();
      return json({ files: result.results.map(row => metadata(context, project, row)), maxFileBytes: MAX_FILE_BYTES });
    }
    if (path === '/api/files' && method === 'POST') {
      sameOrigin(request);
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('multipart/form-data;')) fail(415, 'MULTIPART_REQUIRED', '请通过文件选择或拖拽上传文件');
      const bytes = await limitedBody(request, MAX_FILE_REQUEST_BYTES);
      let form;
      try { form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': request.headers.get('Content-Type') }, body: bytes }).formData(); }
      catch { fail(400, 'INVALID_MULTIPART', '上传内容格式不正确，请重新选择文件'); }
      const file = form.get('file');
      if (!(file instanceof File) || form.getAll('file').length !== 1 || [...form.values()].filter(value => value instanceof File).length !== 1) fail(400, 'FILE_REQUIRED', '每次请选择一个文件上传');
      if (file.size > MAX_FILE_BYTES) fail(413, 'FILE_TOO_LARGE', '文件过大，每个文件最多 20 MB');
      if (!file.size) fail(400, 'EMPTY_FILE', '不能上传空文件');
      const projectId = identifier(form.get('projectId'), '项目'), entityType = form.get('entityType'), entityId = identifier(form.get('entityId'), '节点');
      const name = filename(file.name), content = Buffer.from(await file.arrayBuffer());
      const context = await authorize(), project = projectFor(context, projectId);
      entityFor(context, projectId, entityType, entityId);
      const row = { id: `f-${crypto.randomUUID()}`, project_id: projectId, entity_type: entityType, entity_id: entityId, name, size: content.length, mime_type: file.type.slice(0, 150) || 'application/octet-stream', uploaded_by: context.actor.id, uploaded_at: new Date().toISOString() };
      const guard = writeGuard(context);
      const insert = db.prepare(`INSERT INTO project_files (${columns}, sha256, content) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`)
        .bind(row.id, projectId, entityType, entityId, name, row.size, row.mime_type, row.uploaded_by, row.uploaded_at, createHash('sha256').update(content).digest('hex'), content, ...guard.values);
      await saveAttachment(db, context, row, insert);
      return json({ file: metadata(context, project, row) }, 201);
    }
    const match = path.match(/^\/api\/files\/([^/]+)(\/download)?$/);
    if (match && ((method === 'GET' && match[2]) || (method === 'DELETE' && !match[2]))) {
      if (method === 'DELETE') {
        sameOrigin(request);
        if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, 'JSON_REQUIRED', '请求必须使用 JSON 格式');
        const raw = await limitedBody(request, 65536);
        let data;
        try { data = JSON.parse(raw.toString()); } catch { fail(400, 'INVALID_JSON', '提交内容格式不正确'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'INVALID_INPUT', '提交内容格式不正确');
      }
      const context = await authorize();
      const row = await db.prepare(`SELECT ${columns} FROM project_files WHERE id = ?`).bind(match[1]).first();
      if (!row) fail(404, 'NOT_FOUND', '项目或文件不存在，或你无权访问');
      const project = projectFor(context, row.project_id);
      if (method === 'DELETE') {
        if (!canDelete(context, project, row)) fail(403, 'FORBIDDEN', '仅上传人、项目负责人或管理员可以删除文件');
        const guard = writeGuard(context);
        const remove = db.prepare(`DELETE FROM project_files WHERE id = ? AND ${guard.sql}`).bind(row.id, ...guard.values);
        await saveAttachment(db, context, row, remove);
        return json({ ok: true });
      }
      const guard = writeGuard(context);
      const stored = await db.prepare(`SELECT content FROM project_files WHERE id = ? AND ${guard.sql}`).bind(row.id, ...guard.values).first();
      if (!stored) fail(409, 'FILE_CONFLICT', '文件或访问权限已更新，请刷新后重试');
      const encoded = encodeURIComponent(row.name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      return new Response(stored.content, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encoded}`, 'Content-Length': String(row.size), 'Cache-Control': 'no-store, private', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
    }
    fail(404, 'NOT_FOUND', '接口不存在');
  } catch (error) {
    if (error instanceof FileError) return json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
}
