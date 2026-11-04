import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/sqlite.mjs';
import { initializeAuthSchema, hashPassword, issueSession } from '../server/auth.mjs';
import { handleHttpApi, initializeLocalWorkspace } from '../server/service.mjs';
import { MAX_FILE_BYTES, MAX_FILE_REQUEST_BYTES } from '../server/files.mjs';

const ORIGIN = 'https://company.example';
const INITIAL_HASH = await hashPassword('Only an isolated file test password');
async function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  await initializeAuthSchema(db);
  const env = { DB: db, SITE_ORIGIN: ORIGIN, INITIAL_ADMIN_LOGIN: 'owner', INITIAL_ADMIN_PASSWORD_HASH: INITIAL_HASH, SEED_DEMO_DATA: true };
  await initializeLocalWorkspace(env);
  const stored = () => JSON.parse(db.sqlite.prepare("SELECT payload FROM workspace WHERE id = 'main'").get().payload);
  const edit = mutate => { const workspace = stored(); mutate(workspace); db.sqlite.prepare("UPDATE workspace SET payload = ?, revision = revision + 1 WHERE id = 'main'").run(JSON.stringify(workspace)); };
  const cookies = {};
  for (const userId of ['u-admin', 'u-engineer', 'u-qa', 'u-manager', 'u-ops']) {
    let account = stored().accounts.find(item => item.userId === userId);
    if (!account) {
      account = { id: `account-${userId}`, userId, login: `login-${userId}`, status: 'active' };
      edit(workspace => workspace.accounts.push(account));
      db.sqlite.prepare('INSERT INTO auth_credentials VALUES (?, ?, ?, 0, 1, ?)').run(account.id, account.login, INITIAL_HASH, new Date().toISOString());
    }
    const credential = db.sqlite.prepare('SELECT * FROM auth_credentials WHERE account_id = ?').get(account.id);
    cookies[userId] = (await issueSession(db, env, credential)).split(';')[0];
  }
  const request = (path, { user = 'u-engineer', method = 'GET', body, headers = {} } = {}) => {
    const outgoing = new Headers({ ...(user ? { Cookie: cookies[user] } : {}), ...(method !== 'GET' ? { Origin: ORIGIN } : {}), ...headers });
    if (body && !(body instanceof FormData) && !outgoing.has('Content-Type')) outgoing.set('Content-Type', 'application/json');
    return new Request(ORIGIN + path, { method, headers: outgoing, ...(body == null ? {} : { body: body instanceof FormData || typeof body === 'string' ? body : JSON.stringify(body) }) });
  };
  const call = async (path, options) => {
    const response = await handleHttpApi(request(path, options), env);
    const data = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
    return { status: response.status, headers: response.headers, data };
  };
  const form = ({ projectId = 'p-mower', entityType = 'task', entityId = 't-03', name = '测试报告.txt', content = '交付内容', type = 'text/plain' } = {}) => {
    const data = new FormData();
    data.set('projectId', projectId); data.set('entityType', entityType); data.set('entityId', entityId);
    data.set('file', new Blob([content], { type }), name);
    return data;
  };
  const upload = (values, user = 'u-engineer') => call('/api/files', { user, method: 'POST', body: form(values) });
  return { db, env, stored, edit, cookies, request, call, form, upload };
}

test('changing stage or child-task attachments clears only unfinished signatures on the affected stage', async t => {
  const f = await fixture(t);
  const signature = { as: 'owner', actorId: 'u-manager', at: new Date().toISOString() };
  const task = f.stored().state.tasks.find(item => item.id === 't-03');
  const stageId = task.milestoneId;
  const sign = () => f.edit(workspace => {
    const stage = workspace.state.milestones.find(item => item.id === stageId);
    stage.status = 'pending';
    stage.coReviewerId = 'u-admin';
    stage.signatures = [signature];
  });
  const currentSignatures = () => f.stored().state.milestones.find(item => item.id === stageId).signatures;
  sign();
  assert.equal((await f.upload({entityType:'milestone', entityId:'m-mower-1'})).status, 201);
  assert.deepEqual(currentSignatures(), [signature]);
  const upload = await f.upload({entityType:'task', entityId:task.id});
  assert.equal(upload.status, 201);
  assert.deepEqual(currentSignatures(), []);
  sign();
  assert.equal((await f.call('/api/files/' + upload.data.file.id, {method:'DELETE',body:{}})).status, 200);
  assert.deepEqual(currentSignatures(), []);
  assert.deepEqual(f.stored().state.logs[0].changes.signatures.before, [signature]);
});

