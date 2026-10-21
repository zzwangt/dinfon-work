/**
 * 鼎峰项目协作 · 演示领域模型。
 * 这些权限校验用于本地交互演示；正式环境必须由服务端认证、鉴权和存储。
 */

const ROLES = ['admin', 'manager', 'member'];

export function today() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const read = (key) => parts.find((p) => p.type === key).value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function validDate(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}格式不正确`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`${label}无效`);
  return value;
}

export function addDays(date, n) {
  validDate(date);
  if (!Number.isInteger(n)) throw new Error('天数必须是整数');
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + n);
  return value.toISOString().slice(0, 10);
}

export function weekRange(date = today()) {
  validDate(date);
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  const start = addDays(date, -((day + 6) % 7));
  return { start, end: addDays(start, 6) };
}

function shanghaiDate(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  return new Date(Date.parse(iso) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function text(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`请填写${label}`);
  if (value.trim().length > max) throw new Error(`${label}不能超过 ${max} 字`);
  return value.trim();
}

function optionalText(value, max = 2000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max) throw new Error(`文本长度不能超过 ${max} 字`);
  return value.trim();
}

function uid(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function find(list, id, label) {
  const item = list.find((entry) => entry.id === id);
  if (!item) throw new Error(`${label}不存在`);
  return item;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function manageProject(actor, project) {
  check(actor.role === 'admin' || actor.id === project.ownerId, '仅项目负责人或管理员可以执行此操作');
}

function canChangeTask(actor, task, project) {
  check(actor.role === 'admin' || actor.id === task.ownerId || actor.id === project.ownerId, '只能更新自己负责的任务');
  check(task.status !== 'done', '已验收任务不能直接修改');
  check(task.status !== 'review', '任务正在等待验收，请由验收人处理');
}

function validateSchedule(state, project) {
  validDate(project.startDate, '项目开始日期');
  validDate(project.dueDate, '项目截止日期');
  check(project.startDate <= project.dueDate, '项目截止日期不能早于开始日期');
  const milestones = state.milestones.filter((m) => m.projectId === project.id);
  for (const milestone of milestones) {
    validDate(milestone.dueDate, '节点截止日期');
    check(milestone.dueDate >= project.startDate && milestone.dueDate <= project.dueDate, '节点日期必须位于项目周期内');
  }
  for (const task of state.tasks.filter((t) => t.projectId === project.id)) {
    validDate(task.dueDate, '任务截止日期');
    check(task.dueDate >= project.startDate && task.dueDate <= project.dueDate, '任务截止日期必须位于项目周期内');
    if (task.milestoneId) {
      const milestone = find(milestones, task.milestoneId, '项目节点');
      check(task.dueDate <= milestone.dueDate, `任务“${task.title}”的截止日期不能晚于所属节点`);
    }
  }
}

export function projectProgress(state, projectId) {
  const milestones = state.milestones.filter((m) => m.projectId === projectId);
  const total = milestones.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  if (!total) return 0;
  if (milestones.every((item) => item.status === 'done')) return 100;
  const done = milestones.filter((m) => m.status === 'done').reduce((sum, item) => sum + Number(item.weight || 0), 0);
  return Math.max(0, Math.min(99, Math.round(done / total * 100)));
}

/** All ratios use tasks due within this date window, preserving a comparable cohort. */
export function memberStats(state, userId, start, end) {
  validDate(start, '统计开始日期');
  validDate(end, '统计结束日期');
  check(start <= end, '统计结束日期不能早于开始日期');
  const tasks = state.tasks.filter((task) => task.ownerId === userId && task.dueDate >= start && task.dueDate <= end);
  const due = tasks.length;
  const completed = tasks.filter((task) => task.status === 'done').length;
  const onTime = tasks.filter((task) => task.submittedAt && shanghaiDate(task.submittedAt) <= task.dueDate).length;
  const firstReviewed = tasks.filter((task) => task.reviewCount > 0).length;
  const firstPassed = tasks.filter((task) => task.reviewCount > 0 && task.firstReviewPassed === true).length;
  const rate = (a, b) => b ? Math.round(a / b * 100) : null;
  return { due, completed, onTime, firstReviewed, firstPassed, completionRate: rate(completed, due), onTimeRate: rate(onTime, due), firstPassRate: rate(firstPassed, firstReviewed) };
}

export function transact(state, action, payload = {}, actorId) {
  check(state?.version === 1, '数据版本不兼容，请重新载入演示数据');
  const next = structuredClone(state);
  const actor = find(next.users, actorId, '操作人员');
  const at = new Date().toISOString();
  const record = (projectId, message) => next.logs.unshift({ id: uid('log'), at, actorId, projectId: projectId || null, message });

  if (action === 'createProject') {
    check(actor.role === 'admin' || actor.role === 'manager', '仅管理员或项目负责人可以创建项目');
    const owner = find(next.users, payload.ownerId, '项目负责人');
    check(owner.role === 'manager' || owner.role === 'admin', '项目负责人需要负责人或管理员角色');
    check(actor.role === 'admin' || owner.id === actor.id, '项目负责人只能创建由自己负责的项目');
    const memberIds = [...new Set([owner.id, ...(Array.isArray(payload.memberIds) ? payload.memberIds : [])])];
    memberIds.forEach((id) => find(next.users, id, '项目成员'));
    const project = {
      id: uid('p'), code: `DF-${String(next.projects.length + 1).padStart(3, '0')}`,
      name: text(payload.name, '项目名称', 80), description: optionalText(payload.description),
      category: optionalText(payload.category, 40) || '综合项目', ownerId: owner.id, memberIds,
      startDate: validDate(payload.startDate, '开始日期'), originalDueDate: validDate(payload.dueDate, '截止日期'),
      dueDate: payload.dueDate, color: ['#375fbb', '#9b704a', '#66845b', '#8266a8'][next.projects.length % 4],
    };
    validateSchedule(next, project);
    next.projects.push(project);
    record(project.id, `创建项目“${project.name}”，计划于 ${project.dueDate} 完成`);
  } else if (action === 'createTask') {
    const project = find(next.projects, payload.projectId, '项目');
    manageProject(actor, project);
    const owner = find(next.users, payload.ownerId, '任务负责人');
    const reviewer = find(next.users, payload.reviewerId || project.ownerId, '验收人');
    check(project.memberIds.includes(owner.id), '任务负责人必须是项目组成员');
    check(project.memberIds.includes(reviewer.id) || reviewer.role === 'admin', '验收人必须是项目成员或管理员');
    check(owner.id !== reviewer.id, '任务负责人不能验收自己的任务');
    check(typeof payload.milestoneId === 'string' && payload.milestoneId.length > 0, '请先创建并选择任务所属的里程碑');
    const milestone = find(next.milestones, payload.milestoneId, '节点');
    check(milestone.projectId === project.id, '节点不属于该项目');
    check(milestone.status !== 'done', '已验收节点不能添加任务');
    check(!payload.priority || ['high', 'normal', 'low'].includes(payload.priority), '优先级无效');
    const task = {
      id: uid('t'), projectId: project.id, milestoneId: milestone.id,
      title: text(payload.title, '任务名称', 100), ownerId: owner.id, reviewerId: reviewer.id,
      originalDueDate: validDate(payload.dueDate, '截止日期'), dueDate: payload.dueDate,
      status: 'todo', priority: payload.priority || 'normal', description: optionalText(payload.description),
      acceptance: text(payload.acceptance, '验收标准'), deliverable: '', submittedAt: null,
      reviewedAt: null, reviewCount: 0, firstReviewPassed: null, reviewComment: '', blocker: '',
    };
    next.tasks.push(task);
    validateSchedule(next, project);
    record(project.id, `创建任务“${task.title}”，由 ${owner.name} 负责`);
  } else if (action === 'updateTask') {
    const task = find(next.tasks, payload.id, '任务');
    const project = find(next.projects, task.projectId, '项目');
    canChangeTask(actor, task, project);
    if (payload.status != null) {
      check(['todo', 'doing', 'blocked'].includes(payload.status), '任务必须提交成果并通过验收后才能完成');
      task.status = payload.status;
    }
    if (payload.description != null) task.description = optionalText(payload.description);
    if (payload.blocker != null) task.blocker = optionalText(payload.blocker);
    if (task.status === 'blocked') task.blocker = text(task.blocker, '阻塞原因');
    else task.blocker = '';
    record(project.id, `更新任务“${task.title}”${task.status === 'blocked' ? `，阻塞原因：${task.blocker}` : ''}`);
  } else if (action === 'submitTask') {
    const task = find(next.tasks, payload.id, '任务');
    check(actor.id === task.ownerId || actor.role === 'admin', '仅任务负责人或管理员可以提交成果');
    check(['todo', 'doing', 'blocked'].includes(task.status), '该任务已提交或已完成');
    task.deliverable = text(payload.deliverable, '成果说明或链接', 4000);
    task.submittedAt = at;
    task.status = 'review';
    task.blocker = '';
    record(task.projectId, `提交任务“${task.title}”的成果，等待验收`);
  } else if (action === 'reviewTask') {
    const task = find(next.tasks, payload.id, '任务');
    check(actor.role === 'admin' || actor.id === task.reviewerId, '仅指定验收人或管理员可以验收任务');
    check(actor.id !== task.ownerId, '不能验收自己负责的任务');
    check(task.status === 'review', '仅待验收任务可以进行验收');
    check(typeof payload.approve === 'boolean', '请选择通过或退回');
    const comment = payload.approve ? optionalText(payload.comment) : text(payload.comment, '退回原因');
    if (task.reviewCount === 0) task.firstReviewPassed = payload.approve;
    task.reviewCount += 1;
    task.reviewedAt = at;
    task.reviewComment = comment;
    task.status = payload.approve ? 'done' : 'doing';
    record(task.projectId, `${payload.approve ? '验收通过' : '退回修改'}：“${task.title}”${comment ? `；${comment}` : ''}`);
  } else if (action === 'createMilestone') {
    const project = find(next.projects, payload.projectId, '项目');
    manageProject(actor, project);
    const weight = Number(payload.weight);
    check(Number.isFinite(weight) && weight > 0 && weight <= 100, '节点权重必须大于 0 且不超过 100');
    const milestone = {
      id: uid('m'), projectId: project.id, title: text(payload.title, '节点名称', 100),
      originalDueDate: validDate(payload.dueDate, '节点截止日期'), dueDate: payload.dueDate,
      weight, status: 'pending', acceptedAt: null,
    };
    next.milestones.push(milestone);
    validateSchedule(next, project);
    record(project.id, `创建节点“${milestone.title}”，权重 ${weight}`);
  } else if (action === 'completeMilestone') {
    const milestone = find(next.milestones, payload.id, '节点');
    const project = find(next.projects, milestone.projectId, '项目');
    manageProject(actor, project);
    check(milestone.status !== 'done', '节点已验收');
    const tasks = next.tasks.filter((task) => task.milestoneId === milestone.id);
    check(tasks.length > 0, '请先为节点添加任务和交付物');
    check(tasks.every((task) => task.status === 'done'), '节点下所有任务通过验收后才可完成节点');
    milestone.status = 'done';
    milestone.acceptedAt = at;
    record(project.id, `验收完成节点“${milestone.title}”`);
  } else if (action === 'requestExtension') {
    const project = find(next.projects, payload.projectId, '项目');
    manageProject(actor, project);
    check(!next.extensions.some((item) => item.projectId === project.id && item.status === 'pending'), '该项目已有待审批的延期申请');
    const newDueDate = validDate(payload.newDueDate, '申请截止日期');
    check(newDueDate > project.dueDate, '申请日期必须晚于当前截止日期');
    check(newDueDate >= today(), '申请截止日期不能早于今天');
    const prepareAdjustments = (value, collection, label) => {
      check(value == null || Array.isArray(value), `${label}调整列表无效`);
      const adjustments = value || [];
      check(new Set(adjustments.map((item) => item.id)).size === adjustments.length, `${label}调整不能重复`);
      return adjustments.map((item) => {
        const target = find(collection, item.id, label);
        check(target.projectId === project.id, `${label}不属于该项目`);
        check(target.status !== 'done', `已完成的${label}不能延期`);
        const dueDate = validDate(item.newDueDate, `${label}调整日期`);
        check(dueDate > target.dueDate, `${label}调整日期必须晚于当前日期`);
        check(dueDate <= newDueDate, `${label}调整日期不能晚于项目新截止日期`);
        return { id: target.id, newDueDate: dueDate };
      });
    };
    const affectedMilestones = prepareAdjustments(payload.affectedMilestones, next.milestones, '节点');
    const affectedTasks = prepareAdjustments(payload.affectedTasks, next.tasks, '任务');
    // Validate the proposed schedule on a separate copy; pending requests never alter live dates.
    const proposed = structuredClone(next);
    const proposedProject = find(proposed.projects, project.id, '项目');
    proposedProject.dueDate = newDueDate;
    affectedMilestones.forEach((item) => { find(proposed.milestones, item.id, '节点').dueDate = item.newDueDate; });
    affectedTasks.forEach((item) => { find(proposed.tasks, item.id, '任务').dueDate = item.newDueDate; });
    validateSchedule(proposed, proposedProject);
    const extension = {
      id: uid('e'), projectId: project.id, applicantId: actor.id, originalDueDate: project.dueDate,
      newDueDate, reason: text(payload.reason, '延期原因'), plan: text(payload.plan, '后续安排'),
      impact: text(payload.impact, '影响范围'), status: 'pending', affectedMilestones, affectedTasks,
      createdAt: at, reviewedAt: null, reviewerId: null, comment: '',
    };
    next.extensions.unshift(extension);
    record(project.id, `申请项目延期：${project.dueDate} → ${newDueDate}；待后台审批，当前计划保持生效`);
  } else if (action === 'reviewExtension') {
    check(actor.role === 'admin', '仅后台管理员可以审批延期');
    const extension = find(next.extensions, payload.id, '延期申请');
    check(actor.id !== extension.applicantId, '不能审批自己提交的延期申请，请由其他管理员处理');
    check(extension.status === 'pending', '该延期申请已处理');
    check(typeof payload.approve === 'boolean', '请选择批准或驳回');
    const comment = text(payload.comment, payload.approve ? '审批意见' : '驳回原因');
    const project = find(next.projects, extension.projectId, '项目');
    if (payload.approve) {
      check(project.dueDate === extension.originalDueDate, '项目计划已变化，请重新提交延期申请');
      check(extension.newDueDate >= today(), '申请的新截止日期已经过去，请驳回后重新申请');
      project.dueDate = extension.newDueDate;
      for (const item of extension.affectedMilestones) {
        const target = find(next.milestones, item.id, '节点');
        check(target.projectId === project.id && target.status !== 'done', '相关节点已完成或变更，请重新申请');
        target.dueDate = item.newDueDate;
      }
      for (const item of extension.affectedTasks) {
        const target = find(next.tasks, item.id, '任务');
        check(target.projectId === project.id && target.status !== 'done', '相关任务已完成或变更，请重新申请');
        target.dueDate = item.newDueDate;
      }
      validateSchedule(next, project);
    }
    extension.status = payload.approve ? 'approved' : 'rejected';
    extension.reviewedAt = at;
    extension.reviewerId = actor.id;
    extension.comment = comment;
    record(project.id, `${payload.approve ? '批准' : '驳回'}项目延期申请${payload.approve ? `，当前截止日期调整为 ${project.dueDate}，保留原计划 ${project.originalDueDate}` : '，原计划继续生效'}；${comment}`);
  } else if (action === 'addUser') {
    check(actor.role === 'admin', '仅管理员可以添加成员');
    check(ROLES.includes(payload.role), '成员角色无效');
    const user = {
      id: uid('u'), name: text(payload.name, '姓名', 30), title: text(payload.title, '岗位', 60),
      department: text(payload.department, '部门', 60), role: payload.role,
      color: ['#52756e', '#526ba0', '#977951', '#8a6e9b'][next.users.length % 4],
    };
    next.users.push(user);
    record(null, `添加成员 ${user.name} · ${user.department}`);
  } else {
    throw new Error('不支持的操作');
  }
  return next;
}

export function createSeedState() {
  const now = today();
  const d = (n) => addDays(now, n);
  const at = (n, hour = '09') => `${d(n)}T${hour}:00:00+08:00`;
  const users = [
    { id: 'u-admin', name: '周予安', role: 'admin', title: '运营总监', department: '管理中心', color: '#546a98' },
    { id: 'u-manager', name: '陈亦舟', role: 'manager', title: '项目负责人', department: '项目管理', color: '#94784e' },
    { id: 'u-engineer', name: '林知远', role: 'member', title: '硬件工程师', department: '产品研发', color: '#4e7b72' },
    { id: 'u-design', name: '许知夏', role: 'member', title: '设计师', department: '品牌设计', color: '#a17169' },
    { id: 'u-ops', name: '方以宁', role: 'manager', title: '交付负责人', department: '运营交付', color: '#81709d' },
    { id: 'u-qa', name: '陆景和', role: 'member', title: '测试工程师', department: '质量管理', color: '#65825c' },
  ];
  const projects = [
    { id: 'p-mower', code: 'DF-001', name: '智能割草机器人 · 样机验证', description: '完成样机的场景测试与问题闭环，形成可验收的验证报告。此项目与成员均为演示数据。', category: '产品研发', ownerId: 'u-manager', memberIds: ['u-manager', 'u-engineer', 'u-design', 'u-qa'], startDate: d(-25), originalDueDate: d(12), dueDate: d(12), color: '#557658' },
    { id: 'p-pcb', code: 'DF-002', name: '电子控制板 · 研发交付', description: '完成控制板设计评审、样板联调和交付资料归档。演示项目。', category: '电子研发', ownerId: 'u-manager', memberIds: ['u-manager', 'u-engineer', 'u-qa'], startDate: d(-20), originalDueDate: d(7), dueDate: d(7), color: '#a4804d' },
    { id: 'p-site', code: 'DF-003', name: '品牌官网 · 内容与体验升级', description: '完善品牌内容、页面设计和响应式体验，完成内部验收。演示项目。', category: '品牌建设', ownerId: 'u-manager', memberIds: ['u-manager', 'u-design', 'u-ops'], startDate: d(-18), originalDueDate: d(5), dueDate: d(5), color: '#677cad' },
    { id: 'p-delivery', code: 'DF-004', name: '交付流程 · 标准化试运行', description: '明确项目交接标准、责任人与异常处理流程，完成一轮试运行。演示项目。', category: '运营管理', ownerId: 'u-ops', memberIds: ['u-ops', 'u-manager', 'u-qa'], startDate: d(-30), originalDueDate: d(-2), dueDate: d(6), color: '#8a749b' },
  ];
  const milestones = [
    { id: 'm-mower-1', projectId: 'p-mower', title: '测试方案与准备', weight: 25, due: -10, done: true },
    { id: 'm-mower-2', projectId: 'p-mower', title: '核心场景测试', weight: 40, due: 3 },
    { id: 'm-mower-3', projectId: 'p-mower', title: '问题闭环与报告验收', weight: 35, due: 12 },
    { id: 'm-pcb-1', projectId: 'p-pcb', title: '设计评审通过', weight: 35, due: -7, done: true },
    { id: 'm-pcb-2', projectId: 'p-pcb', title: '样板联调完成', weight: 40, due: 2 },
    { id: 'm-pcb-3', projectId: 'p-pcb', title: '交付资料验收', weight: 25, due: 7 },
    { id: 'm-site-1', projectId: 'p-site', title: '内容结构确认', weight: 25, due: -8, done: true },
    { id: 'm-site-2', projectId: 'p-site', title: '视觉方案通过', weight: 35, due: -2, done: true },
    { id: 'm-site-3', projectId: 'p-site', title: '页面体验验收', weight: 40, due: 5 },
    { id: 'm-delivery-1', projectId: 'p-delivery', title: '交接标准确认', weight: 30, due: -15, done: true },
    { id: 'm-delivery-2', projectId: 'p-delivery', title: '流程模板验收', weight: 35, due: -8, done: true },
    { id: 'm-delivery-3', projectId: 'p-delivery', title: '试运行复盘完成', weight: 35, due: 6, original: -2 },
  ].map(({ due, original, done, ...m }) => ({ ...m, originalDueDate: d(original ?? due), dueDate: d(due), status: done ? 'done' : 'pending', acceptedAt: done ? at(due) : null }));
  const seeds = [
    ['t-01', 'p-mower', 'm-mower-1', '整理样机场景测试清单', 'u-qa', -11, 'done', 'normal'],
    ['t-02', 'p-mower', 'm-mower-2', '完成坡地行走连续测试', 'u-qa', 0, 'doing', 'high'],
    ['t-03', 'p-mower', 'm-mower-2', '排查避障传感器误触发', 'u-engineer', -1, 'blocked', 'high'],
    ['t-04', 'p-mower', 'm-mower-2', '提交样机外观细节检查', 'u-design', 1, 'review', 'normal'],
    ['t-05', 'p-mower', 'm-mower-3', '汇总样机问题闭环报告', 'u-qa', 10, 'todo', 'normal'],
    ['t-06', 'p-pcb', 'm-pcb-1', '完成控制板原理图评审', 'u-engineer', -8, 'done', 'high'],
    ['t-07', 'p-pcb', 'm-pcb-2', '联调电机控制接口', 'u-engineer', 0, 'doing', 'high'],
    ['t-08', 'p-pcb', 'm-pcb-2', '执行样板上电测试', 'u-qa', 2, 'todo', 'high'],
    ['t-09', 'p-pcb', 'm-pcb-3', '整理版本及交付文件', 'u-engineer', 7, 'todo', 'normal'],
    ['t-10', 'p-site', 'm-site-1', '确认官网信息结构', 'u-design', -9, 'done', 'normal'],
    ['t-11', 'p-site', 'm-site-2', '提交首页视觉方案', 'u-design', -2, 'done', 'normal'],
    ['t-12', 'p-site', 'm-site-3', '补齐产品页内容与图片', 'u-ops', 0, 'review', 'normal'],
    ['t-13', 'p-site', 'm-site-3', '检查移动端阅读体验', 'u-design', 3, 'doing', 'normal'],
    ['t-14', 'p-site', 'm-site-3', '汇总上线前检查意见', 'u-ops', 5, 'todo', 'low'],
    ['t-15', 'p-delivery', 'm-delivery-1', '梳理项目交接责任表', 'u-manager', -16, 'done', 'normal'],
    ['t-16', 'p-delivery', 'm-delivery-2', '确认交付验收记录模板', 'u-qa', -9, 'done', 'normal'],
    ['t-17', 'p-delivery', 'm-delivery-3', '完成首轮交接演练', 'u-qa', 1, 'doing', 'high'],
    ['t-18', 'p-delivery', 'm-delivery-3', '提交试运行复盘与修订', 'u-manager', 6, 'todo', 'normal'],
  ];
  const tasks = seeds.map(([id, projectId, milestoneId, title, ownerId, due, status, priority]) => {
    const reviewed = status === 'done';
    const submitted = reviewed || status === 'review';
    return {
      id, projectId, milestoneId, title, ownerId,
      reviewerId: projectId === 'p-delivery' ? 'u-ops' : 'u-manager',
      originalDueDate: d(id === 't-17' ? -3 : id === 't-18' ? -2 : due), dueDate: d(due), status, priority,
      description: '按约定范围推进，相关讨论与最终成果请记录在任务内。此记录用于功能演示。',
      acceptance: '提交完整记录与成果说明，由指定验收人确认内容完整、问题已说明。',
      deliverable: submitted ? '已提交演示成果说明，关键检查项已完成，待负责人确认。' : '',
      submittedAt: submitted ? at(Math.min(due, -1)) : null,
      reviewedAt: reviewed ? at(due, '15') : null, reviewCount: reviewed ? (id === 't-11' ? 2 : 1) : 0,
      firstReviewPassed: reviewed ? id !== 't-11' : null, reviewComment: reviewed ? '演示成果已达到当前验收标准。' : '',
      blocker: status === 'blocked' ? '等待替换传感器到货，已联系供应商确认时间。' : '',
    };
  });
  const extensions = [
    { id: 'e-pending', projectId: 'p-pcb', applicantId: 'u-manager', originalDueDate: d(7), newDueDate: d(12), reason: '关键连接器交期调整，样板联调需要顺延。', plan: '先完成可独立测试的模块，物料到齐后集中联调并补齐交付文件。', impact: '样板联调与资料交付节点顺延，其他项目暂不受影响。', status: 'pending', affectedMilestones: [{ id: 'm-pcb-2', newDueDate: d(7) }, { id: 'm-pcb-3', newDueDate: d(12) }], affectedTasks: [{ id: 't-07', newDueDate: d(5) }, { id: 't-08', newDueDate: d(7) }, { id: 't-09', newDueDate: d(12) }], createdAt: at(-1, '14'), reviewedAt: null, reviewerId: null, comment: '' },
    { id: 'e-approved', projectId: 'p-delivery', applicantId: 'u-ops', originalDueDate: d(-2), newDueDate: d(6), reason: '试运行增加一轮跨部门交接演练。', plan: '补充演练记录后再完成复盘验收。', impact: '仅调整试运行节点及两项关联任务。', status: 'approved', affectedMilestones: [{ id: 'm-delivery-3', newDueDate: d(6) }], affectedTasks: [{ id: 't-17', newDueDate: d(1) }, { id: 't-18', newDueDate: d(6) }], createdAt: at(-6), reviewedAt: at(-5, '14'), reviewerId: 'u-admin', comment: '同意增加一轮验证，请按调整后的计划完成。' },
  ];
  const logs = [
    { id: 'l-1', at: at(-1, '16'), actorId: 'u-design', projectId: 'p-mower', message: '提交“样机外观细节检查”，等待验收' },
    { id: 'l-2', at: at(-1, '14'), actorId: 'u-manager', projectId: 'p-pcb', message: '提交项目延期申请，申请顺延 5 天，等待后台审批' },
    { id: 'l-3', at: at(-2, '15'), actorId: 'u-manager', projectId: 'p-site', message: '验收通过“首页视觉方案”，视觉方案节点完成' },
    { id: 'l-4', at: at(-5, '14'), actorId: 'u-admin', projectId: 'p-delivery', message: '批准试运行延期 8 天，同步调整关联任务；原计划保留' },
  ];
  return { version: 1, users, projects, milestones, tasks, extensions, logs };
}
