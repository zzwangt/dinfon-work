import { readPeople, readTaskPeople, updatePeopleBox } from './node-people.js';
import { taskOwners, taskReviewers, stageReviewers } from './approval-access.js';
import { formatDateTime, toDateTimeInput } from './time.js';

const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const input = (label, key, type, required = true, value = '') =>
  `<label class="field"><span>${label}</span><input data-key="${key}" type="${type}" value="${html(value)}" ${required ? 'required' : ''} ${type === 'datetime-local' ? 'step="3600"' : 'maxlength="100"'}></label>`;
const note = (label, key, required, value) =>
  `<label class="field full"><span>${label}</span><textarea data-key="${key}" rows="2" maxlength="2000" ${required ? 'required' : ''}>${html(value)}</textarea></label>`;
const control = (name, label) => `<button type="button" class="button secondary small" data-plan-control="${name}">${label}</button>`;
const part = (parent, key) => parent.querySelector(`[data-key="${key}"]`);
const values = row => {
  const box = row.querySelector(':scope > .form-grid .node-people');
  return {...(row.hasAttribute('data-plan-task') ? readTaskPeople(box,true) : readPeople(box)),
    ...Object.fromEntries([...row.querySelectorAll(':scope > .form-grid [data-key]')].map(el => [el.dataset.key, el.value]))};
};

export const planEditor = `<section class="plan-editor"><div class="plan-toolbar"><h3>项目流程</h3><span class="muted" data-plan-count aria-live="polite"></span></div><div data-plan-stages></div>${control('add-stage','＋ 添加大节点')}</section>`;

export function readPlanStages(form) {
  return [...form.querySelectorAll('[data-plan-stage]')].map(stage => ({
    ...values(stage), tasks: [...stage.querySelectorAll('[data-plan-task]')].map(values),
  }));
}

