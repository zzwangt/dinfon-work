const escape = value => String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

const checked = (box,key) => [...box.querySelectorAll(`[data-roster="${key}"]:checked`)].map(input=>input.value);

export function readPeople(box) {
  return {memberIds:checked(box,'members'),extraReviewerIds:checked(box,'reviewers')};
}

export function readTaskPeople(box, validate = false) {
  const ownerIds = checked(box,'owners'), reviewerIds = checked(box,'signers');
  if (validate && (!ownerIds.length || !reviewerIds.length)) {
    const group = !ownerIds.length ? 'owners' : 'signers';
    const task = box.closest('[data-plan-task]')?.querySelector('legend')?.textContent || '小任务';
    const message = `${task}：请至少勾选一位${!ownerIds.length ? '负责人' : '验收人'}。`;
    box.dataset.invalidRoster=group;
    box.dataset.rosterMessage=message;
    box.querySelector(`[data-roster="${group}"]:not(:disabled)`)?.focus();
    throw new Error(message);
  }
  return {ownerIds, reviewerIds};
}

function checklist(key, label, candidates, selected, locked, task=false) {
  const unavailable = selected.filter(id=>!candidates.some(person=>person.id===id));
  const options = [...candidates, ...unavailable.map(id=>({id,name:'原选人员已不可用（可取消）'}))];
  const count = task ? ` <small>已选 ${selected.length} 人</small>` : '';
  return `<fieldset class="node-roster-group${task?' task-roster':''}"><legend>${label}${count}</legend>${options.length ? options.map(user => {
    const on = selected.includes(user.id);
    return `<label><input type="checkbox" data-roster="${key}" value="${escape(user.id)}"${on?' checked':''}${locked?' disabled':''}> ${escape(user.name)}</label>`;
  }).join('') : '<small>暂无可选人员</small>'}</fieldset>`;
}

export function peopleFields({stage=false, owner, members, reviewers, ownerIds=[], reviewerIds=[], memberIds=[], extraReviewerIds=[], locked=false}) {
  if (!stage) return checklist('owners','负责人（可多选）',members,ownerIds,locked,true)
    + checklist('signers','验收人（可多选）',reviewers,reviewerIds,false,true);
  const otherReviewers = reviewers.filter(user=>user.id !== owner);
  return checklist('members','大节点负责人（可多选）',members,memberIds,locked,true)
    + checklist('reviewers','其他验收人（可多选）',otherReviewers,extraReviewerIds.filter(id=>id!==owner),false,true);
}

export function updatePeopleBox(box, options) {
  if (!box) return;
  const focus = box.contains(box.ownerDocument.activeElement) ? box.ownerDocument.activeElement : null;
  box.innerHTML = peopleFields(options);
  const group=box.dataset?.invalidRoster;
  if (group && checked(box,group).length) {
    const error=box.closest('form')?.querySelector('.form-error');
    if (error?.textContent===box.dataset.rosterMessage) { error.hidden=true; error.textContent=''; }
    delete box.dataset.invalidRoster; delete box.dataset.rosterMessage;
  }
  if (focus?.dataset.roster) [...box.querySelectorAll('input')].find(input=>input.dataset.roster===focus.dataset.roster && input.value===focus.value)?.focus({preventScroll:true});
}