test('files persist exact bytes, trusted uploader metadata and duplicate names under distinct node attachments', async t => {
  const f = await fixture(t), before = f.stored();
  const bytes = Uint8Array.from([0, 255, 128, 2, 3]);
  const first = await f.upload({ content: bytes, name: '交付 "方案".html', type: 'text/html' });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.file.uploadedBy, 'u-engineer');
  assert.equal(first.data.file.uploaderName, before.state.users.find(user => user.id === 'u-engineer').name);
  assert.equal(first.data.file.size, bytes.byteLength);
  assert.equal(first.data.file.canDelete, true);
  assert.ok(Date.parse(first.data.file.uploadedAt) <= Date.now());
  const second = await f.upload({ name: first.data.file.name });
  assert.equal(second.status, 201);
  assert.notEqual(second.data.file.id, first.data.file.id);
  const milestone = await f.upload({ entityType: 'milestone', entityId: 'm-mower-2', name: '阶段说明.docx' });
  assert.equal(milestone.status, 201);
  const all = await f.call('/api/files?projectId=p-mower');
  assert.equal(all.data.files.length, 3);
  assert.equal(all.data.maxFileBytes, MAX_FILE_BYTES);
  const node = await f.call('/api/files?projectId=p-mower&entityType=milestone&entityId=m-mower-2');
  assert.deepEqual(node.data.files.map(item => item.id), [milestone.data.file.id]);
  assert.equal(JSON.stringify(all.data).includes('content'), false);
  const downloaded = await f.call(`/api/files/${first.data.file.id}/download`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.data, bytes);
  assert.equal(downloaded.headers.get('Content-Type'), 'application/octet-stream');
  assert.match(downloaded.headers.get('Content-Disposition'), /^attachment; filename="download"; filename\*=UTF-8''/);
  assert.match(downloaded.headers.get('Content-Security-Policy'), /sandbox/);
  assert.equal(downloaded.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(downloaded.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(f.stored(), before, 'files must not overwrite project/task state');
});

test('project scope protects file lists, direct download, upload, and delete after membership is revoked', async t => {
  const f = await fixture(t);
  const secret = await f.upload({ projectId: 'p-site', entityId: 't-13', name: '其他项目的机密.txt' }, 'u-admin');
  assert.equal(secret.status, 201);
  assert.equal((await f.call('/api/files?projectId=p-site')).status, 404);
  assert.equal((await f.call(`/api/files/${secret.data.file.id}/download`)).status, 404);
  assert.equal((await f.upload({ projectId: 'p-site', entityId: 't-13' })).status, 404);
  assert.equal((await f.call(`/api/files/${secret.data.file.id}`, { method: 'DELETE', body: {} })).status, 404);
  const own = await f.upload();
  f.edit(workspace => { const project = workspace.state.projects.find(item => item.id === 'p-mower'); project.memberIds = project.memberIds.filter(id => id !== 'u-engineer'); });
  for (const path of ['/api/files?projectId=p-mower', `/api/files/${own.data.file.id}/download`]) assert.equal((await f.call(path)).status, 404);
  assert.equal((await f.call(`/api/files/${own.data.file.id}`, { method: 'DELETE', body: {} })).status, 404);
  assert.equal((await f.upload()).status, 404);
  assert.equal((await f.call(`/api/files/${own.data.file.id}/download`, { user: 'u-admin' })).status, 200);
});

test('only uploader, project owner and administrator may remove a file; removal does not remove its task', async t => {
  const f = await fixture(t);
  for (const remover of ['u-engineer', 'u-manager', 'u-admin']) {
    const upload = await f.upload(), id = upload.data.file.id;
    const peerList = await f.call('/api/files?projectId=p-mower', { user: 'u-qa' });
    assert.equal(peerList.data.files.find(item => item.id === id).canDelete, false);
    assert.equal((await f.call(`/api/files/${id}`, { user: 'u-qa', method: 'DELETE', body: {} })).status, 403);
    assert.equal((await f.call(`/api/files/${id}/download`, { user: 'u-qa' })).status, 200);
    assert.equal((await f.call(`/api/files/${id}`, { user: remover, method: 'DELETE', body: {} })).status, 200);
    assert.equal((await f.call(`/api/files/${id}/download`)).status, 404);
  }
  assert.ok(f.stored().state.tasks.some(item => item.id === 't-03'));
});

test('uploads validate target linkage, size, required file and same-origin access', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload({ entityId: 't-13' })).status, 404);
  assert.equal((await f.upload({ entityType: 'project' })).status, 400);
  assert.equal((await f.upload({ entityId: '' })).status, 400);
  assert.equal((await f.upload({ content: '' })).status, 400);
  assert.equal((await f.upload({ name: 'x'.repeat(181) })).status, 400);
  assert.equal((await f.upload({ content: new Uint8Array(MAX_FILE_BYTES + 1) })).status, 413);
  const multiple = f.form(); multiple.append('file', new Blob(['second']), 'second.txt');
  assert.equal((await f.call('/api/files', { method: 'POST', body: multiple })).status, 400);
  assert.equal((await f.call('/api/files', { method: 'POST', body: f.form(), headers: { Origin: 'https://wrong.example' } })).status, 403);
  assert.equal((await f.call('/api/files', { method: 'POST', body: {}, headers: { 'Content-Type': 'application/json' } })).status, 415);
  assert.equal((await f.call('/api/files', { method: 'POST', body: f.form(), headers: { 'Content-Length': String(MAX_FILE_REQUEST_BYTES + 1) } })).status, 413);
  const wrongTarget = await f.call('/api/files?projectId=p-mower&entityType=task&entityId=t-13');
  assert.equal(wrongTarget.status, 404);
  assert.equal((await f.call('/api/files')).status, 400);
  assert.equal((await f.call('/api/files?projectId=p-mower')).data.files.length, 0);
});

