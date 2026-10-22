import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardData } from '../public/client/dashboard-data.js';
import { deadlineMs } from '../public/client/time.js';

const NOW = deadlineMs('2026-10-22T12:00');
const user = (id) => ({ id, name: id, role: 'member' });
const node = (id, dueDate, status = 'pending', projectId = 'p1') => ({ id, dueDate, status, projectId });
const task = (id, dueDate, status = 'todo', more = {}) => ({
  id, projectId: 'p1', milestoneId: 'm1', ownerId: 'u1', dueDate, status,
  submittedAt: null, reviewCount: 0, firstReviewPassed: null, ...more,
});
const state = (more = {}) => ({
  users: [user('u1'), user('u2')],
  projects: [{ id: 'p1', name: '项目一', ownerId: 'u1' }],
  milestones: [node('m1', '2026-10-23T18:00')], tasks: [], milestoneRequests: [], extensions: [], ...more,
});

test('people metrics share the due-to-now denominator while early submissions and future work stay outside it', () => {
  const input = state({ tasks: [
    task('accepted', '2026-10-20T10:00', 'done', { submittedAt: '2026-10-20T02:00:00Z', reviewedAt: '2026-10-21T03:00:00Z', reviewCount: 1, firstReviewPassed: true }),
    task('waiting', '2026-10-21T18:00', 'review', { submittedAt: '2026-10-21T09:00:00Z' }),
    task('future', '2026-10-23T18:00'),
    task('early', '2026-10-24T18:00', 'review', { submittedAt: '2026-10-22T01:00:00Z' }),
  ] });
  const before = structuredClone(input);
  const data = dashboardData(input, NOW);
  assert.deepEqual(input, before);
  assert.deepEqual(data.week, { start: '2026-10-19', end: '2026-10-25' });
  assert.equal(data.now, NOW);
  const person = data.people[0];
  assert.equal(person.weeklyTotal, 4);
  assert.equal(person.notDue, 2);
  assert.equal(person.pendingReview, 1);
  assert.deepEqual(person.stats, {
    due: 2, completed: 1, onTime: 2, firstReviewed: 1, firstPassed: 1,
    completionRate: 50, onTimeRate: 100, firstPassRate: 100,
  });
});

test('hour-level deadlines enter the denominator at their exact instant and latest submission determines timeliness', () => {
  const data = dashboardData(state({ tasks: [
    task('exact', '2026-10-22T12:00', 'review', { submittedAt: '2026-10-22T04:00:00Z' }),
    task('late', '2026-10-22T11:00', 'review', { submittedAt: '2026-10-22T03:00:00.001Z' }),
    task('future-hour', '2026-10-22T13:00'),
    task('legacy-today', '2026-10-22'),
  ] }), NOW);
  assert.equal(data.people[0].stats.due, 2);
  assert.equal(data.people[0].stats.onTime, 1);
  assert.equal(data.people[0].stats.onTimeRate, 50);
  assert.equal(data.people[0].stats.completionRate, 0);
  assert.equal(data.people[0].notDue, 2);
});

test('zero-task and future-only people keep their original order and have null rates', () => {
  const input = state({ users: [user('u2'), user('u1'), user('u3')], tasks: [task('future', '2026-10-24T18:00')] });
  const data = dashboardData(input, NOW);
  assert.deepEqual(data.people.map((entry) => entry.user.id), ['u2', 'u1', 'u3']);
  for (const person of data.people) {
    assert.equal(person.stats.due, 0);
    assert.equal(person.stats.completionRate, null);
    assert.equal(person.stats.onTimeRate, null);
  }
  assert.equal(data.people[1].weeklyTotal, 1);
  assert.equal(data.people[1].notDue, 1);
});

test('whole Sunday and UTC-to-Shanghai attribution belong to the correct weekly cohort', () => {
  const input = state({ tasks: [
    task('legacy-sunday', '2026-10-25'),
    task('sunday-hour', '2026-10-25T23:00'),
    task('sunday-utc', '2026-10-25T15:59:59.999Z'),
    task('monday-utc', '2026-10-25T16:00:00Z'),
    task('prior-week', '2026-10-18T23:59'),
  ] });
  const current = dashboardData(input, NOW).people[0];
  assert.equal(current.weeklyTotal, 3);
  assert.equal(current.notDue, 3);
  const sundayEnd = dashboardData(input, deadlineMs('2026-10-25')).people[0];
  assert.equal(sundayEnd.stats.due, 3);
  assert.equal(sundayEnd.notDue, 0);
  const monday = dashboardData(input, deadlineMs('2026-10-26T00:00'));
  assert.deepEqual(monday.week, { start: '2026-10-26', end: '2026-11-01' });
  assert.equal(monday.people[0].weeklyTotal, 1);
  assert.equal(monday.people[0].stats.due, 1);
});

