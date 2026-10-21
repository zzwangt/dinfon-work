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

/** Large nodes are milestones; branch lines express task membership, not dependency. */
export function renderProjectFlow(state, project, options = {}) {
  const canManage = options.canManage === true;
  const day = today();
  const week = weekRange(day);
  const milestones = state.milestones.filter(item => item.projectId === project.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const tasks = state.tasks.filter(item => item.projectId === project.id);
  if (!milestones.length) return `<section class="flow-empty"><span class="flow-empty-icon">${icons.branch}</span><h2>从第一个大节点开始</h2><p>把项目拆成每周的交付节点，再在节点下分配每日任务。</p>${canManage ? `<button class="button primary" data-action="new-milestone" data-id="${escape(project.id)}">${icons.plus}添加大节点</button>` : '<p>项目负责人创建节点后，团队就可以在这里查看整个流程。</p>'}</section>`;

  const columns = milestones.map(milestone => ({ milestone, tasks: tasks.filter(task => task.milestoneId === milestone.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate)) }));
  const unassigned = tasks.filter(task => !milestones.some(milestone => milestone.id === task.milestoneId));
  const weeklyRequired = milestones.filter(item => item.status !== 'done' && item.dueDate <= week.end).length;
  const totalWeight = milestones.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  const width = columns.length * 320 + 8;
  const largestColumn = Math.max(...columns.map(column => column.tasks.length), 1);
  const height = Math.max(560, 284 + largestColumn * 114 + (canManage ? 54 : 24));
  let paths = '';

  const content = columns.map(({ milestone, tasks: children }, index) => {
    const x = 32 + index * 320;
    const phase = phaseTone(milestone, children, day);
    const done = children.filter(task => task.status === 'done').length;
    const share = totalWeight ? Math.round(Number(milestone.weight || 0) / totalWeight * 100) : 0;
    const required = milestone.status !== 'done' && milestone.dueDate <= week.end;
    const late = required && milestone.dueDate < day;
    const daysLeft = Math.round((Date.parse(`${milestone.dueDate}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400000);
    const requirement = required ? `<span class="flow-duty ${late ? 'is-late' : ''}">${icons.warning}<strong>${late ? '已逾期 · 本周补齐' : '本周必须完成'}</strong><span>${late ? (milestone.dueDate < week.start ? '此前逾期' : `逾期 ${-daysLeft} 天`) : daysLeft === 0 ? '今天截止' : `剩 ${daysLeft} 天`}</span></span>` : `<span class="flow-phase-caption">${milestone.status === 'done' ? '阶段交付已验收' : `后续节点 · 剩 ${daysLeft} 天`}</span>`;
    const ready = milestone.status !== 'done' && children.length > 0 && done === children.length;
    if (index < columns.length - 1) {
      const nextX = x + 320;
      paths += `<path class="flow-sequence ${milestone.status === 'done' ? 'is-done' : ''}" d="M${x + 264} 131 H${nextX - 7}"/><path class="flow-arrowhead ${milestone.status === 'done' ? 'is-done' : ''}" d="m${nextX - 13} 126 6 5-6 5"/>`;
    }
    const branchEnd = children.length ? 284 + (children.length - 1) * 114 + 52 : 328;
    paths += `<path class="flow-branch" d="M${x + 132} 238 V256 H${x + 3} V${branchEnd}"/>`;
    if (children.length) children.forEach((task, taskIndex) => { paths += `<path class="flow-branch" d="M${x + 3} ${336 + taskIndex * 114} H${x + 20}"/><circle class="flow-junction" cx="${x + 3}" cy="${336 + taskIndex * 114}" r="3"/>`; });
    else paths += `<path class="flow-branch" d="M${x + 3} 328 H${x + 20}"/>`;

    const taskNodes = children.map((task, taskIndex) => {
      const person = state.users.find(item => item.id === task.ownerId);
      const tone = taskTone(task, day);
      const late = task.status !== 'done' && task.dueDate < day;
      return `<button type="button" class="flow-task flow-tone-${tone.tone}" data-action="task-detail" data-id="${escape(task.id)}" style="top:${284 + taskIndex * 114}px;left:${x + 20}px" aria-label="任务：${escape(task.title)}，${escape(tone.label)}，${escape(person?.name || '未分配')}负责"><span class="flow-task-top"><span class="flow-node-status"><i></i>${escape(tone.label)}</span><span class="flow-task-date ${late ? 'is-late' : ''}">${date(task.dueDate)} 截止</span></span><strong class="flow-task-title">${escape(task.title)}</strong><span class="flow-task-bottom"><span class="flow-person"><span class="flow-avatar">${escape(person?.name?.slice(-1) || '?')}</span>${escape(person?.name || '未分配')}</span><span class="flow-task-open">${task.status === 'review' ? '查看成果' : task.status === 'done' ? '查看交付' : '查看任务'}${icons.arrow}</span></span></button>`;
    }).join('');

    return `<article class="flow-phase flow-tone-${phase.tone}${required ? ` flow-required${late ? ' is-overdue' : ''}` : ''}" style="left:${x}px;top:32px" aria-label="大节点 ${index + 1}：${escape(milestone.title)}"><button type="button" class="flow-phase-main" data-action="milestone-detail" data-id="${escape(milestone.id)}"><span class="flow-phase-top"><span class="flow-step">${milestone.status === 'done' ? icons.check : String(index + 1).padStart(2, '0')}</span><span class="flow-node-status"><i></i>${escape(phase.label)}</span><span class="flow-phase-open">${icons.arrow}</span></span>${requirement}<h3>${escape(milestone.title)}</h3><span class="flow-phase-meta"><span>${date(milestone.dueDate)} 交付</span><span>项目权重 ${share}%</span></span></button><div class="flow-phase-bottom"><span><strong>${done}</strong> / ${children.length} 项任务完成</span>${ready && canManage ? `<button type="button" data-action="complete-milestone" data-id="${escape(milestone.id)}" class="flow-confirm">确认达成${icons.check}</button>` : `<span class="flow-phase-progress"><i style="width:${children.length ? Math.round(done / children.length * 100) : 0}%"></i></span>`}</div></article><span class="flow-children-label" style="left:${x + 20}px;top:260px">小节点 · 日常任务</span>${taskNodes}${!children.length ? `<div class="flow-no-tasks" style="left:${x + 20}px;top:284px"><span>还没有分配任务</span><small>把阶段目标拆成可交付的工作</small></div>` : ''}${canManage && milestone.status !== 'done' ? `<button type="button" class="flow-add-task" data-action="new-task" data-id="${escape(project.id)}" data-milestone-id="${escape(milestone.id)}" style="left:${x + 20}px;top:${284 + Math.max(children.length, 1) * 114}px">${icons.plus}添加小节点</button>` : ''}`;
  }).join('');

  return `<section class="project-flow" data-project-flow data-flow-canvas><div class="flow-toolbar"><div class="flow-toolbar-title">${icons.branch}<h2>项目流程图</h2><span>${milestones.length} 个大节点<span class="flow-count-divider">/</span>${tasks.length} 个小节点</span><span class="flow-weekly-count${weeklyRequired ? '' : ' is-clear'}">本周待完成 <strong>${weeklyRequired}</strong> 个大节点</span></div><div class="flow-tools"><button type="button" data-flow-control="out" aria-label="缩小流程图" title="缩小">${icons.minus}</button><output class="flow-zoom" aria-live="polite" aria-label="当前缩放">100%</output><button type="button" data-flow-control="in" aria-label="放大流程图" title="放大">${icons.plus}</button><span class="flow-tools-divider"></span><button type="button" class="flow-fit" data-flow-control="fit">${icons.fit}<span>适应画布</span></button></div></div><div class="flow-legend"><div class="flow-node-key"><span class="flow-large-key"></span><span>大节点：每周交付</span><span class="flow-small-key"></span><span>小节点：每日任务</span><span class="flow-line-key">${icons.arrow}</span><span>阶段顺序</span><span class="flow-branch-key"></span><span>所属任务</span></div><div class="flow-status-key"><span class="flow-tone-done"><i></i>完成</span><span class="flow-tone-doing"><i></i>进行中</span><span class="flow-tone-review"><i></i>待验收</span><span class="flow-tone-blocked"><i></i>需关注</span></div></div><div class="flow-scroll" tabindex="0" aria-label="项目流程画布，可横向滚动，点击节点查看详情"><div class="flow-size" style="width:${width}px;height:${height}px"><div class="flow-stage" data-flow-width="${width}" data-flow-height="${height}" style="width:${width}px;height:${height}px"><svg class="flow-connectors" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${paths}</svg>${content}</div></div></div><div class="flow-footer"><span class="flow-pan-hint">拖动画布或横向滚动 · 点击节点查看详情</span><span class="flow-touch-hint">横向滑动查看流程 · 点击节点查看详情</span><span>今天 ${date(day)} · 本周截至 ${date(week.end)} · 大节点验收后计入总进度</span></div>${unassigned.length ? `<div class="flow-unassigned"><strong>尚未归属大节点的任务 · ${unassigned.length}</strong>${unassigned.map(task => `<button type="button" data-action="task-detail" data-id="${escape(task.id)}">${escape(task.title)}${icons.arrow}</button>`).join('')}</div>` : ''}</section>`;
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
