import { isAdminRole } from './roles.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

export function readPeople(box) {
  const ids = key => [...box.querySelectorAll(`[data-roster="${key}"]:checked`)].map(input=>input.value);
  return {memberIds:ids('members'),extraReviewerIds:ids('reviewers')};
}

function checklist(key, label, candidates, selected, locked) {
  const unavailable = selected.filter(id=>!candidates.some(person=>person.id===id));
  const options = [...candidates, ...unavailable.map(id=>({id,name:'原选人员已不可用（可取消）'}))];
  return `<fieldset class="node-roster-group"><legend>${label}</legend>${options.length ? options.map(user =>
    `<label><input type="checkbox" data-roster="${key}" value="${escape(user.id)}"${selected.includes(user.id)?' checked':''}${locked?' disabled':''}> ${escape(user.name)}</label>`).join('') : '<small>暂无其他可选人员</small>'}</fieldset>`;
}

export function peopleFields({stage=false, owner, reviewer, members, reviewers, memberIds=[], extraReviewerIds=[], locked=false}) {
  const overlaps = (user, ids) => user.role !== 'superadmin' && ids.includes(user.id);
  const workers = members.filter(u => (stage || u.id !== owner) && !overlaps(u,[...(stage?[owner]:[]),reviewer,...extraReviewerIds]));
  const signers = reviewers.filter(u => u.id !== reviewer && (!stage || (u.id !== owner && isAdminRole(u.role))) && !overlaps(u,[...memberIds,...(stage?[]:[owner])]));
  return checklist('members',stage?'阶段执行成员（可多选）':'协作成员（可多选）',workers,memberIds,locked)
    + checklist('reviewers','其他验收人（可多选）',signers,extraReviewerIds,false);
}

export function updatePeopleBox(box, options) {
  if (!box) return;
  const focus = box.contains(document.activeElement) ? document.activeElement : null;
  box.innerHTML = peopleFields(options);
  if (focus?.dataset.roster) [...box.querySelectorAll('input')].find(input=>input.dataset.roster===focus.dataset.roster && input.value===focus.value)?.focus({preventScroll:true});
}