test('file routes require a valid active account and completed first password change', async t => {
  const f = await fixture(t), upload = await f.upload();
  for (const path of ['/api/files?projectId=p-mower', `/api/files/${upload.data.file.id}/download`]) assert.equal((await f.call(path, { user: null, headers: { 'x-user-role': 'admin' } })).status, 401);
  const account = f.stored().accounts.find(item => item.userId === 'u-engineer');
  f.db.sqlite.prepare('UPDATE auth_credentials SET must_change = 1 WHERE account_id = ?').run(account.id);
  assert.equal((await f.call('/api/files?projectId=p-mower')).data.code, 'PASSWORD_CHANGE_REQUIRED');
  f.db.sqlite.prepare('UPDATE auth_credentials SET must_change = 0 WHERE account_id = ?').run(account.id);
  f.edit(workspace => { workspace.accounts.find(item => item.id === account.id).status = 'disabled'; });
  assert.equal((await f.call(`/api/files/${upload.data.file.id}/download`)).status, 401);
  assert.equal((await f.upload()).status, 401);
});

test('slow uploads recheck current membership after body reception and atomic writes reject a concurrent revocation', async t => {
  const f = await fixture(t);
  const source = f.request('/api/files', { method: 'POST', body: f.form() });
  const raw = new Uint8Array(await source.arrayBuffer());
  let reads = 0;
  const stream = new ReadableStream({ pull(controller) {
    if (reads++ === 0) { controller.enqueue(raw.slice(0, 32)); return; }
    f.edit(workspace => { workspace.state.projects.find(item => item.id === 'p-mower').memberIds = ['u-manager']; });
    controller.enqueue(raw.slice(32)); controller.close();
  } });
  const request = new Request(source.url, { method: 'POST', headers: source.headers, body: stream, duplex: 'half' });
  const response = await handleHttpApi(request, f.env);
  assert.equal(response.status, 404);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) count FROM project_files').get().count, 0);
  f.edit(workspace => { workspace.state.projects.find(item => item.id === 'p-mower').memberIds.push('u-engineer'); });
  const originalPrepare = f.db.prepare;
  f.db.prepare = function(sql) {
    if (sql.startsWith('INSERT INTO project_files')) f.edit(workspace => { workspace.state.projects.find(item => item.id === 'p-mower').memberIds = ['u-manager']; });
    return originalPrepare.call(this, sql);
  };
  const conflict = await f.upload();
  assert.equal(conflict.status, 409);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) count FROM project_files').get().count, 0);
});