export function bindPlanEditor(form, users, prior) {
  if (!form) return;
  const stages = form.querySelector('[data-plan-stages]');
  const projectEnd = () => form.elements.dueDate.value;
  const dueInput = date => toDateTimeInput(date, '18:00');
  function updateStage(stage, stored) {
    const owner=form.elements.ownerId.value;
    const box=stage.querySelector(':scope > .form-grid .node-people');
    const selection=stored ? {memberIds:stored.memberIds || [],extraReviewerIds:stageReviewers(stored)} : readPeople(box);
    updatePeopleBox(box,{...selection,stage:true,owner,members:users,reviewers:users});
    const due = part(stage, 'dueDate');
    due.min = form.elements.startDate.value;
    due.max = projectEnd();
    for (const task of stage.querySelectorAll('[data-plan-task]')) {
      part(task, 'dueDate').min = due.min;
      part(task, 'dueDate').max = due.value || due.max;
    }
  }
  function count() {
    const cards = [...stages.children];
    let total = 0;
    cards.forEach((stage, i) => {
      stage.querySelector('legend').textContent = `大节点 ${i + 1}`;
      stage.querySelectorAll('[data-plan-task]').forEach((task, j) => {
        task.querySelector('legend').textContent = `小任务 ${i + 1}.${j + 1}`;
        total++;
      });
    });
    form.querySelector('[data-plan-count]').textContent = `${cards.length} 个大节点 · ${total} 项小任务`;
  }
  function addTask(stage, task = {}) {
    const list = stage.querySelector('[data-plan-tasks]');
    list.insertAdjacentHTML('beforeend', `<fieldset data-plan-task><legend></legend><div class="form-grid">
      ${input('任务名称','title','text',true,task.title)}${input('任务截止时间','dueDate','datetime-local',true,dueInput(task.dueDate) || part(stage,'dueDate').value)}
      <div class="node-people"></div>${note('验收标准','acceptance',true,task.acceptance)}${note('任务说明（选填）','description',false,task.description)}
      </div>${control('remove-task','移除小任务')}</fieldset>`);
    const row = list.lastElementChild;
    updateStage(stage);
    updatePeopleBox(row.querySelector('.node-people'),{ownerIds:taskOwners(task),reviewerIds:taskReviewers(task),members:users,reviewers:users});
    return row;
  }
  function addStage(stage = {}) {
    stages.insertAdjacentHTML('beforeend', `<fieldset data-plan-stage><legend></legend><div class="form-grid">
      ${input('大节点名称','title','text',true,stage.title)}${input('节点截止时间','dueDate','datetime-local',true,dueInput(stage.dueDate) || projectEnd())}
      <span class="field-help full">项目负责人必签，可加选其他验收人。</span><div class="node-people"></div>${note('阶段交付说明（选填）','description',false,stage.description)}
      </div><div data-plan-tasks></div><div class="plan-controls">${control('add-task','＋ 添加小任务')}${control('remove-stage','移除大节点')}</div></fieldset>`);
    const card = stages.lastElementChild;
    updateStage(card, stage);
    return card;
  }
  for (const milestone of prior?.milestones || []) {
    const stage = addStage(milestone);
    for (const task of prior.tasks.filter(item => item.milestoneId === milestone.id)) addTask(stage, task);
  }
  count();
  form.addEventListener('click', event => {
    const button = event.target.closest('[data-plan-control]');
    if (!button) return;
    const stage = button.closest('[data-plan-stage]');
    switch (button.dataset.planControl) {
      case 'add-stage': part(addStage(), 'title').focus(); break;
      case 'add-task': part(addTask(stage), 'title').focus(); break;
      case 'remove-stage':
        if (stage.querySelector('[data-plan-task]') && !window.confirm('移除这个大节点及其全部小任务？')) return;
        stage.remove(); break;
      case 'remove-task': button.closest('[data-plan-task]').remove(); break;
    }
    count();
  });
  form.addEventListener('change', event => {
    const el = event.target;
    if (['ownerId','startDate','dueDate'].includes(el.name)) {
      for (const stage of stages.children) updateStage(stage);
    } else if (el.dataset.roster && el.closest('[data-plan-task]')) {
      const box=el.closest('.node-people');
      updatePeopleBox(box,{...readTaskPeople(box),members:users,reviewers:users});
    } else if (el.dataset.key === 'dueDate' || el.dataset.roster) {
      updateStage(el.closest('[data-plan-stage]'));
    }
  });
}

export function planContents(plan, users) {
  const person = id => html(users.find(user => user.id === id)?.name || '未关联人员');
  const p = plan.project;
  const when = value => html(formatDateTime(value));
  return `<div class="plan-preview"><p>项目负责人 <strong>${person(p.ownerId)}</strong> · ${html(p.category)}</p><p>项目成员　${p.memberIds.map(person).join('、')}</p>
    <p>${when(p.startDate)} 至 ${when(p.dueDate)}</p>${p.description ? `<p>${html(p.description)}</p>` : ''}
    ${plan.milestones.map((m,i) => `<section><h4>${i+1}. ${html(m.title)}</h4><p>${when(m.dueDate)} 截止${m.memberIds?.length?' · 执行 '+m.memberIds.map(person).join('、'):''}${stageReviewers(m).length ? ' · 加验 '+stageReviewers(m).map(person).join('、') : ''}</p>
      ${m.description ? `<p>${html(m.description)}</p>` : ''}
      <ol>${plan.tasks.filter(t => t.milestoneId === m.id).map(t => `<li><strong>${html(t.title)}</strong><p>${taskOwners(t).map(person).join('、')} 负责 · ${taskReviewers(t).map(person).join('、')} 验收 · ${when(t.dueDate)} 截止</p>
      <p>验收标准　${html(t.acceptance)}</p>${t.description ? `<p>${html(t.description)}</p>` : ''}</li>`).join('')}</ol></section>`).join('')}</div>`;
}
