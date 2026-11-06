import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalWorkspace } from './acceptance-fixture.mjs';
import { transact, nodeExtensionPlan } from '../public/client/domain.js';
const at=day=>`2099-01-${String(day).padStart(2,'0')}T18:00`;
const get=(s,type,id)=>s[type].find(x=>x.id===id);
function fixture() {
  const s=createApprovalWorkspace();s.extensions=[];
  const p=get(s,'projects','p-mower');p.startDate='2099-01-01';p.dueDate=p.originalDueDate=at(10);
  for(const m of s.milestones.filter(x=>x.projectId===p.id)){m.dueDate=m.originalDueDate=at(7);m.status='pending';}
  for(const t of s.tasks.filter(x=>x.projectId===p.id)){t.dueDate=t.originalDueDate=at(3);t.status='doing';}
  return s;
}
const input=(more={})=>({projectId:'p-mower',targetType:'task',targetId:'t-03',newDueDate:at(5),plan:'完成复测',impact:'本节点顺延',reason:'',...more});
const submit=(s,more={},actor='u-engineer')=>transact(s,'requestExtension',input(more),actor);
const review=(s,approve=true,actor='u-manager')=>transact(s,'reviewExtension',{id:s.extensions[0].id,approve},actor);
const plan=s=>({projects:s.projects,milestones:s.milestones,tasks:s.tasks});

test('task extension within its stage leaves parents and all live dates unchanged until approval',()=>{
  const s=fixture(),before=structuredClone(s),pending=submit(s),x=pending.extensions[0];
  assert.deepEqual(s,before);assert.deepEqual(plan(pending),plan(s));
  assert.equal(x.targetTitle,get(s,'tasks','t-03').title);assert.equal(x.newDueDate,at(10));
  assert.deepEqual(x.affectedMilestones,[]);assert.deepEqual(x.affectedTasks,[{id:'t-03',originalDueDate:at(3),newDueDate:at(5)}]);
  const done=review(pending);assert.equal(get(done,'tasks','t-03').dueDate,at(5));
  assert.equal(get(done,'tasks','t-03').originalDueDate,at(3));
  assert.deepEqual(done.milestones,s.milestones);assert.deepEqual(done.projects,s.projects);
  assert.deepEqual(done.tasks.filter(t=>t.id!=='t-03'),s.tasks.filter(t=>t.id!=='t-03'));
  assert.equal(done.extensions[0].status,'approved');
});

test('only the necessary parent dates extend, retaining all original baselines',()=>{
  for(const day of [8,12]) {
    const s=fixture(),pending=submit(s,{newDueDate:at(day)}),x=pending.extensions[0];
    assert.equal(x.affectedMilestones.length,1);assert.equal(x.affectedMilestones[0].id,'m-mower-2');
    assert.equal(x.newDueDate,at(Math.max(10,day)));const done=review(pending);
    assert.equal(get(done,'milestones','m-mower-2').dueDate,at(day));
    assert.equal(get(done,'milestones','m-mower-2').originalDueDate,at(7));
    assert.equal(get(done,'projects','p-mower').originalDueDate,at(10));
    assert.equal(get(done,'tasks','t-02').dueDate,at(3));
  }
});

test('major-node extensions do not move child tasks and rejection never changes dates',()=>{
  const s=fixture(),pending=submit(s,{targetType:'milestone',targetId:'m-mower-2',newDueDate:at(8)});
  assert.equal(pending.extensions[0].affectedTasks.length,0);
  assert.deepEqual(review(pending).tasks,s.tasks);
  const rejected=review(pending,false);assert.deepEqual(plan(rejected),plan(s));
  assert.equal(rejected.extensions[0].status,'rejected');
});

test('node extension rejects wrong projects, done nodes, backwards dates and duplicate pending applications',()=>{
  const s=fixture();
  for(const patch of [{targetId:'absent'},{targetId:'t-06'},{targetType:'unknown'},{newDueDate:at(2)}])assert.throws(()=>submit(s,patch));
  get(s,'tasks','t-03').status='done';assert.throws(()=>submit(s),/已完成/);
  get(s,'tasks','t-03').status='doing';get(s,'milestones','m-mower-2').status='done';assert.throws(()=>submit(s),/大节点已完成/);
  const pending=submit(fixture());assert.throws(()=>submit(pending),/已有待审批/);
  assert.throws(()=>submit(fixture(),{},'u-ops'),/无权访问/);
});

test('node dates and ancestry are rechecked on approval without partial writes',()=>{
  for(const mutate of [
    s=>{get(s,'tasks','t-03').dueDate=at(4);},
    s=>{get(s,'tasks','t-03').milestoneId='m-mower-3';},
    s=>{get(s,'milestones','m-mower-2').dueDate=at(8);},
    s=>{get(s,'projects','p-mower').dueDate=at(11);},
    s=>{get(s,'tasks','t-03').status='done';},
  ]) {
    const pending=submit(fixture(),{newDueDate:at(12)});mutate(pending);const before=structuredClone(pending);
    assert.throws(()=>review(pending));assert.deepEqual(pending,before);
    assert.equal(review(pending,false).extensions[0].status,'rejected');
  }
});

test('node extension retains owner approval and self-approval restrictions',()=>{
  const s=fixture();get(s,'users','u-qa').role='admin';
  const pending=submit(s);assert.throws(()=>review(pending,true,'u-qa'),/仅项目负责人/);
  assert.throws(()=>review(submit(s,{},'u-manager')),/不能审批自己/);
  assert.equal(review(submit(s,{},'u-admin'),true,'u-admin').extensions[0].status,'approved');
});

test('server derives affected nodes rather than trusting caller-supplied changes',()=>{
  const s=fixture(),pending=submit(s,{newDueDate:at(12),affectedTasks:[{id:'t-06',newDueDate:at(30)}],affectedMilestones:[],targetTitle:'forged'});
  assert.deepEqual(pending.extensions[0].affectedTasks.map(t=>t.id),['t-03']);
  assert.equal(pending.extensions[0].affectedMilestones[0].id,'m-mower-2');
  assert.equal(pending.extensions[0].targetTitle,get(s,'tasks','t-03').title);
  assert.equal(nodeExtensionPlan(s,input({newDueDate:at(12)})).newDueDate,at(12));
});
