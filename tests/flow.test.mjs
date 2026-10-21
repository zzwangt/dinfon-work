import test from 'node:test';
import assert from 'node:assert/strict';
import { today, addDays, weekRange, createSeedState } from '../public/client/domain.js';
import { renderProjectFlow } from '../public/client/flow.js';

function renderMilestone(overrides = {}, canManage = false) {
  const state = createSeedState();
  const p = state.projects[0];
  const m = { ...state.milestones.find(m => m.projectId === p.id), status: 'pending', dueDate: today(), ...overrides };
  state.milestones = [m];
  state.tasks = state.tasks.filter(t => t.milestoneId === m.id);
  return renderProjectFlow(state, p, { canManage });
}

test('unfinished milestone due this week is explicitly required', () => {
  const html = renderMilestone({ dueDate: weekRange(today()).end });
  assert.match(html, /本周必须完成/);
  assert.match(html, /flow-required/);
});

test('unfinished milestones from earlier weeks remain visibly overdue', () => {
  const html = renderMilestone({ dueDate: addDays(weekRange(today()).start, -1) });
  assert.match(html, /已逾期 · 本周补齐/);
  assert.match(html, /此前逾期/);
  assert.match(html, /flow-required is-overdue/);
});

test('completed and future-week milestones are not marked required', () => {
  assert.doesNotMatch(renderMilestone({ status: 'done', dueDate: addDays(today(), -10) }), /flow-required/);
  assert.doesNotMatch(renderMilestone({ dueDate: addDays(weekRange(today()).end, 1) }), /flow-required/);
});

test('approved current deadline governs marking while original deadline is retained', () => {
  const html = renderMilestone({ originalDueDate: addDays(today(), -2), dueDate: addDays(weekRange(today()).end, 1) });
  assert.doesNotMatch(html, /flow-required/);
});

