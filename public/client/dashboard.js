import { dashboardData } from './dashboard-data.js';
import { renderMilestoneProgress } from './milestone-progress.js';
import { renderProgressNote } from './progress.js';
import { formatDateTime } from './time.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => formatDateTime(value, {compact:true});
const calendar = value => formatDateTime(value, {compact:true,legacyLabel:false});
const count = value => `<span class="count">${value}</span>`;
const empty = text => `<p class="admin-empty">${text}</p>`;

function projectProgressPanel(state, data) {
  return `<section class="admin-section" aria-labelledby="admin-projects-title"><header class="admin-section-heading"><div><h2 id="admin-projects-title">各项目进度 ${count(data.projects.length)}</h2><p>任务完成率 · 点击大节点查看详情</p></div><a class="text-link" href="#projects">全部项目 →</a></header><div class="admin-project-list">${data.projects.map(({project:p,metrics,owner})=>`<article class="admin-project-row"><div class="admin-project-info"><h3><a href="#projects/${escape(p.id)}">${escape(p.name)} <span aria-hidden="true">↗</span></a></h3><p>${escape(owner?.name||'未分配')}负责 · ${date(p.dueDate)}截止</p><div class="admin-project-value"><strong>${metrics.total?`${metrics.actual}%`:'—'}</strong><span>${metrics.total?`${metrics.completed} / ${metrics.total} 项已完成`:'尚无任务'}</span></div>${renderProgressNote(metrics)}</div><div class="admin-project-track">${renderMilestoneProgress(state,p.id,{now:data.now,basis:'tasks'})}</div></article>`).join('')||empty('暂无项目。')}</div></section>`;
}

function requiredPanel(data) {
  const overdue = data.required.filter(item=>item.overdue).length;
  return `<section class="admin-section" aria-labelledby="admin-required-title"><header class="admin-section-heading"><div><h2 id="admin-required-title">本周未完成的大节点 ${count(data.required.length)}</h2><p>${calendar(data.week.start)} — ${calendar(data.week.end)} · 包含此前遗留${overdue?` · ${overdue} 个已逾期`:''}</p></div></header><div class="admin-required-list">${data.required.map(({milestone:m,project:p,owner,completedTasks,totalTasks,overdue,carryover})=>`<button type="button" class="admin-required-item${overdue?' is-overdue':''}" data-action="milestone-detail" data-id="${escape(m.id)}"><span class="admin-required-top"><strong>${escape(m.title)}</strong><span class="admin-node-status">${overdue?'已逾期':'本周必达'}</span></span><span class="admin-required-meta">${escape(p.name)} · ${escape(owner?.name||'未分配')}负责</span><span class="admin-required-bottom"><span>${date(m.dueDate)}截止${carryover?' · 此前遗留':''}</span><span>${completedTasks} / ${totalTasks} 项已验收 <span aria-hidden="true">→</span></span></span></button>`).join('')||empty('本周没有未完成的大节点。')}</div></section>`;
}

function rate(pct,n,d) {
  return `<strong class="admin-person-rate${pct===100?' is-complete':''}">${pct==null?'—':`${pct}%`}</strong><span class="admin-rate-count">${d?`${n} / ${d} 项`:'暂无到期任务'}</span>`;
}

function peoplePanel(data) {
  return `<section class="admin-section" aria-labelledby="admin-people-title"><header class="admin-section-heading"><div><h2 id="admin-people-title">人员任务表现 ${count(data.people.length)}</h2><p>本周已到期任务 · 截至 ${date(new Date(data.now).toISOString())}</p></div><a class="text-link" href="#team">更多统计 →</a></header>${data.people.length?`<table class="admin-people-table"><caption class="sr-only">每个人的本周到期任务完成率和按时交付率</caption><thead><tr><th scope="col">人员 / 本周任务</th><th scope="col">任务完成率</th><th scope="col">按时交付率</th></tr></thead><tbody>${data.people.map(({user,stats,weeklyTotal,notDue,pendingReview})=>`<tr><th scope="row"><span class="admin-person-name">${escape(user.name)}</span><span class="admin-person-context">${weeklyTotal} 项计划${notDue?` · ${notDue} 项未到期`:''}${pendingReview?`<br>${pendingReview} 项待验收`:''}</span></th><td>${rate(stats.completionRate,stats.completed,stats.due)}</td><td>${rate(stats.onTimeRate,stats.onTime,stats.due)}</td></tr>`).join('')}</tbody></table>`:empty('暂无人员。')}<details class="admin-metric-explanation"><summary>统计口径</summary><p>两项比例都以本周截至当前已到截止时间的任务为分母。完成率按已验收计算；按时交付率按截止前提交计算，等待验收不计为提交延误。尚未到期的任务另列，没有到期任务时显示“—”。</p><p>使用获批后的截止时间，统一北京时间。</p></details></section>`;
}

export function renderAdminOverview(state,{now=Date.now()}={}) {
  const data=dashboardData(state,now);
  return `<div class="admin-overview">${projectProgressPanel(state,data)}<div class="admin-focus-grid">${requiredPanel(data)}${peoplePanel(data)}</div></div>`;
}