test('required nodes include historical carryover and all of this week but exclude completed and next-week nodes', () => {
  const input = state({ milestones: [
    node('sunday', '2026-10-25'), node('carryover', '2026-10-18T18:00'),
    node('finished', '2026-10-20T18:00', 'done'), node('next-week', '2026-10-25T16:00:00Z'),
    node('late-week', '2026-10-21T18:00'), node('upcoming', '2026-10-23T18:00'),
  ] });
  const data = dashboardData(input, NOW);
  assert.deepEqual(data.required.map((entry) => entry.milestone.id), ['carryover', 'late-week', 'upcoming', 'sunday']);
  assert.deepEqual(data.required.map((entry) => entry.carryover), [true, false, false, false]);
  assert.deepEqual(data.required.map((entry) => entry.overdue), [true, true, false, false]);
  assert.equal(data.required[0].project.id, 'p1');
  assert.equal(data.required[0].owner.id, 'u1');
});

test('node child counts require both matching project and milestone', () => {
  const data = dashboardData(state({ tasks: [
    task('accepted', '2026-10-22T10:00', 'done'),
    task('waiting', '2026-10-22T10:00', 'review'),
    task('unrelated-node', '2026-10-22T10:00', 'done', { milestoneId: 'm2' }),
    task('unrelated-project', '2026-10-22T10:00', 'done', { projectId: 'other' }),
  ] }), NOW);
  assert.equal(data.required[0].completedTasks, 1);
  assert.equal(data.required[0].totalTasks, 2);
  assert.equal(data.people[0].weeklyTotal, 3);
});

test('only formal plans contribute, current approved deadlines override old baselines, and projects keep input order', () => {
  const input = state({
    projects: [{ id: 'p2', ownerId: 'missing' }, { id: 'p1', ownerId: 'u1' }],
    milestones: [node('future', '2026-10-27T18:00'), node('done', '2026-10-20T18:00', 'done'), node('late', '2026-10-21T18:00')],
    milestoneRequests: [{ id: 'request', projectId: 'p1', kind: 'create', status: 'pending', proposed: { title: '未批准', dueDate: '2026-10-20T18:00' } }],
    extensions: [{ projectId: 'p1', status: 'pending', newDueDate: '2026-10-28T18:00', affectedMilestones: [{ id: 'late', newDueDate: '2026-10-28T18:00' }] }],
    tasks: [task('moved', '2026-10-27T18:00', 'todo', { originalDueDate: '2026-10-20T18:00' })],
  });
  input.milestones[0].originalDueDate = '2026-10-20T18:00';
  const before = structuredClone(input);
  const data = dashboardData(input, NOW);
  assert.deepEqual(data.projects.map((entry) => entry.project.id), ['p2', 'p1']);
  assert.equal(data.projects[0].owner, null);
  assert.equal(data.projects[0].metrics.actual, 0);
  assert.deepEqual(data.projects[1].milestones.map((entry) => entry.id), ['done', 'late', 'future']);
  assert.deepEqual(data.projects[1].metrics, { actual: 33, planned: 67, lag: 34, total: 3, completed: 1, due: 2, overdueCount: 1 });
  assert.deepEqual(data.required.map((entry) => entry.milestone.id), ['late']);
  assert.equal(data.people[0].weeklyTotal, 0);
  assert.deepEqual(input, before);
});

test('empty collections, malformed dates and orphan records never create false overdue work', () => {
  const empty = dashboardData(undefined, NOW);
  assert.deepEqual(empty.projects, []);
  assert.deepEqual(empty.required, []);
  assert.deepEqual(empty.people, []);
  const data = dashboardData(state({
    milestones: [node('invalid', 'not-a-date'), node('missing', undefined), node('orphan', '2026-10-20', 'pending', 'unknown')],
    tasks: [task('invalid', '2026-02-30'), task('missing', undefined), task('orphan', '2026-10-20', 'todo', { projectId: 'unknown' })],
  }), NOW);
  assert.deepEqual(data.required, []);
  assert.equal(data.projects[0].milestones.length, 2);
  assert.equal(data.projects[0].metrics.due, 0);
  assert.equal(data.people[0].weeklyTotal, 0);
  assert.equal(data.people[0].stats.onTimeRate, null);
});