test('node text is escaped and read-only users receive no mutation controls', () => {
  const html = renderMilestone({ title: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img src/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /data-action="new-task"|data-action="complete-milestone"/);
});

function filterFixture() {
  const week = weekRange(today());
  const project = { id: 'p-filter', name: '筛选测试项目' };
  const milestone = (id, dueDate, status = 'pending') => ({ id, projectId: project.id, title: id, dueDate, weight: 1, status });
  const task = (id, milestoneId, ownerId, dueDate, status = 'todo') => ({ id, title: id, projectId: project.id, milestoneId, ownerId, dueDate, status });
  return {
    project,
    state: {
      users: [{ id: 'me', name: '本人' }, { id: 'other', name: '同事' }],
      milestones: [milestone('m-done', addDays(week.start, -1), 'done'), milestone('m-active', week.end), milestone('m-later', addDays(week.end, 7))],
      tasks: [
        task('old-done', 'm-done', 'me', addDays(week.start, -2), 'done'),
        task('old-open', 'm-active', 'me', addDays(week.start, -1), 'doing'),
        task('week-other', 'm-active', 'other', week.end),
        task('week-done', 'm-active', 'me', week.start, 'done'),
        task('future-mine', 'm-later', 'me', addDays(week.end, 1)),
        task('week-review', 'm-later', 'other', today(), 'review'),
        task('unassigned-mine', null, 'me', today()),
        { ...task('outside-project', 'm-active', 'me', today()), projectId: 'another-project' },
      ],
    },
  };
}

const visibleTaskIds = html => [...html.matchAll(/data-action="task-detail" data-id="([^"]+)"/g)].map(match => match[1]).sort();
const phaseCount = html => (html.match(/class="flow-phase flow-tone-/g) || []).length;

test('completed stages default to collapsed while unfinished stages retain their tasks', () => {
  const { state, project } = filterFixture();
  const html = renderProjectFlow(state, project, { actorId: 'me' });
  assert.equal(phaseCount(html), 3);
  assert.deepEqual(visibleTaskIds(html), ['future-mine', 'old-open', 'unassigned-mine', 'week-done', 'week-other', 'week-review']);
  assert.match(html, /显示 6 \/ 共 7 项任务/);
  assert.match(html, /已收起 1 项/);
  assert.match(html, /data-action="flow-toggle" data-id="m-done" aria-expanded="false"/);
  assert.doesNotMatch(html, /data-action="flow-toggle" data-id="m-active"/);
});

test('expandedIds explicitly restores completed-stage tasks without changing completion data', () => {
  const { state, project } = filterFixture();
  const before = structuredClone(state);
  const html = renderProjectFlow(state, project, { actorId: 'me', expandedIds: ['m-done'] });
  assert.equal(visibleTaskIds(html).length, 7);
  assert(visibleTaskIds(html).includes('old-done'));
  assert.match(html, /显示 7 \/ 共 7 项任务/);
  assert.match(html, /data-action="flow-toggle" data-id="m-done" aria-expanded="true"/);
  assert.deepEqual(state, before);
});

test('weekly focus includes this-week work and overdue unfinished work, retaining all phases', () => {
  const { state, project } = filterFixture();
  const html = renderProjectFlow(state, project, { actorId: 'me', scope: 'week', expandedIds: ['m-done'] });
  assert.deepEqual(visibleTaskIds(html), ['old-open', 'unassigned-mine', 'week-done', 'week-other', 'week-review']);
  assert.equal(phaseCount(html), 3);
  assert.match(html, /显示 5 \/ 共 7 项任务/);
  assert.match(html, /data-action="flow-filter" data-id="week" aria-pressed="true"/);
  assert.match(html, /本周待完成 <strong>1<\/strong> 个大节点/);
});

test('my-tasks filter scopes tasks and unassigned tasks to the supplied account', () => {
  const { state, project } = filterFixture();
  const mine = renderProjectFlow(state, project, { actorId: 'me', scope: 'mine' });
  const others = renderProjectFlow(state, project, { actorId: 'other', scope: 'mine' });
  assert.deepEqual(visibleTaskIds(mine), ['future-mine', 'old-open', 'unassigned-mine', 'week-done']);
  assert.deepEqual(visibleTaskIds(others), ['week-other', 'week-review']);
  assert.equal(phaseCount(mine), 3);
  assert.match(mine, /显示 4 \/ 共 7 项任务/);
  assert.match(mine, /<strong>1<\/strong> \/ 3 项已完成/);
  assert.match(mine, /本周待完成 <strong>1<\/strong> 个大节点/);
  assert.match(others, /没有符合当前筛选的任务/);
});

test('missing account never expands my-tasks scope to everybody', () => {
  const { state, project } = filterFixture();
  const html = renderProjectFlow(state, project, { scope: 'mine', expandedIds: ['m-done'] });
  assert.deepEqual(visibleTaskIds(html), []);
  assert.match(html, /data-id="mine" aria-pressed="true" disabled/);
  assert.match(html, /显示 0 \/ 共 7 项任务/);
});

test('unsupported scope falls back to all without interpolating supplied scope text', () => {
  const { state, project } = filterFixture();
  const html = renderProjectFlow(state, project, { scope: '<script>alert(1)</script>' });
  assert.match(html, /data-flow-scope="all"/);
  assert.doesNotMatch(html, /<script>/);
  assert.equal(visibleTaskIds(html).length, 6);
});

test('simplified canvas omits weight and blocked labels without changing stored tasks', () => {
  const { state, project } = filterFixture();
  const legacy = state.tasks.find(task => task.id === 'future-mine');
  legacy.status = 'blocked';
  const html = renderProjectFlow(state, project, { actorId: 'me' });
  assert.doesNotMatch(html, /权重|受阻|flow-tone-blocked|flow-color-legend/);
  assert.match(html, /class="flow-task flow-tone-doing"[^>]+data-id="future-mine"/);
  assert.match(html, /进行中/);
  assert.equal(legacy.status, 'blocked');
  assert.match(html, /data-flow-control="in"/);
  assert.match(html, /data-flow-control="out"/);
  assert.match(html, /data-flow-control="fit"/);
  assert.match(html, /阶段顺序/);
  assert.match(html, /所属任务/);
});

test('review and overdue remain explicit statuses after simplification', () => {
  const { state, project } = filterFixture();
  const html = renderProjectFlow(state, project, { actorId: 'me' });
  assert.match(html, /class="flow-task flow-tone-review"[^>]+data-id="week-review"/);
  assert.match(html, /待验收/);
  assert.match(html, /class="flow-task flow-tone-overdue"[^>]+data-id="old-open"/);
  assert.match(html, /已逾期/);
  assert.match(html, /本周必须完成/);
  assert.doesNotMatch(html, /待审核/);
});
