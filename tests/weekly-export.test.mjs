import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyReport, createWeeklyExport } from '../public/client/weekly-export.js';

const range = { start: '2026-11-02', end: '2026-11-08' };
const now = Date.parse('2026-11-04T02:00:00Z');
function fixture() {
  return {
    version: 1,
    users: [{ id: 'admin', name: '管理员', role: 'admin' }, { id: 'member', name: '工程师', role: 'member' }, { id: 'other', name: '其他员工', role: 'member' }],
    projects: [{ id: 'p1', name: '样机项目', ownerId: 'admin', memberIds: ['member'], dueDate: '2026-12-01T18:00' }, { id: 'p2', name: '保密项目', ownerId: 'admin', memberIds: ['other'], dueDate: '2026-12-02T18:00' }],
    tasks: [
      { id: 't1', projectId: 'p1', milestoneId: 'm1', title: '=1+2 <任务> & "验收"', ownerId: 'member', status: 'done', dueDate: '2026-11-02T09:00', submittedAt: '2026-11-01T17:00:00Z', reviewedAt: '2026-11-02T03:00:00Z', deliverable: '成果一\n成果二' },
      { id: 't2', projectId: 'p1', milestoneId: 'm1', title: '待验收任务', ownerId: 'member', status: 'review', dueDate: '2026-11-03T15:00', submittedAt: '2026-11-03T06:00:00Z' },
      { id: 't3', projectId: 'p1', milestoneId: 'm1', title: '周日边界', ownerId: 'member', status: 'todo', dueDate: '2026-11-08T15:59:00Z' },
      { id: 't4', projectId: 'p1', title: '下周边界', ownerId: 'member', status: 'todo', dueDate: '2026-11-08T16:00:00Z' },
      { id: 't5', projectId: 'p2', title: '保密任务', ownerId: 'other', status: 'doing', dueDate: '2026-11-03T15:00' },
    ],
    milestones: [{ id: 'm1', projectId: 'p1', title: '本周大节点', status: 'pending', dueDate: '2026-11-08T23:00' }, { id: 'm2', projectId: 'p2', title: '保密节点', status: 'pending', dueDate: '2026-11-08T23:00' }],
    extensions: [], logs: [], milestoneRequests: [],
  };
}
const report = (actorId = 'member') => buildWeeklyReport(fixture(), { actorId, range, now });
function entries(bytes) {
  const buffer = Buffer.from(bytes), files = new Map(); let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(offset + 8), 0, 'entries use the standard stored ZIP method');
    const size = buffer.readUInt32LE(offset + 18), nameSize = buffer.readUInt16LE(offset + 26), extraSize = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    const start = offset + 30 + nameSize + extraSize;
    files.set(name, buffer.subarray(start, start + size).toString('utf8'));
    offset = start + size;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'archive has a central directory');
  assert.equal(buffer.readUInt32LE(buffer.length - 22), 0x06054b50, 'archive has an end record');
  assert.equal(buffer.readUInt16LE(buffer.length - 12), files.size);
  return files;
}

test('weekly report uses selected Shanghai due-date boundaries and accepted task progress', () => {
  const output = report();
  assert.deepEqual(output.tables[0].rows, [['本周到期任务', 3], ['已验收完成', 1], ['未完成任务', 2], ['逾期任务', 1], ['本周大节点', 1], ['已达成大节点', 0]]);
  assert.equal(output.tables[1].rows[0][4], 0.25, 'pending milestone does not suppress completed tasks');
  assert.equal(output.tables[2].rows.length, 3);
  assert.equal(output.tables[2].rows[0][5], '2026.11.02 01:00');
  assert.equal(output.tables[2].rows[2][4], '2026.11.08 23:59');
  assert.equal(output.tables[4].rows[0][0], '下周边界');
  assert.equal(output.tables[4].rows[0][4], '2026.11.09 00:00');
  assert.equal(output.generatedAt, '2026.11.04 10:00');
});

test('employee report excludes other project data, while admins include all visible projects', () => {
  const employee = report();
  assert.equal(employee.scope, '工程师参与的项目');
  assert.ok(!JSON.stringify(employee).includes('保密'));
  assert.equal(report('admin').tables[1].rows.length, 2);
  assert.equal(report('admin').tables[0].rows[0][1], 4);
  assert.throws(() => report('missing'), /账号不存在/);
});

