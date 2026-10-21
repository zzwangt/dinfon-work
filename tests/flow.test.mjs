import test from 'node:test';
import assert from 'node:assert/strict';
import { today, addDays, weekRange, createSeedState } from '../dist/domain.js';
import { renderProjectFlow } from '../dist/flow.js';

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
