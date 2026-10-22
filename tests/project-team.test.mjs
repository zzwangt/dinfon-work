import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProjectTeam, renderProjectPeopleSummary } from '../public/client/project-team.js';

function fixture() {
  return {
    project: { id: 'p', ownerId: 'lead', memberIds: ['worker', 'lead', 'worker', 'no-work'] },
    state: {
      users: [
        { id: 'lead', name: '负责人甲', department: '项目管理', title: '项目经理' },
        { id: 'worker', name: '成员乙', department: '研发', title: '工程师' },
        { id: 'no-work', name: '成员丙', department: '设计', title: '设计师' },
        { id: 'reviewer', name: '验收丁', department: '质量', title: '质量主管' },
      ],
      tasks: [
        { id: 't-a', projectId: 'p', ownerId: 'worker', reviewerId: 'lead', title: '完成样机', status: 'doing' },
        { id: 't-b', projectId: 'p', ownerId: 'worker', reviewerId: 'reviewer', title: '提交报告', status: 'done' },
        { id: 't-c', projectId: 'p', ownerId: 'worker', reviewerId: 'reviewer', title: '联调成果', status: 'review' },
        { id: 't-out', projectId: 'outside', ownerId: 'worker', reviewerId: 'reviewer', title: '其他项目秘密任务', status: 'todo' },
      ],
    },
  };
}

test('project owner is first and membership is deduplicated', () => {
  const { state, project } = fixture();
  const html = renderProjectTeam(state, project);
  const personIds = [...html.matchAll(/data-team-person="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(personIds, ['lead', 'worker', 'no-work', 'reviewer']);
  assert.match(html, /3 名项目成员/);
  assert.match(html, /项目经理/);
  assert.match(html, /研发/);
  assert.match(html, /尚未分配执行任务/);
});

test('only current-project responsibilities are shown with accurate task counts', () => {
  const { state, project } = fixture();
  const html = renderProjectTeam(state, project);
  assert.match(html, /已完成 <strong>1 \/ 3<\/strong>/);
  assert.match(html, /待验收 <strong>1<\/strong> 项/);
  assert.match(html, /data-action="task-detail" data-id="t-a"/);
  assert.match(html, /data-action="task-detail" data-id="t-b"/);
  assert.doesNotMatch(html, /t-out|其他项目秘密任务/);
});

test('reviewer-only people appear separately and do not inflate membership summary', () => {
  const { state, project } = fixture();
  const html = renderProjectTeam(state, project);
  assert.match(html, /验收协作/);
  assert.match(html, /不计入项目成员人数/);
  const reviewerRow = html.slice(html.indexOf('data-team-person="reviewer"'));
  assert.match(reviewerRow, /验收任务/);
  assert.doesNotMatch(reviewerRow, /负责的任务/);
  const summary = renderProjectPeopleSummary(state, project);
  assert.match(summary, /负责人甲/);
  assert.match(summary, /成员乙、成员丙/);
  assert.match(summary, /另有 1 名验收协作/);
  assert.doesNotMatch(summary, /验收丁/);
  assert.match(summary, /data-action="project-view" data-id="people"/);
});

test('legacy blocked tasks render as in progress without losing ownership or actions', () => {
  const { state, project } = fixture();
  state.tasks[0].status = 'blocked';
  const before = structuredClone({ state, project });
  const html = renderProjectTeam(state, project);
  assert.match(html, /data-action="task-detail" data-id="t-a"[^>]*完成样机，进行中/);
  assert.match(html, /project-team-task-status is-doing/);
  assert.match(html, /已完成 <strong>1 \/ 3<\/strong>/);
  assert.doesNotMatch(html, /受阻|is-blocked/);
  assert.deepEqual({ state, project }, before);
});

test('task rows show hourly deadlines and recorded handoff times in Shanghai time', () => {
  const { state, project } = fixture();
  Object.assign(state.tasks[1], {
    dueDate: '2026-10-22T18:00',
    submittedAt: '2026-10-22T09:35:00.000Z',
    reviewedAt: '2026-10-22T16:10:00.000Z',
  });
  const html = renderProjectTeam(state, project);
  assert.match(html, /截止时间 2026\.10\.22 18:00/);
  assert.match(html, /提交时间 2026\.10\.22 17:35/);
  assert.match(html, /验收时间 2026\.10\.23 00:10/);
  assert.match(html, /project-team-time-value">10\/22 18:00/);
  assert.match(html, /project-team-time-value">10\/22 17:35/);
  assert.match(html, /project-team-time-value">10\/23 00:10/);
});

test('old all-day deadlines remain explicit and rejected reviews are not called completed acceptance', () => {
  const { state, project } = fixture();
  Object.assign(state.tasks[0], {
    dueDate: '2026-10-22',
    reviewedAt: '2026-10-22T03:15:00.000Z',
  });
  const html = renderProjectTeam(state, project);
  assert.match(html, /截止时间 2026\.10\.22 全天/);
  assert.match(html, /project-team-time-value">10\/22 全天/);
  assert.match(html, /最近审核时间 2026\.10\.22 11:15/);
  assert.doesNotMatch(html, /验收时间 2026\.10\.22 11:15|提交时间/);
});

test('missing profiles and empty projects are safely explained', () => {
  const html = renderProjectTeam({ users: [], tasks: [] }, { id: 'empty', ownerId: 'missing', memberIds: ['missing'] });
  assert.match(html, /成员资料待补充/);
  assert.match(html, /部门未设置/);
  assert.match(html, /岗位未设置/);
  assert.match(html, /1 名项目成员/);
  assert.doesNotMatch(html, /undefined|null/);
  assert.match(renderProjectTeam(), /尚未设置项目成员/);
});

test('out-of-roster task owners remain visible as collaborators rather than project members', () => {
  const { state, project } = fixture();
  state.tasks.push({ id: 't-extra', projectId: 'p', ownerId: 'external', reviewerId: 'lead', title: '额外协作', status: 'todo' });
  const html = renderProjectTeam(state, project);
  assert.match(html, /任务协作人员/);
  assert.match(html, /data-team-person="external"/);
  assert.match(html, /data-action="task-detail" data-id="t-extra"/);
  assert.match(html, /3 名项目成员/);
});

test('user text and action IDs are escaped; rendering is read-only', () => {
  const { state, project } = fixture();
  state.users[1].name = '<img src=x onerror=alert(1)>';
  state.users[1].title = '" onclick="bad()';
  state.tasks[0].title = '<script>bad()</script>';
  state.tasks[0].id = '" onclick="bad()';
  const before = structuredClone({ state, project });
  const html = renderProjectTeam(state, project) + renderProjectPeopleSummary(state, project);
  assert.doesNotMatch(html, /<img|<script|data-id="" onclick=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script/);
  assert.match(html, /data-id="&quot; onclick=&quot;bad\(\)"/);
  assert.doesNotMatch(html, /data-action="(?:new|edit|delete|remove|add)-/);
  assert.deepEqual({ state, project }, before);
});
