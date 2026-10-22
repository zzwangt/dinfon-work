const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const percent = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
const number = value => String(Number(value.toFixed(1)));

function values(metrics = {}) {
  const actual = percent(metrics?.actual), planned = percent(metrics?.planned);
  return { actual, planned, lag: Math.max(0, planned - actual), total: Math.max(0, Number(metrics?.total) || 0) };
}

/** Green is completed work. The hatched red remainder ends at the planned marker. */
export function renderProgressTrack(metrics, label = '完成进度') {
  const { actual, planned, lag, total } = values(metrics);
  const description = total ? `实际 ${number(actual)}%，计划 ${number(planned)}%，${lag > 0 ? `落后 ${number(lag)} 个百分点` : '按计划推进'}` : '暂无计划任务';
  return `<div class="schedule-progress-track${lag > 0 ? ' is-late' : ''}" role="progressbar" aria-label="${escape(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${number(actual)}" aria-valuetext="${description}" title="${description}"><span class="schedule-progress-actual" style="width:${actual}%" aria-hidden="true"></span>${lag > 0 ? `<span class="schedule-progress-lag" style="left:${actual}%;width:${lag}%" aria-hidden="true"></span>` : ''}${total ? `<span class="schedule-progress-marker" style="left:${planned}%" aria-hidden="true"></span>` : ''}</div>`;
}

/** Keep this visible beside a track so the schedule gap never relies on color. */
export function renderProgressNote(metrics) {
  const { planned, lag, total } = values(metrics);
  if (!total) return '<span class="schedule-progress-note is-empty">暂无计划任务</span>';
  return `<span class="schedule-progress-note${lag > 0 ? ' is-late' : ''}">计划 ${number(planned)}%<span class="schedule-progress-separator" aria-hidden="true"> · </span>${lag > 0 ? `<strong>落后 ${number(lag)} 个百分点</strong>` : '<span>按计划推进</span>'}</span>`;
}
