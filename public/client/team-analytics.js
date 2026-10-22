import { memberStats } from './domain.js';
import { deadlineMs, startMs } from './time.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const percent = value => value == null ? '—' : `${value}%`;
const ratio = (n, d) => d ? Math.round(n / d * 100) : null;
const statuses = [
  { id: 'done', label: '已完成' },
  { id: 'review', label: '待验收' },
  { id: 'doing', label: '进行中' },
  { id: 'todo', label: '待开始' },
];

/** Consume only the supplied scope. All rates retain the shared selected-week cohort. */
export function teamAnalyticsData(scopedState, { people = [], range, now = Date.now() }) {
  const uniquePeople = [...new Map(people.map(user => [user.id, user])).values()];
  const ids = new Set(uniquePeople.map(user => user.id));
  const windowStart = startMs(range.start);
  const windowEnd = deadlineMs(range.end);
  const scopedTasks = (scopedState.tasks || []).filter(task => ids.has(task.ownerId));
  const tasks = scopedTasks.filter(task => deadlineMs(task.dueDate) >= windowStart && deadlineMs(task.dueDate) <= windowEnd);
  const members = uniquePeople.map(user => {
    const stats = memberStats({ ...scopedState, tasks }, user.id, range.start, range.end);
    const assigned = scopedTasks.filter(task => task.ownerId === user.id);
    return {
      user, stats,
      pending: assigned.filter(task => task.status !== 'done').length,
      review: assigned.filter(task => task.status === 'review').length,
      overdue: assigned.filter(task => task.status !== 'done' && deadlineMs(task.dueDate) < now).length,
    };
  });
  const total = members.reduce((sum, member) => sum + member.stats.due, 0);
  const completed = members.reduce((sum, member) => sum + member.stats.completed, 0);
  const onTime = members.reduce((sum, member) => sum + member.stats.onTime, 0);
  const distribution = statuses.map(status => ({ ...status, count: tasks.filter(task => task.status === status.id).length }));
  // Keep original order inside each group; active plans come first, never ranked by rate.
  const orderedMembers = [...members.filter(member => member.stats.due > 0), ...members.filter(member => member.stats.due === 0)];
  return { members: orderedMembers, total, completed, onTime, completionRate: ratio(completed, total), onTimeRate: ratio(onTime, total), distribution };
}

function metricCard({ title, value, count, total, kind, description }) {
  return `<section class="team-summary-card team-summary-${kind}" aria-label="${title}">
    <div class="team-summary-copy"><h2>${title}</h2><p class="team-summary-value">${percent(value)}</p><p class="team-summary-caption">${total ? `<strong>${count}</strong> / ${total} 项${description}` : '所选周暂无任务'}</p></div>
    <svg class="team-ring" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><circle class="team-ring-track" cx="50" cy="50" r="40"/><circle class="team-ring-value" cx="50" cy="50" r="40" pathLength="100" stroke-dasharray="${value ?? 0} 100"${value ? '' : ' visibility="hidden"'}/></svg>
  </section>`;
}

function distributionCard(data) {
  return `<section class="team-summary-card team-distribution" aria-labelledby="team-distribution-title">
    <div class="team-distribution-heading"><h2 id="team-distribution-title">任务分布</h2><span><strong>${data.total}</strong> 项计划</span></div>
    <div class="team-distribution-track${data.total ? '' : ' is-empty'}" aria-hidden="true">${data.distribution.filter(status => status.count).map(status => `<span class="team-status-${status.id}" style="flex-grow:${status.count}"></span>`).join('')}</div>
    <dl class="team-status-legend">${data.distribution.map(status => `<div><dt><span class="team-status-dot team-status-${status.id}" aria-hidden="true"></span>${status.label}</dt><dd>${status.count}</dd></div>`).join('')}</dl>
  </section>`;
}

function memberBar(label, value, count, total, kind) {
  return `<div class="team-member-metric team-metric-${kind}"><div class="team-bar-heading"><span>${label}</span><span><strong>${percent(value)}</strong><small>${count} / ${total} 项</small></span></div><div class="team-bar-track" aria-hidden="true"><span style="width:${value ?? 0}%"></span></div></div>`;
}

function memberRow({ user, stats, pending, review, overdue }) {
  const name = user.name || '未命名成员';
  const initials = Array.from(name.trim()).slice(0, 2).join('') || '·';
  const context = [user.department, user.title].filter(Boolean).join(' · ');
  return `<article class="team-member-row${stats.due ? '' : ' is-empty-week'}">
    <div class="team-member-identity"><span class="team-member-avatar" aria-hidden="true">${escape(initials)}</span><div><h3>${escape(name)}</h3><p>${escape(context || '团队成员')}</p><span class="team-weekly-count">${stats.due} 项周计划${stats.due ? '' : ' · 暂无任务'}</span></div></div>
    ${stats.due ? `<div class="team-member-bars">${memberBar('任务完成率', stats.completionRate, stats.completed, stats.due, 'completion')}${memberBar('按时交付率', stats.onTimeRate, stats.onTime, stats.due, 'on-time')}</div>` : '<p class="team-member-no-plan">所选周暂无计划任务</p>'}
    <div class="team-member-workload"><p class="team-workload-caption">当前待办 · 不限周</p><dl><div><dt>未完成</dt><dd>${pending}<small>项</small></dd></div><div><dt>待验收</dt><dd>${review}<small>项</small></dd></div><div${overdue ? ' class="team-has-overdue"' : ''}><dt>已逾期</dt><dd>${overdue}<small>项</small></dd></div></dl>${stats.due ? `<details class="team-member-quality"><summary>验收质量 <strong>${percent(stats.firstPassRate)}</strong></summary><p>所选周任务中首次验收通过 ${stats.firstPassed} / ${stats.firstReviewed} 项${stats.firstReviewed ? '' : ' · 暂无验收记录'}</p></details>` : ''}</div>
  </article>`;
}

export function renderTeamAnalytics(scopedState, { people, range, now = Date.now() }) {
  const data = teamAnalyticsData(scopedState, { people, range, now });
  return `<div class="team-analytics">
    <div class="team-summary-grid">${metricCard({ title: '任务完成率', value: data.completionRate, count: data.completed, total: data.total, kind: 'completion', description: '已验收' })}${metricCard({ title: '按时交付率', value: data.onTimeRate, count: data.onTime, total: data.total, kind: 'on-time', description: '按时提交' })}${distributionCard(data)}</div>
    <section class="team-members-panel" aria-labelledby="team-members-title"><header class="team-section-heading"><div><h2 id="team-members-title">成员执行概览 <span>${data.members.length} 人</span></h2><p>绿色看完成，蓝色看交付。按所选周计划统计，包含尚未到期的任务。</p></div></header><div class="team-member-list">${data.members.length ? data.members.map(memberRow).join('') : '<p class="team-empty">暂无可查看的团队成员。</p>'}</div></section>
    <details class="team-metric-note"><summary>了解统计口径</summary><div><p>任务完成率 = 已验收任务 ÷ 所选周截止任务。按时交付率 = 截止前提交的任务 ÷ 所选周截止任务，等待验收不会被算作成员提交延误。两项指标均包含所选周尚未到期的任务；没有可统计任务时显示「—」。</p><p>验收质量按所选周首次验收通过的任务 ÷ 已发生首次验收的任务计算。当前待办不限周，包含可见项目中此前遗留和未来的未完成任务；已逾期指已过截止时间但尚未验收的任务。获批调整后使用新的截止时间，统一北京时间。这里用于观察计划执行，不作员工绩效排名。</p></div></details>
  </div>`;
}
