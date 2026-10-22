import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProgressTrack, renderProgressNote } from '../public/client/progress.js';

test('late progress places the red gap exactly after actual and before the planned marker', () => {
  const metrics = { actual: 25, planned: 75, lag: 50, total: 4 };
  const html = renderProgressTrack(metrics, '项目进度');
  assert.match(html, /schedule-progress-actual" style="width:25%"/);
  assert.match(html, /schedule-progress-lag" style="left:25%;width:50%"/);
  assert.match(html, /schedule-progress-marker" style="left:75%"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="25"/);
  assert.match(html, /aria-valuetext="实际 25%，计划 75%，落后 50%"/);
  const note = renderProgressNote(metrics);
  assert.match(note, /计划 75%/);
  assert.match(note, /落后 50%/);
});

test('ahead or on-time work has no red gap and still gives the plan in words', () => {
  for (const actual of [50, 75, 100]) {
    const metrics = { actual, planned: 50, total: 4 };
    assert.doesNotMatch(renderProgressTrack(metrics), /class="schedule-progress-lag"|is-late/);
    assert.match(renderProgressNote(metrics), /计划 50%/);
    assert.match(renderProgressNote(metrics), /按计划推进/);
  }
});

test('an empty plan is not presented as behind schedule or as complete', () => {
  const metrics = { actual: 0, planned: 0, lag: 0, total: 0 };
  const html = renderProgressTrack(metrics);
  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /暂无计划任务/);
  assert.doesNotMatch(html, /schedule-progress-marker|schedule-progress-lag/);
  assert.match(renderProgressNote(metrics), /暂无计划任务/);
});

test('zero actual progress can show the whole overdue plan without inventing completed work', () => {
  const metrics = { actual: 0, planned: 100, lag: 100, total: 2 };
  assert.match(renderProgressTrack(metrics), /schedule-progress-lag" style="left:0%;width:100%"/);
  assert.match(renderProgressNote(metrics), /落后 100%/);
});

test('labels are escaped and nonfinite or out-of-range values cannot break track geometry', () => {
  const html = renderProgressTrack({ actual: -5, planned: 140, total: 1 }, '"><img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /<img|width:-5|140%/);
  assert.match(html, /aria-label="&quot;&gt;&lt;img/);
  assert.match(html, /left:0%;width:100%/);
  assert.doesNotMatch(renderProgressTrack({ actual: NaN, planned: Infinity, total: 1 }), /NaN|Infinity/);
});

test('renderers do not mutate supplied schedule data', () => {
  const metrics = Object.freeze({ actual: 33, planned: 67, lag: 34, total: 3 });
  assert.doesNotThrow(() => { renderProgressTrack(metrics); renderProgressNote(metrics); });
});
