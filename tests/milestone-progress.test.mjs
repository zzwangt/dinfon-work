import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMilestoneProgress } from '../public/client/milestone-progress.js';

const now = Date.parse('2026-10-22T10:00:00+08:00');
const state = (milestones = [], tasks = []) => ({ projects: [{ id: 'p', name: '项目甲' }], milestones: milestones.map(item => ({ projectId: 'p', status: 'pending', ...item })), tasks: tasks.map(item => ({ projectId: 'p', ...item })) });
const node = (id, dueDate, other = {}) => ({ id, title: `节点${id}`, dueDate, ...other });
const render = data => renderMilestoneProgress(data, 'p', { now });

test('compact bars remain valid inside project links without nesting interactive buttons', () => {
  const html = renderMilestoneProgress(state([node('one', '2026-10-20', {status:'done'}),node('two','2026-10-28')]),'p',{now,compact:true});
  assert.doesNotMatch(html, /<button|data-action=|milestone-progress-scroll-hint/);
  assert.equal([...html.matchAll(/class="milestone-progress-dot"/g)].length, 2);
  assert.match(html, /title="大节点 2：节点two，未开始，截止 2026.10.28 全天，打开项目流程"/);
  assert.match(html, /role="progressbar"/);
});

test('empty approved plan displays a concise empty state', () => {
  const html = render({ ...state(), milestoneRequests: [{ proposed: node('pending', '2026-10-22') }] });
  assert.match(html, /暂无大节点/);
  assert.doesNotMatch(html, /role="progressbar"|data-action=/);
});

test('all formal milestones appear in deadline order and unrelated project nodes stay hidden', () => {
  const data = state([node('late', '2026-10-30T18:00'), node('same1', '2026-10-22T10:00'), node('first', '2026-10-19'), node('same2', '2026-10-22T02:00Z'), node('other', '2026-10-17', { projectId: 'another' })]);
  const html = render(data);
  assert.deepEqual([...html.matchAll(/data-id="(.*?)"/g)].map(match => match[1]), ['first', 'same1', 'same2', 'late']);
  assert.match(html, /--milestone-count:4/);
  assert.match(html, /aria-label="按截止顺序排列的大节点"/);
  assert.doesNotMatch(html, /节点other/);
});

