import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTeamAnalytics, teamAnalyticsData } from '../public/client/team-analytics.js';
import { deadlineMs } from '../public/client/time.js';

const range = { start: '2026-10-19', end: '2026-10-25' };
const now = deadlineMs('2026-10-22T12:00');
const people = [{ id: 'u1', name: '张明', department: '研发', title: '产品经理' }, { id: 'u2', name: '李青' }];
const task = (id, ownerId, status = 'todo', more = {}) => ({ id, ownerId, status, dueDate: '2026-10-22T10:00', submittedAt: null, reviewCount: 0, firstReviewPassed: null, ...more });
const data = (tasks, options = {}) => teamAnalyticsData({ tasks }, { people, range, now, ...options });

test('aggregate rings use task counts rather than averaging member percentages', () => {
  const result = data([
    task('one', 'u1', 'done', { submittedAt: '2026-10-22T09:00', reviewCount: 1, firstReviewPassed: true }),
    task('two', 'u2'), task('three', 'u2'), task('four', 'u2'),
  ]);
  assert.equal(result.total, 4);
  assert.equal(result.completed, 1);
  assert.equal(result.completionRate, 25);
  assert.equal(result.onTimeRate, 25);
  assert.equal(result.members[0].stats.completionRate, 100);
  assert.equal(result.members[1].stats.completionRate, 0);
  assert.equal(result.members[0].stats.firstPassRate, 100);
});

test('selected-week cohort retains future tasks and counts timely submissions awaiting acceptance', () => {
  const result = data([
    task('waiting', 'u1', 'review', { submittedAt: '2026-10-22T09:00' }),
    task('future', 'u1', 'doing', { dueDate: '2026-10-25T18:00' }),
    task('previous', 'u1', 'todo', { dueDate: '2026-10-18T18:00' }),
    task('next', 'u1', 'done', { dueDate: '2026-10-26T18:00' }),
  ]);
  assert.equal(result.total, 2);
  assert.equal(result.completionRate, 0);
  assert.equal(result.onTimeRate, 50);
  assert.deepEqual(result.members[0].stats, { due: 2, completed: 0, onTime: 1, firstReviewed: 0, firstPassed: 0, completionRate: 0, onTimeRate: 50, firstPassRate: null });
  assert.equal(result.members[0].pending, 3);
  assert.equal(result.members[0].review, 1);
  assert.equal(result.members[0].overdue, 2);
  assert.deepEqual(result.distribution.map(status => status.count), [0, 1, 1, 0]);
});

test('Shanghai week edges and exact-hour deadlines preserve existing shared time semantics', () => {
  const result = data([
    task('before-week', 'u1', 'todo', { dueDate: '2026-10-18T15:59:59.999Z' }),
    task('start-week', 'u1', 'todo', { dueDate: '2026-10-18T16:00:00Z' }),
    task('end-week', 'u1', 'todo', { dueDate: '2026-10-25T15:59:59.999Z' }),
    task('legacy-sunday', 'u1', 'todo', { dueDate: '2026-10-25' }),
    task('next-week', 'u1', 'todo', { dueDate: '2026-10-25T16:00:00Z' }),
    task('exact-hour', 'u1', 'review', { dueDate: '2026-10-22T12:00', submittedAt: '2026-10-22T04:00:00Z' }),
    task('late', 'u1', 'review', { dueDate: '2026-10-22T11:00', submittedAt: '2026-10-22T03:00:00.001Z' }),
    task('bad-date', 'u1', 'todo', { dueDate: '2026-02-30' }),
  ]);
  assert.equal(result.total, 5);
  assert.equal(result.onTime, 1);
  assert.equal(result.members[0].overdue, 3);
});

