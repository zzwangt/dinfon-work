import { isAdminRole } from './roles.js';

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

function checklist(key, label, candidates, selected, locked, {opposite=[], task=false}={}) {
  const unavailable = selected.filter(id=>!candidates.some(person=>person.id===id));
  const options = [...candidates, ...unavailable.map(id=>({id,name:'原选人员已不可用（可取消）'}))];
  const count = task ? ` <small>已选 ${selected.length} 人</small>` : '';
  return `<fieldset class="node-roster-group${task?' task-roster':''}"><legend>${label}${count}</legend>${options.length ? options.map(user => {
    const on = selected.includes(user.id);
    const conflict = !on && user.role !== 'superadmin' && opposite.includes(user.id);
    return `<label${conflict?' title="同一小任务不能由负责人自行验收"':''}><input type="checkbox" data-roster="${key}" value="${escape(user.id)}"${on?' checked':''}${locked || conflict?' disabled':''}> ${escape(user.name)}</label>`;
  }).join('') : '<small>暂无可选人员</small>'}</fieldset>`;
}

export function peopleFields({stage=false, owner, reviewer, members, reviewers, ownerIds=[], reviewerIds=[], memberIds=[], extraReviewerIds=[], locked=false}) {
  if (!stage) return checklist('owners','负责人（可多选）',members,ownerIds,locked,{task:true,opposite:reviewerIds})
    + checklist('signers','验收人（可多选）',reviewers,reviewerIds,false,{task:true,opposite:ownerIds});
  const overlaps = (user, ids) => user.role !== 'superadmin' && ids.includes(user.id);
  const workers = members.filter(u => !overlaps(u,[owner,reviewer,...extraReviewerIds]));
  const signers = reviewers.filter(u => u.id !== reviewer && u.id !== owner && isAdminRole(u.role) && !overlaps(u,memberIds));
  return checklist('members','阶段执行成员（可多选）',workers,memberIds,locked)
    + checklist('reviewers','其他验收人（可多选）',signers,extraReviewerIds,false);
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