test('aggregate progress retains the shared green completion and red schedule gap', () => {
  const html = render(state([node('one', '2026-10-20', { status: 'done' }), node('two', '2026-10-21'), node('three', '2026-10-28')]));
  assert.match(html, /schedule-progress-actual" style="width:33%"/);
  assert.match(html, /schedule-progress-lag" style="left:33%;width:34%"/);
  assert.match(html, /schedule-progress-marker" style="left:67%"/);
  assert.match(html, /aria-valuetext="实际 33%，计划 67%，落后 34%"/);
});

test('task-based track advances for accepted tasks without marking their milestone complete', () => {
  const data = state([node('stage', '2026-10-28')], [
    { id: 'accepted', milestoneId: 'stage', status: 'done', dueDate: '2026-10-20' },
    { id: 'review', milestoneId: 'stage', status: 'review', dueDate: '2026-10-21' },
    { id: 'unrelated', milestoneId: 'stage', status: 'done', projectId: 'other', dueDate: '2026-10-20' },
  ]);
  const html = renderMilestoneProgress(data, 'p', { now, basis: 'tasks' });
  assert.match(html, /aria-label="任务完成率"[^>]+aria-valuenow="50"/);
  assert.match(html, /schedule-progress-lag" style="left:50%;width:50%"/);
  assert.match(html, /data-id="stage"[^>]+aria-label="大节点 1：节点stage，进行中/);
  data.tasks[1].status = 'done';
  const completed = renderMilestoneProgress(data, 'p', { now, basis: 'tasks' });
  assert.match(completed, /aria-label="任务完成率"[^>]+aria-valuenow="100"/);
  assert.doesNotMatch(completed, /milestone-progress-step is-done/);
  assert.match(render(data), /aria-valuenow="0"/);
});

test('task-based track supports an empty plan without inventing milestone nodes or invalid rates', () => {
  const html = renderMilestoneProgress(state(), 'p', { now, basis: 'tasks' });
  assert.match(html, /aria-label="任务完成率"[^>]+aria-valuenow="0"/);
  assert.match(html, /暂无计划任务/);
  assert.doesNotMatch(html, /NaN|Infinity|milestone-progress-dot/);
});

test('out-of-order completion keeps each node state independent from the green bar', () => {
  const html = render(state([node('early', '2026-10-20'), node('later', '2026-10-29', { status: 'done' })]));
  assert.match(html, /schedule-progress-actual" style="width:50%"/);
  assert.match(html, /is-overdue"><button[^>]+data-id="early"[^>]+aria-label="大节点 1：节点early，已逾期/);
  assert.match(html, /is-done"><button[^>]+data-id="later"[^>]+aria-label="大节点 2：节点later，已完成/);
  assert.doesNotMatch(html, /class="schedule-progress-lag"/);
});

test('exact deadlines are not overdue; Shanghai Sunday is still this week', () => {
  const html = render(state([node('before', '2026-10-22T09:59'), node('exact', '2026-10-22T10:00'), node('sunday', '2026-10-25T15:00Z'), node('monday', '2026-10-25T16:00Z')]));
  assert.match(html, /节点before，已逾期/);
  assert.match(html, /节点exact，本周必达/);
  assert.match(html, /节点sunday，本周必达，截止 2026.10.25 23:00/);
  assert.match(html, /节点monday，未开始，截止 2026.10.26 00:00/);
});

test('historical day-only deadlines remain all-day and accepted nodes are always completed', () => {
  const html = render(state([node('today', '2026-10-22'), node('done', '2026-10-20', { status: 'done' })]));
  assert.match(html, /节点today，本周必达，截止 2026.10.22 全天/);
  assert.match(html, /节点done，已完成/);
  assert.match(html, /10\/22 全天/);
});

test('future nodes use only their own project tasks to identify activity', () => {
  const html = render(state([node('active', '2026-10-28'), node('idle', '2026-10-29')], [{ id: 't1', milestoneId: 'active', status: 'review' }, { id: 't2', milestoneId: 'idle', status: 'doing', projectId: 'other' }]));
  assert.match(html, /节点active，进行中/);
  assert.match(html, /节点idle，未开始/);
});

test('large plans retain every node and expose keyboard-operable buttons', () => {
  const html = render(state(Array.from({ length: 24 }, (_, index) => node(String(index), '2026-10-30', { title: '长名称'.repeat(20) }))));
  assert.equal([...html.matchAll(/type="button"/g)].length, 24);
  assert.equal([...html.matchAll(/data-action="milestone-detail"/g)].length, 24);
  assert.match(html, /--milestone-count:24/);
  assert.match(html, /大节点 24：/);
  assert.doesNotMatch(html, /\.\.\.|…/);
});

test('plans longer than two nodes expose a static narrow-screen scroll hint outside the canvas', () => {
  const milestones = [node('one', '2026-10-23'), node('two', '2026-10-24'), node('three', '2026-10-25')];
  assert.doesNotMatch(render(state(milestones.slice(0, 2))), /milestone-progress-scroll-hint/);
  const html = render(state(milestones));
  assert.match(html, /<\/ol><\/div><\/div><p class="milestone-progress-scroll-hint">左右滑动查看全部大节点<\/p>$/);
  assert.doesNotMatch(html, /aria-live|role="status"|tabindex="-1"/);
});

test('untrusted project, milestone titles, and IDs are escaped without markup injection', () => {
  const data = state([node('" onmouseover="bad', '2026-10-30', { title: '<img src=x onerror=bad>' })]);
  data.projects[0].name = '<svg onload=bad>';
  const html = render(data);
  assert.doesNotMatch(html, /<img|<svg onload|data-id="" onmouseover/);
  assert.match(html, /data-id="&quot; onmouseover=&quot;bad"/);
  assert.match(html, /&lt;img src=x onerror=bad&gt;/);
  assert.match(html, /&lt;svg onload=bad&gt;的大节点进度/);
});

test('rendering never changes the supplied state or order', () => {
  const data = state([node('later', '2026-10-30'), node('earlier', '2026-10-20')]);
  const original = structuredClone(data);
  for (const item of data.milestones) Object.freeze(item);
  Object.freeze(data.milestones);
  assert.doesNotThrow(() => render(data));
  assert.deepEqual(data, original);
});
