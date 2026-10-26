import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as domain from '../public/client/domain.js';
import * as times from '../public/client/time.js';
import * as notifications from '../public/client/notifications.js';
import { requestComparison, renderMilestoneRequestCard } from '../public/client/milestone-requests.js';

const source = (await readFile(new URL('../public/client/app.js', import.meta.url), 'utf8'))
  .replace(/^import .+;\n/gm, '')
  .replace(/^await loadSession\(\);$/m, '');

function harness(state = domain.createSeedState()) {
  const app = { innerHTML: '' };
  const modal = { innerHTML: '', open: false, showModal() { this.open = true; }, addEventListener() {} };
  const toast = { hidden: true, classList: { toggle() {} } };
  const context = {
    ...domain, ...times, ...notifications, requestComparison,
    document: {
      querySelector: selector => ({ '#app': app, '#modal': modal, '#toast': toast }[selector]),
      querySelectorAll: () => [], addEventListener() {},
    },
    window: { addEventListener() {} },
    initPWA() {}, setInterval() {}, setTimeout() {}, clearTimeout() {},
  };
  const ui = runInNewContext(`(()=>{${source}\nreturn {acceptSession,newMilestone,reviewNodeRequest,newExtension,reviewExtension,reviewTask,approvalCard};})()`, context);
  ui.acceptSession({ state, actor: state.users.find(user => user.id === 'u-admin'), account: { id: 'a-admin', role: 'admin' }, revision: 1 });
  return { ui, modal, state };
}

function inputTag(html, name, element = 'textarea') {
  const tag = html.match(new RegExp(`<${element}\\b[^>]*\\bname="${name}"[^>]*>`))?.[0];
  assert.ok(tag, `${name} ${element} is rendered`);
  return tag;
}

function optionalTextarea(html, name, label) {
  assert.match(html, new RegExp(`<label for="f-${name}">${label}（选填）</label>`));
  const tag = inputTag(html, name);
  assert.doesNotMatch(tag, /\brequired\b/);
  assert.match(tag, /maxlength="2000"/);
}

function nodeRequest(state, reason = '') {
  const project = state.projects.find(project => project.id === 'p-mower');
  return {
    id: 'node-optional', projectId: project.id, kind: 'create', applicantId: 'u-engineer',
    proposed: { title: '补充交付检查', dueDate: project.dueDate }, before: null,
    reason, comment: '', status: 'pending', createdAt: '2026-10-26T02:00:00.000Z',
  };
}

test('new and edited major nodes accept an optional reason while title and date remain required', () => {
  const { ui, modal } = harness();
  for (const milestoneId of [undefined, 'm-mower-2']) {
    ui.newMilestone('p-mower', milestoneId);
    optionalTextarea(modal.innerHTML, 'reason', '申请原因');
    assert.match(inputTag(modal.innerHTML, 'title', 'input'), /\brequired\b/);
    assert.match(inputTag(modal.innerHTML, 'dueDate', 'input'), /\brequired\b/);
    assert.match(modal.innerHTML, /data-form="requestMilestone"/);
  }
});

test('project extension reason is optional without weakening the date and execution plan', () => {
  const { ui, modal } = harness();
  ui.newExtension('p-mower');
  optionalTextarea(modal.innerHTML, 'reason', '延期原因');
  assert.match(inputTag(modal.innerHTML, 'plan'), /\brequired\b/);
  assert.match(inputTag(modal.innerHTML, 'impact'), /\brequired\b/);
  assert.match(inputTag(modal.innerHTML, 'newDueDate', 'input'), /\brequired\b/);
  assert.doesNotMatch(modal.innerHTML, /填写特殊原因/);
  assert.match(modal.innerHTML, /data-form="requestExtension"/);
});

test('both approval decisions accept an optional opinion for nodes and project extensions', () => {
  const state = domain.createSeedState();
  state.milestoneRequests.push(nodeRequest(state));
  const { ui, modal } = harness(state);
  for (const approve of [true, false]) {
    ui.reviewNodeRequest('node-optional', approve);
    optionalTextarea(modal.innerHTML, 'comment', '审批意见');
    assert.doesNotMatch(modal.innerHTML, /class="approval-reason"/);
    assert.match(modal.innerHTML, new RegExp(`data-form="${approve ? 'approve' : 'reject'}MilestoneRequest"`));
    ui.reviewExtension('e-pending', approve);
    optionalTextarea(modal.innerHTML, 'comment', '审批意见');
    assert.match(modal.innerHTML, new RegExp(`data-form="${approve ? 'approve' : 'reject'}Extension"`));
  }
  ui.reviewTask('t-04', false);
  assert.match(inputTag(modal.innerHTML, 'comment'), /\brequired\b/);
});

test('blank reasons leave no empty section on request cards or node approval dialogs', () => {
  for (const reason of [undefined, null, '', ' \n\t ']) {
    const state = domain.createSeedState(), request = nodeRequest(state, reason);
    // Explicitly cover an absent reason as well as a stored empty string.
    request.reason = reason;
    state.milestoneRequests.push(request);
    const { ui, modal } = harness(state);
    const node = renderMilestoneRequestCard(state, request, { admin: true });
    assert.doesNotMatch(node, /class="approval-reason"|class="approval-comment"/);
    assert.match(node, /补充交付检查|data-action="approve-node-request"/);
    ui.reviewNodeRequest(request.id, true);
    assert.doesNotMatch(modal.innerHTML, /class="approval-reason"/);
    const extension = ui.approvalCard({ ...state.extensions.find(item => item.id === 'e-pending'), reason, comment: '' });
    assert.doesNotMatch(extension, /class="approval-reason"|class="approval-comment"/);
    assert.match(extension, /class="approval-plan"/);
    assert.match(extension, /data-action="approve-extension"/);
  }
});

test('provided reasons remain escaped and caller-provided notification markup remains visible', () => {
  const state = domain.createSeedState(), request = nodeRequest(state, '<script>原因</script>');
  state.milestoneRequests.push(request);
  const { ui, modal } = harness(state);
  const badge = '<span class="unread-count" aria-label="1 条未读">1</span>';
  const node = renderMilestoneRequestCard(state, request, { admin: true, unreadMarkup: badge });
  assert.ok(node.includes(badge));
  const extension = ui.approvalCard({ ...state.extensions.find(item => item.id === 'e-pending'), reason: request.reason });
  ui.reviewNodeRequest(request.id, true);
  for (const html of [node, extension, modal.innerHTML]) {
    assert.match(html, /class="approval-reason"/);
    assert.match(html, /&lt;script&gt;原因&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  }
  assert.match(extension, /data-unread-category="approvals" data-unread-entity="e-pending"/);
});
