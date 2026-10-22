import test from 'node:test';
import assert from 'node:assert/strict';
import { requestComparison, renderMilestoneRequestCard } from '../public/client/milestone-requests.js';

const state = {
  projects: [{ id: 'p', name: '产品项目' }],
  users: [{ id: 'member', name: '成员' }, { id: 'admin', name: '管理员' }],
};
const fixture = () => ({
  id: 'request', projectId: 'p', kind: 'update', applicantId: 'member', reviewerId: 'admin',
  before: { title: '第一阶段', dueDate: '2026-10-22T09:00', weight: 20 },
  proposed: { title: '第一阶段复核', dueDate: '2026-10-22T18:00', weight: 30 },
  reason: '补充交付检查', comment: '同意调整', status: 'approved',
  createdAt: '2026-10-21T16:25:00.000Z', reviewedAt: '2026-10-22T03:40:00.000Z',
});

test('hour-only changes remain visible alongside Shanghai application and approval timestamps', () => {
  const html = renderMilestoneRequestCard(state, fixture());
  assert.match(html, /截止时间/);
  assert.match(html, /2026\.10\.22 09:00/);
  assert.match(html, /is-changed">2026\.10\.22 18:00/);
  assert.match(html, /申请于 2026\.10\.22 00:25/);
  assert.match(html, /审批于 2026\.10\.22 11:40/);
  assert.doesNotMatch(html, /截止日期|权重|weight/);
});

test('legacy whole-day node deadlines are not silently shown as midnight', () => {
  const request = { ...fixture(), kind: 'create', before: null, proposed: { title: '新节点', dueDate: '2026-10-22' } };
  const html = requestComparison(request);
  assert.match(html, /node-proposed-details/);
  assert.match(html, /2026\.10\.22 全天/);
  assert.doesNotMatch(html, /00:00|尚未创建/);
});

test('hourly cards retain approval permissions and escape user-entered content', () => {
  const request = { ...fixture(), status: 'pending', comment: '<img src=x>', reason: '<script>bad()</script>', proposed: { title: '<b>节点</b>', dueDate: '2026-10-22T18:00' } };
  const admin = renderMilestoneRequestCard(state, request, { admin: true });
  assert.match(admin, /data-action="approve-node-request"/);
  assert.match(admin, /data-action="reject-node-request"/);
  assert.match(admin, /&lt;script&gt;/);
  assert.match(admin, /&lt;b&gt;/);
  assert.doesNotMatch(admin, /<script>|<img src=x>|<b>节点/);
  assert.doesNotMatch(renderMilestoneRequestCard(state, request), /data-action="(?:approve|reject)-node-request"/);
});
