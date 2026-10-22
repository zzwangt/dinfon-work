import { projectScheduleProgress, weekRange } from './domain.js';
import { datePart, deadlineMs, formatDateTime, isOverdue } from './time.js';
import { renderProgressTrack } from './progress.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const check = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3.5 8 3 3 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function nodeState(milestone, tasks, now, week) {
  if (milestone.status === 'done') return { tone: 'done', label: '已完成' };
  if (isOverdue(milestone.dueDate, now)) return { tone: 'overdue', label: '已逾期' };
  const day = datePart(milestone.dueDate);
  if (day && day >= week.start && day <= week.end) return { tone: 'week', label: '本周必达' };
  if (milestone.status === 'doing' || tasks.some(task => task.status !== 'todo')) return { tone: 'doing', label: '进行中' };
  return { tone: 'todo', label: '未开始' };
}

/** Slots represent equally weighted milestones in deadline order, not elapsed time.
 * Individual node states remain independent of the aggregate completion bar.
 */
export function renderMilestoneProgress(state, projectId, { now = Date.now() } = {}) {
  const milestones = state.milestones.filter(item => item.projectId === projectId).sort((a, b) => {
    const first = deadlineMs(a.dueDate), second = deadlineMs(b.dueDate);
    return (Number.isFinite(first) ? first : Infinity) - (Number.isFinite(second) ? second : Infinity);
  });
  if (!milestones.length) return '<div class="milestone-progress-empty">暂无大节点</div>';
  const project = state.projects?.find(item => item.id === projectId);
  const metrics = projectScheduleProgress(state, projectId, now);
  const week = weekRange(new Date(now).toISOString());
  const tasks = state.tasks.filter(item => item.projectId === projectId);
  const nodes = milestones.map((milestone, index) => {
    const status = nodeState(milestone, tasks.filter(task => task.milestoneId === milestone.id), now, week);
    const label = `大节点 ${index + 1}：${milestone.title}，${status.label}，截止 ${formatDateTime(milestone.dueDate)}，查看详情`;
    return `<li class="milestone-progress-step is-${status.tone}"><button type="button" class="milestone-progress-node" data-action="milestone-detail" data-id="${escape(milestone.id)}" aria-label="${escape(label)}"><span class="milestone-progress-node-slot" aria-hidden="true"><span class="milestone-progress-dot">${status.tone === 'done' ? check : index + 1}</span></span><span class="milestone-progress-title">${escape(milestone.title)}</span><span class="milestone-progress-state">${status.label}</span><span class="milestone-progress-date">${escape(formatDateTime(milestone.dueDate, { compact: true }))}</span></button></li>`;
  }).join('');
  return `<div class="milestone-progress-scroll" role="region" aria-label="${escape(project?.name || '项目')}的大节点进度"><div class="milestone-progress-canvas" style="--milestone-count:${milestones.length}"><div class="milestone-progress-bar">${renderProgressTrack(metrics, `${project?.name || '项目'}完成进度`)}</div><ol class="milestone-progress-steps" aria-label="按截止顺序排列的大节点">${nodes}</ol></div></div>${milestones.length > 2 ? '<p class="milestone-progress-scroll-hint">左右滑动查看全部大节点</p>' : ''}`;
}