test('current workload includes carryover and future tasks and does not disappear when switching weeks', () => {
  const tasks = [
    task('carryover', 'u1', 'doing', { dueDate: '2026-10-18T18:00' }),
    task('current-review', 'u1', 'review'),
    task('future-work', 'u1', 'todo', { dueDate: '2026-10-27T18:00' }),
    task('accepted', 'u1', 'done'),
    task('invisible-owner', 'hidden', 'todo'),
  ];
  for (const selected of [range, { start: '2026-10-26', end: '2026-11-01' }]) {
    const result = data(tasks, { range: selected });
    assert.equal(result.members[0].pending, 3);
    assert.equal(result.members[0].review, 1);
    assert.equal(result.members[0].overdue, 2);
  }
  assert.equal(data(tasks).total, 2);
  assert.equal(data(tasks, { range: { start: '2026-10-26', end: '2026-11-01' } }).total, 1);
});

test('people scope, stable task-first grouping, duplicates, and approved date changes are respected without mutation', () => {
  const scopedState = { tasks: [
    task('visible', 'u1', 'done'),
    task('hidden-owner', 'hidden', 'done'),
    task('rescheduled', 'u1', 'todo', { originalDueDate: '2026-10-21T18:00', dueDate: '2026-10-26T18:00' }),
  ] };
  const before = structuredClone(scopedState);
  const result = teamAnalyticsData(scopedState, { people: [people[1], people[0], people[0]], range, now });
  assert.deepEqual(result.members.map(member => member.user.id), ['u1', 'u2']);
  assert.equal(result.total, 1);
  assert.equal(result.completionRate, 100);
  assert.deepEqual(scopedState, before);
  assert.equal(data(scopedState.tasks, { people: [] }).total, 0);
});

test('members with plans appear first in source order and empty members retain compact current workload', () => {
  const orderedPeople = [
    { id: 'empty-first', name: '无计划甲' },
    { id: 'low-rate', name: '计划甲' },
    { id: 'empty-second', name: '无计划乙' },
    { id: 'high-rate', name: '计划乙' },
  ];
  const input = { tasks: [
    task('open', 'low-rate'),
    task('done', 'high-rate', 'done'),
    task('carryover', 'empty-first', 'review', { dueDate: '2026-10-18T18:00' }),
  ] };
  const result = teamAnalyticsData(input, { people: orderedPeople, range, now });
  assert.deepEqual(result.members.map(member => member.user.id), ['low-rate', 'high-rate', 'empty-first', 'empty-second']);
  const html = renderTeamAnalytics(input, { people: orderedPeople, range, now });
  const emptyRows = html.match(/<article class="team-member-row is-empty-week">[\s\S]*?<\/article>/g);
  assert.equal(emptyRows.length, 2);
  assert.doesNotMatch(emptyRows.join(''), /team-bar-track/);
  assert.match(emptyRows[0], /所选周暂无计划任务/);
  assert.match(emptyRows[0], /当前待办 · 不限周/);
  assert.match(emptyRows[0], /待验收<\/dt><dd>1/);
});

test('empty denominators remain unavailable and rendering exposes no false zero rates', () => {
  const result = data([]);
  assert.equal(result.completionRate, null);
  assert.equal(result.onTimeRate, null);
  assert.equal(result.members[0].stats.firstPassRate, null);
  const html = renderTeamAnalytics({ tasks: [] }, { people, range, now });
  assert.match(html, /team-summary-value">—/);
  assert.match(html, /暂无任务/);
  assert.doesNotMatch(html, />0%/);
  const empty = renderTeamAnalytics({ tasks: [] }, { people: [], range, now });
  assert.match(empty, /暂无可查看的团队成员/);
});

test('renderer escapes member content and communicates chart values independently of color', () => {
  const html = renderTeamAnalytics({ tasks: [task('done', 'u1', 'done', { submittedAt: '2026-10-22T09:00' }), task('open', 'u1')] }, {
    people: [{ id: 'u1', name: '<img src=x onerror=alert(1)>', department: '研发 & "技术"', title: '<script>bad</script>' }], range, now,
  });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/);
  assert.match(html, /研发 &amp; &quot;技术&quot;/);
  assert.match(html, /任务完成率/);
  assert.match(html, /按时交付率/);
  assert.match(html, /<strong>50%<\/strong><small>1 \/ 2 项/);
  assert.match(html, /已完成<\/dt><dd>1/);
  assert.match(html, /待开始<\/dt><dd>1/);
  assert.match(html, /<summary>了解统计口径<\/summary>/);
});