test('SQLite full backup preserves account credentials, project state and exact file bytes together', async t => {
  const f = await fixture(t), bytes = Buffer.from('包含真实文件内容的备份测试');
  const upload = await f.upload({ content: bytes });
  const folder = await mkdtemp(join(tmpdir(), 'dinfon-files-backup-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const filename = join(folder, 'snapshot.sqlite');
  await backup(f.db.sqlite, filename);
  const restored = new DatabaseSync(filename, { readOnly: true });
  try {
    const file = restored.prepare('SELECT content, uploaded_by FROM project_files WHERE id = ?').get(upload.data.file.id);
    assert.deepEqual(Buffer.from(file.content), bytes);
    assert.equal(file.uploaded_by, 'u-engineer');
    assert.deepEqual(JSON.parse(restored.prepare("SELECT payload FROM workspace WHERE id = 'main'").get().payload), f.stored());
    assert.equal(restored.prepare('SELECT count(*) count FROM auth_credentials').get().count, 5);
    assert.equal(restored.prepare('SELECT count(*) count FROM auth_sessions').get().count, 5);
  } finally { restored.close(); }
});

test('uploads cannot leave orphaned files when their task is deleted immediately before the final write', async t => {
  const f = await fixture(t), originalPrepare = f.db.prepare;
  f.db.prepare = function(sql) {
    if (sql.startsWith('INSERT INTO project_files')) f.edit(workspace => { workspace.state.tasks = workspace.state.tasks.filter(task => task.id !== 't-03'); });
    return originalPrepare.call(this, sql);
  };
  const result = await f.upload({ entityId: 't-03' });
  assert.equal(result.status, 409);
  assert.equal(f.db.sqlite.prepare('SELECT count(*) count FROM project_files').get().count, 0);
});


test('milestone file summaries include direct and current child task attachments without changing legacy files', async t => {
  const f = await fixture(t);
  const directBytes = Uint8Array.from([21, 0, 255, 11]);
  const childBytes = Uint8Array.from([0, 1, 128, 254, 255]);
  const direct = await f.upload({ entityType: 'milestone', entityId: 'm-mower-2', name: '阶段交付.docx', content: directBytes });
  const child = await f.upload({ entityId: 't-03', name: '历史任务附件.bin', content: childBytes });
  const otherChild = await f.upload({ entityId: 't-02', name: '另一子任务.txt' });
  const otherMilestone = await f.upload({ entityType: 'milestone', entityId: 'm-mower-3', name: '另一阶段.txt' });
  const otherTask = await f.upload({ entityId: 't-05', name: '其他阶段任务.txt' });
  // Even a stale cross-project milestone reference cannot pull in another project's file.
  f.edit(workspace => { workspace.state.tasks.find(task => task.id === 't-07').milestoneId = 'm-mower-2'; });
  const otherProject = await f.upload({ projectId: 'p-pcb', entityId: 't-07', name: '其他项目.txt' });
  for (const result of [direct, child, otherChild, otherMilestone, otherTask, otherProject]) assert.equal(result.status, 201, JSON.stringify(result.data));
  const base = '/api/files?projectId=p-mower&entityType=milestone&entityId=m-mower-2';
  const original = await f.call(base);
  assert.deepEqual(original.data.files, [direct.data.file], 'ordinary milestone lists remain direct-only');
  const grouped = await f.call(base + '&includeTaskFiles=true');
  assert.equal(grouped.status, 200);
  const expected = [direct.data.file, child.data.file, otherChild.data.file].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(grouped.data.files.toSorted((a, b) => a.id.localeCompare(b.id)), expected);
  assert.equal(grouped.data.maxFileBytes, MAX_FILE_BYTES);
  for (const omitted of [otherMilestone, otherTask, otherProject]) assert.equal(grouped.data.files.some(file => file.id === omitted.data.file.id), false);
  assert.deepEqual((await f.call(`/api/files/${direct.data.file.id}/download`)).data, directBytes);
  assert.deepEqual((await f.call(`/api/files/${child.data.file.id}/download`)).data, childBytes);
  const taskList = await f.call('/api/files?projectId=p-mower&entityType=task&entityId=t-03');
  assert.deepEqual(taskList.data.files, [child.data.file], 'child metadata and task-specific lists stay intact');
  const tableBefore = f.db.sqlite.prepare('SELECT id, entity_type, entity_id, name, sha256, content FROM project_files ORDER BY id').all();
  f.edit(workspace => { workspace.state.tasks.find(task => task.id === 't-03').milestoneId = 'm-mower-3'; });
  const moved = await f.call(base + '&includeTaskFiles=true');
  assert.deepEqual(moved.data.files.map(file => file.id).sort(), [direct.data.file.id, otherChild.data.file.id].sort());
  const destination = await f.call('/api/files?projectId=p-mower&entityType=milestone&entityId=m-mower-3&includeTaskFiles=true');
  assert.deepEqual(destination.data.files.map(file => file.id).sort(), [otherMilestone.data.file.id, otherTask.data.file.id, child.data.file.id].sort());
  assert.deepEqual(f.db.sqlite.prepare('SELECT id, entity_type, entity_id, name, sha256, content FROM project_files ORDER BY id').all(), tableBefore, 'grouping must not rewrite existing attachment records or bytes');
});

test('milestone file summaries verify project scope and a real milestone before resolving children', async t => {
  const f = await fixture(t);
  const uploaded = await f.upload({ entityType: 'milestone', entityId: 'm-mower-2' });
  assert.equal(uploaded.status, 201);
  const invalid = await f.call('/api/files?projectId=p-mower&entityType=milestone&entityId=m-site-3&includeTaskFiles=true');
  assert.equal(invalid.status, 404);
  assert.equal((await f.call('/api/files?projectId=p-site&entityType=milestone&entityId=m-site-3&includeTaskFiles=true')).status, 404);
  assert.equal((await f.call('/api/files?projectId=p-mower&includeTaskFiles=true')).status, 400);
  assert.equal((await f.call('/api/files?projectId=p-mower&entityType=task&entityId=t-03&includeTaskFiles=true')).status, 400);
  const query = new URLSearchParams({ projectId: 'p-mower', entityType: 'milestone', entityId: "m-mower-2' OR 1=1 --", includeTaskFiles: 'true' });
  assert.equal((await f.call('/api/files?' + query)).status, 404);
  f.edit(workspace => { workspace.state.tasks = workspace.state.tasks.filter(task => task.milestoneId !== 'm-mower-2'); });
  const emptyChildren = await f.call('/api/files?projectId=p-mower&entityType=milestone&entityId=m-mower-2&includeTaskFiles=true');
  assert.deepEqual(emptyChildren.data.files, [uploaded.data.file]);
});

test('flow badge counts are project-scoped, group direct attachments and update after deletion',async t=>{
  const f=await fixture(t);
  const one=await f.upload({entityType:'task',entityId:'t-03'});
  await f.upload({entityType:'task',entityId:'t-03'});
  await f.upload({entityType:'milestone',entityId:'m-mower-2'});
  const path='/api/files?projectId=p-mower&summary=counts';
  assert.equal((await f.call(path,{user:'u-ops'})).status,404);
  const counts=(await f.call(path)).data.counts;
  assert.deepEqual(counts,[{type:'milestone',id:'m-mower-2',total:1},{type:'task',id:'t-03',total:2}]);
  assert.equal((await f.call('/api/files/'+one.data.file.id,{method:'DELETE',body:{}})).status,200);
  assert.equal((await f.call(path)).data.counts.find(r=>r.type==='task').total,1);
});
