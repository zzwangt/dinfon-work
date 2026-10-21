import { today, weekRange } from './domain.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` : '未设置';
const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  fit: svg('<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
  arrow: svg('<path d="M4 12h16m-5-5 5 5-5 5"/>'),
  check: svg('<path d="m5 12 4 4L19 6"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  warning: svg('<path d="m12 3 10 18H2zM12 9v5M12 17h.01"/>'),
  branch: svg('<rect x="8" y="2" width="8" height="6" rx="1"/><rect x="2" y="16" width="7" height="6" rx="1"/><rect x="15" y="16" width="7" height="6" rx="1"/><path d="M12 8v4M5.5 16v-4h13v4"/>'),
};

function taskTone(task, day) {
  if (task.status === 'done') return { tone: 'done', label: '已完成' };
  if (task.status === 'blocked') return { tone: 'blocked', label: '受阻' };
  if (task.dueDate < day) return { tone: 'blocked', label: task.status === 'review' ? '待验收 · 已逾期' : '已逾期' };
  return { tone: ['doing', 'review'].includes(task.status) ? task.status : 'todo', label: ({ doing: '进行中', review: '待验收' })[task.status] || '未开始' };
}

function phaseTone(milestone, tasks, day) {
  if (milestone.status === 'done') return { tone: 'done', label: '已达成' };
  if (tasks.some(task => task.status === 'blocked')) return { tone: 'blocked', label: '有任务受阻' };
  if (milestone.dueDate < day) return { tone: 'blocked', label: '节点已逾期' };
  if (tasks.length && tasks.every(task => task.status === 'done')) return { tone: 'review', label: '待确认达成' };
  if (tasks.some(task => task.status !== 'todo')) return { tone: 'doing', label: '推进中' };
  return { tone: 'todo', label: '待启动' };
}

/** Large nodes are milestones; branch lines express membership, not dependency.
 * Scope and expansion are view state supplied by app.js; business data is never changed.
 */
export function renderProjectFlow(state, project, options = {}) {
  const canManage = options.canManage === true;
  const scope = ['all', 'week', 'mine'].includes(options.scope) ? options.scope : 'all';
  const expandedIds = new Set(Array.isArray(options.expandedIds) ? options.expandedIds : []);
  const day = today(), week = weekRange(day);
  const milestones = state.milestones.filter(item => item.projectId === project.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const tasks = state.tasks.filter(item => item.projectId === project.id);
  if (!milestones.length) return `<section class="flow-empty"><span class="flow-empty-icon">${icons.branch}</span><h2>从第一个大节点开始</h2><p>把项目拆成每周的交付节点，再在节点下分配每日任务。</p>${canManage ? `<button class="button primary" data-action="new-milestone" data-id="${escape(project.id)}">${icons.plus}添加大节点</button>` : '<p>项目负责人创建节点后，团队就可以在这里查看整个流程。</p>'}</section>`;

  const matches = task => scope === 'mine' ? Boolean(options.actorId) && task.ownerId === options.actorId : scope === 'week' ? task.dueDate <= week.end && (task.dueDate >= week.start || task.status !== 'done') : true;
  const columns = milestones.map(milestone => {
    const children = tasks.filter(task => task.milestoneId === milestone.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const expanded = milestone.status !== 'done' || expandedIds.has(milestone.id);
    return { milestone, children, matches: children.filter(matches), expanded };
  });
  const milestoneIds = new Set(milestones.map(item => item.id));
  const unassigned = tasks.filter(task => !milestoneIds.has(task.milestoneId));
  const visibleUnassigned = unassigned.filter(matches);
  const weeklyRequired = milestones.filter(item => item.status !== 'done' && item.dueDate <= week.end).length;
  const collapsedCount = columns.reduce((sum, column) => sum + (column.expanded ? 0 : column.matches.length), 0);
  const visibleCount = columns.reduce((sum, column) => sum + (column.expanded ? column.matches.length : 0), visibleUnassigned.length);
  const totalWeight = milestones.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const layout = { x: 32, pitch: 320, phaseWidth: 264, phaseTop: 16, phaseBottom: 204, branchTop: 216, labelTop: 208, taskTop: 244, taskPitch: 110, taskCenter: 50 };
  const width = columns.length * layout.pitch + 8;
  const height = Math.max(380, ...columns.map(column => layout.taskTop + (column.expanded ? Math.max(column.matches.length, 1) * layout.taskPitch : 76) + (canManage && column.milestone.status !== 'done' ? 54 : 24)));
  let paths = '';

  const content = columns.map(({ milestone, children, matches: filtered, expanded }, index) => {
    const x = layout.x + index * layout.pitch;
    const phase = phaseTone(milestone, children, day);
    const done = children.filter(task => task.status === 'done').length;
    const share = totalWeight ? Math.round(Number(milestone.weight || 0) / totalWeight * 100) : 0;
    const required = milestone.status !== 'done' && milestone.dueDate <= week.end;
    const late = required && milestone.dueDate < day;
    const daysLeft = Math.round((Date.parse(`${milestone.dueDate}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
    const requirement = required ? `<span class="flow-duty ${late ? 'is-late' : ''}">${icons.warning}<strong>${late ? '已逾期 · 本周补齐' : '本周必须完成'}</strong><span>${late ? (milestone.dueDate < week.start ? '此前逾期' : `逾期 ${-daysLeft} 天`) : daysLeft === 0 ? '今天截止' : `剩 ${daysLeft} 天`}</span></span>` : '';
    const ready = milestone.status !== 'done' && children.length > 0 && done === children.length;
    const groupId = `flow-tasks-${encodeURIComponent(project.id)}-${encodeURIComponent(milestone.id)}`;
    if (index < columns.length - 1) {
      const nextX = x + layout.pitch;
      paths += `<path class="flow-sequence ${milestone.status === 'done' ? 'is-done' : ''}" d="M${x + layout.phaseWidth} 110 H${nextX - 7}"/><path class="flow-arrowhead ${milestone.status === 'done' ? 'is-done' : ''}" d="m${nextX - 13} 105 6 5-6 5"/>`;
    }
    const branchEnd = expanded && filtered.length ? layout.taskTop + (filtered.length - 1) * layout.taskPitch + layout.taskCenter : layout.taskTop + 35;
    paths += `<path class="flow-branch" d="M${x + 132} ${layout.phaseBottom} V${layout.branchTop} H${x + 3} V${branchEnd}"/>`;
    if (expanded && filtered.length) filtered.forEach((task, taskIndex) => {
      const center = layout.taskTop + taskIndex * layout.taskPitch + layout.taskCenter;
      paths += `<path class="flow-branch" d="M${x + 3} ${center} H${x + 20}"/><circle class="flow-junction" cx="${x + 3}" cy="${center}" r="3"/>`;
    });
    else paths += `<path class="flow-branch" d="M${x + 3} ${branchEnd} H${x + 20}"/>`;

    const taskNodes = expanded ? filtered.map((task, taskIndex) => {
      const person = state.users.find(item => item.id === task.ownerId);
      const tone = taskTone(task, day);
      const isLate = task.status !== 'done' && task.dueDate < day;
      return `<button type="button" class="flow-task flow-tone-${tone.tone}" data-action="task-detail" data-id="${escape(task.id)}" style="top:${layout.taskTop + taskIndex * layout.taskPitch}px;left:${x + 20}px" aria-label="任务：${escape(task.title)}，${escape(tone.label)}，${escape(person?.name || '未分配')}负责"><span class="flow-task-top"><span class="flow-node-status"><i></i>${escape(tone.label)}</span><span class="flow-task-date ${isLate ? 'is-late' : ''}">${date(task.dueDate)} 截止</span></span><strong class="flow-task-title">${escape(task.title)}</strong><span class="flow-task-bottom"><span class="flow-person"><span class="flow-avatar">${escape(person?.name?.slice(-1) || '?')}</span>${escape(person?.name || '未分配')}</span><span class="flow-task-open">${task.status === 'review' ? '查看成果' : task.status === 'done' ? '查看交付' : '查看任务'}${icons.arrow}</span></span></button>`;
    }).join('') : '';
    const emptyCopy = !expanded ? ['已完成任务已收起', `${filtered.length} 项符合当前筛选，可展开回看`] : !children.length ? ['还没有分配任务', '将阶段目标拆成可交付的工作'] : [scope === 'mine' ? '没有分配给我的任务' : '没有本周重点任务', '此阶段仍保留在完整流程中'];
    const emptyState = !expanded || !filtered.length ? `<div class="flow-no-tasks${!expanded ? ' is-collapsed' : ''}" style="left:${x + 20}px;top:${layout.taskTop}px"><span>${emptyCopy[0]}</span><small>${emptyCopy[1]}</small></div>` : '';
    const toggle = milestone.status === 'done' ? `<button type="button" class="flow-toggle" data-action="flow-toggle" data-id="${escape(milestone.id)}" aria-expanded="${expanded}" aria-controls="${escape(groupId)}" aria-label="${expanded ? '收起' : '展开'}${escape(milestone.title)}的任务">${expanded ? '收起' : '展开'}${icons.chevron}</button>` : '';

    return `<article class="flow-phase flow-tone-${phase.tone}${required ? ` flow-required${late ? ' is-overdue' : ''}` : ''}" style="left:${x}px;top:${layout.phaseTop}px" aria-label="大节点 ${index + 1}：${escape(milestone.title)}"><button type="button" class="flow-phase-main" data-action="milestone-detail" data-id="${escape(milestone.id)}"><span class="flow-phase-top"><span class="flow-step">${milestone.status === 'done' ? icons.check : String(index + 1).padStart(2, '0')}</span><span class="flow-node-status flow-tone-${phase.tone}"><i></i>${escape(phase.label)}</span><span class="flow-phase-open">${icons.arrow}</span></span><h3>${escape(milestone.title)}</h3>${requirement}<span class="flow-phase-meta"><span>${date(milestone.dueDate)} 交付</span><span>权重 ${share}%</span></span></button><div class="flow-phase-bottom"><span><strong>${done}</strong> / ${children.length} 项已完成</span>${ready && canManage ? `<button type="button" data-action="complete-milestone" data-id="${escape(milestone.id)}" class="flow-confirm">确认达成${icons.check}</button>` : `<span class="flow-phase-progress"><i style="width:${children.length ? Math.round(done / children.length * 100) : 0}%"></i></span>`}</div></article><div class="flow-children-heading" style="left:${x + 20}px;top:${layout.labelTop}px"><span>显示 <strong>${expanded ? filtered.length : 0}</strong> / 共 ${children.length} 项</span>${toggle}</div><div id="${escape(groupId)}" class="flow-children-group"${expanded ? '' : ' hidden'}>${taskNodes}</div>${emptyState}${canManage && milestone.status !== 'done' ? `<button type="button" class="flow-add-task" data-action="new-task" data-id="${escape(project.id)}" data-milestone-id="${escape(milestone.id)}" style="left:${x + 20}px;top:${layout.taskTop + Math.max(filtered.length, 1) * layout.taskPitch}px">${icons.plus}添加小节点</button>` : ''}`;
  }).join('');

  const filters = [['all', '全部流程'], ['week', '本周重点'], ['mine', '我的任务']].map(([value, label]) => `<button type="button" class="flow-filter${scope === value ? ' is-active' : ''}" data-action="flow-filter" data-id="${value}" aria-pressed="${scope === value}"${value === 'mine' && !options.actorId ? ' disabled title="登录后查看分配给自己的任务"' : ''}>${label}</button>`).join('');
  const scopeHint = scope === 'week' ? '本周截止 + 此前未完成' : scope === 'mine' ? '仅显示当前账号负责的任务' : '大节点为周交付，小节点为每日任务';
  return `<section class="project-flow" data-project-flow data-flow-canvas data-flow-scope="${scope}"><div class="flow-toolbar"><div class="flow-toolbar-title">${icons.branch}<h2>项目流程图</h2><span>${milestones.length} 个大节点</span><span class="flow-weekly-count${weeklyRequired ? '' : ' is-clear'}">本周待完成 <strong>${weeklyRequired}</strong> 个大节点</span></div><div class="flow-tools"><button type="button" data-flow-control="out" aria-label="缩小流程图" title="缩小">${icons.minus}</button><output class="flow-zoom" aria-live="polite" aria-label="当前缩放">100%</output><button type="button" data-flow-control="in" aria-label="放大流程图" title="放大">${icons.plus}</button><span class="flow-tools-divider"></span><button type="button" class="flow-fit" data-flow-control="fit">${icons.fit}<span>适应画布</span></button></div></div><div class="flow-filterbar"><div class="flow-filters" role="group" aria-label="小任务筛选">${filters}</div><div class="flow-filter-summary" aria-live="polite"><strong>显示 ${visibleCount} / 共 ${tasks.length} 项任务</strong>${collapsedCount ? `<span>已收起 ${collapsedCount} 项</span>` : ''}<span class="flow-scope-hint">${scopeHint}</span></div></div><div class="flow-color-legend" aria-label="状态颜色说明"><span class="flow-tone-done"><i></i>已完成</span><span class="flow-tone-doing"><i></i>进行中</span><span class="flow-tone-required"><i></i>本周必达</span><span class="flow-tone-review"><i></i>待验收</span><span class="flow-tone-blocked"><i></i>逾期 / 受阻</span><span class="flow-tone-todo"><i></i>未来 / 未开始</span></div><div class="flow-scroll" tabindex="0" aria-label="项目流程画布，可横向滚动，点击节点查看详情"><div class="flow-size" style="width:${width}px;height:${height}px"><div class="flow-stage" data-flow-width="${width}" data-flow-height="${height}" style="width:${width}px;height:${height}px"><svg class="flow-connectors" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${paths}</svg>${content}</div></div></div><div class="flow-footer"><div class="flow-semantics"><span>${icons.arrow}阶段顺序</span><span><i class="flow-branch-key"></i>所属任务</span><span class="flow-pan-hint">拖动画布 · 点击节点查看</span><span class="flow-touch-hint">横向滑动 · 点击节点查看</span></div><span>今天 ${date(day)} · 本周截至 ${date(week.end)}</span></div>${unassigned.length ? `<div class="flow-unassigned"><strong>尚未归属大节点 · 显示 ${visibleUnassigned.length} / 共 ${unassigned.length} 项</strong>${visibleUnassigned.map(task => `<button type="button" data-action="task-detail" data-id="${escape(task.id)}">${escape(task.title)}${icons.arrow}</button>`).join('')}${!visibleUnassigned.length ? '<span>没有符合当前筛选的任务</span>' : ''}</div>` : ''}</section>`;
}

/** UI-only binding; task and milestone actions stay with app.js delegation. */
export function bindFlowCanvas(container) {
  const roots = container.matches?.('[data-flow-canvas]') ? [container] : container.querySelectorAll('[data-flow-canvas]');
  for (const root of roots) {
    if (root.dataset.flowBound) continue;
    root.dataset.flowBound = 'true';
    const viewport = root.querySelector('.flow-scroll');
    const spacer = root.querySelector('.flow-size');
    const stage = root.querySelector('.flow-stage');
    const output = root.querySelector('.flow-zoom');
    const width = Number(stage.dataset.flowWidth), height = Number(stage.dataset.flowHeight);
    let zoom = 1;
    const applyZoom = (value, fit = false) => {
      const previous = zoom;
      zoom = Math.max(.55, Math.min(1.3, Math.round(value * 100) / 100));
      const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / previous;
      const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / previous;
      stage.style.transform = `scale(${zoom})`;
      spacer.style.width = `${Math.ceil(width * zoom)}px`;
      spacer.style.height = `${Math.ceil(height * zoom)}px`;
      output.value = `${Math.round(zoom * 100)}%`;
      output.textContent = output.value;
      root.querySelector('[data-flow-control="out"]').disabled = zoom <= .55;
      root.querySelector('[data-flow-control="in"]').disabled = zoom >= 1.3;
      viewport.scrollLeft = fit ? 0 : centerX * zoom - viewport.clientWidth / 2;
      viewport.scrollTop = fit ? 0 : centerY * zoom - viewport.clientHeight / 2;
    };
    root.querySelector('.flow-tools').addEventListener('click', event => {
      const control = event.target.closest('[data-flow-control]')?.dataset.flowControl;
      if (control === 'in') applyZoom(zoom + .1);
      if (control === 'out') applyZoom(zoom - .1);
      if (control === 'fit') applyZoom(Math.min(1, (viewport.clientWidth - 8) / width), true);
    });
    let drag = null;
    viewport.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('button,a,input,select,textarea')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
      viewport.setPointerCapture(event.pointerId);
      viewport.classList.add('is-panning');
      event.preventDefault();
    });
    viewport.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      viewport.scrollLeft = drag.left - (event.clientX - drag.x);
      viewport.scrollTop = drag.top - (event.clientY - drag.y);
    });
    const stopDrag = event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
      drag = null;
      viewport.classList.remove('is-panning');
    };
    viewport.addEventListener('pointerup', stopDrag);
    viewport.addEventListener('pointercancel', stopDrag);
    viewport.addEventListener('lostpointercapture', () => { drag = null; viewport.classList.remove('is-panning'); });
  }
}