test('report rejects nonweekly ranges, invalid dates and invalid generated time', () => {
  for (const bad of [{ start: '2026-11-08', end: '2026-11-02' }, { start: '2026-02-30', end: '2026-03-08' }, { start: '2026-11-02', end: '2026-11-07' }]) assert.throws(() => buildWeeklyReport(fixture(), { actorId: 'admin', range: bad, now }));
  assert.throws(() => buildWeeklyReport(fixture(), { actorId: 'admin', range, now: NaN }), /导出时间/);
});

test('empty accessible project set exports useful zero summaries and no inaccessible rows', () => {
  const state = fixture(); state.users.push({ id: 'empty', name: '新员工', role: 'member' });
  const output = buildWeeklyReport(state, { actorId: 'empty', range, now });
  assert.ok(output.tables[0].rows.every(row => row[1] === 0));
  assert.ok(output.tables.slice(1).every(table => table.rows.length === 0));
  assert.match(entries(createWeeklyExport(output, 'xlsx').bytes).get('xl/worksheets/sheet3.xml'), /暂无记录/);
  assert.match(entries(createWeeklyExport(output, 'docx').bytes).get('word/document.xml'), /暂无记录/);
  state.projects.push({ id: 'empty-project', name: '新项目', ownerId: 'admin', memberIds: ['empty'], dueDate: '2026-11-08T18:00' });
  const withEmptyProject = buildWeeklyReport(state, { actorId: 'empty', range, now });
  assert.equal(withEmptyProject.tables[1].rows[0][4], '—', 'projects without tasks have no completion rate');
});

test('xlsx is a ZIP OOXML workbook with numeric percentages and safely escaped literal user text', () => {
  const output = createWeeklyExport(report(), 'xlsx'), files = entries(output.bytes);
  assert.equal(output.filename, '鼎峰周报_2026-11-02_2026-11-08.xlsx');
  assert.equal(output.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(files.get('[Content_Types].xml'), /spreadsheetml\.sheet\.main\+xml/);
  assert.equal((files.get('xl/workbook.xml').match(/<sheet /g) || []).length, 5);
  assert.match(files.get('xl/worksheets/sheet2.xml'), /<c r="E6" s="3"><v>0.25<\/v><\/c>/);
  assert.match(files.get('xl/worksheets/sheet3.xml'), /=1\+2 &lt;任务&gt; &amp; &quot;验收&quot;/);
  assert.doesNotMatch(files.get('xl/worksheets/sheet3.xml'), /<f[ >]/);
  assert.match(files.get('xl/worksheets/sheet3.xml'), /state="frozen"/);
  assert.match(files.get('xl/worksheets/sheet3.xml'), /<autoFilter/);
  assert.ok(![...files.values()].join('').includes('保密'));
});

test('docx has editable tables, repeated headers, landscape page, literal data and time columns', () => {
  const output = createWeeklyExport(report(), 'docx'), files = entries(output.bytes), document = files.get('word/document.xml');
  assert.equal(output.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(output.filename, /\.docx$/);
  assert.match(files.get('[Content_Types].xml'), /wordprocessingml\.document\.main\+xml/);
  assert.equal((document.match(/<w:tbl>/g) || []).length, 5);
  assert.equal((document.match(/<w:tblHeader\/>/g) || []).length, 5);
  assert.match(document, /w:orient="landscape"/);
  assert.match(document, /25%/);
  assert.match(document, /提交时间/);
  assert.match(document, /验收 \/ 审核时间/);
  assert.match(document, /2026\.11\.02 01:00/);
  assert.match(document, /<w:br\/>/);
  assert.ok(!document.includes('保密'));
});

test('export removes characters disallowed by XML while preserving Chinese and astral Unicode', () => {
  const state = fixture(); state.tasks[0].title = '测试\u0000\u000b😀<&>';
  const data = buildWeeklyReport(state, { actorId: 'member', range, now });
  for (const format of ['xlsx', 'docx']) {
    const raw = [...entries(createWeeklyExport(data, format).bytes).values()].join('');
    assert.match(raw, /测试😀&lt;&amp;&gt;/);
    assert.doesNotMatch(raw, /[\u0000\u000b]/);
  }
});

test('unsupported format is rejected and report/export do not mutate source state', () => {
  const state = fixture(), original = structuredClone(state);
  const data = buildWeeklyReport(state, { actorId: 'member', range, now });
  createWeeklyExport(data, 'xlsx'); createWeeklyExport(data, 'docx');
  assert.deepEqual(state, original);
  assert.throws(() => createWeeklyExport(data, 'pdf'), /Excel 或 Word/);
});
