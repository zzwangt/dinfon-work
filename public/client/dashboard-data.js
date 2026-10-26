import { memberStats, progressAgainstPlan, weekRange } from './domain.js';
import { datePart, deadlineMs, isOverdue, startMs } from './time.js';

const records = (value) => Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
const deadlineOrder = (a, b) => {
  const first = deadlineMs(a.dueDate);
  const second = deadlineMs(b.dueDate);
  if (!Number.isFinite(first)) return Number.isFinite(second) ? 1 : 0;
  if (!Number.isFinite(second)) return -1;
  return first - second;
};

/**
 * Read-only dashboard view of the caller's already-authorized business state.
 * People share one denominator: tasks due this week by `now`, inclusive.
 * `pendingReview` uses that same cohort; `weeklyTotal` and `notDue` describe the
 * whole week's current approved plan. No historical deadline is substituted.
 */
export function dashboardData(state, now = Date.now()) {
  const instant = typeof now === 'number' && Number.isFinite(new Date(now).getTime()) ? now : Date.now();
  const week = weekRange(datePart(new Date(instant).toISOString()));
  const weekStart = startMs(week.start);
  const weekEnd = deadlineMs(week.end);
  const users = records(state?.users);
  const projectRecords = records(state?.projects);
  const milestones = records(state?.milestones);
  const tasks = records(state?.tasks);
  const userById = new Map(users.map((user) => [user.id, user]));
  const projectById = new Map(projectRecords.map((project) => [project.id, project]));

  const projects = projectRecords.map((project) => {
    const nodes = milestones.filter((item) => item.projectId === project.id).sort(deadlineOrder);
    const projectTasks = tasks.filter((item) => item.projectId === project.id);
    return { project, metrics: progressAgainstPlan(projectTasks, instant), milestones: nodes, owner: userById.get(project.ownerId) || null };
  });

  const required = milestones
    .filter((milestone) => projectById.has(milestone.projectId) && milestone.status !== 'done' && deadlineMs(milestone.dueDate) <= weekEnd)
    .sort(deadlineOrder)
    .map((milestone) => {
      const project = projectById.get(milestone.projectId);
      const children = tasks.filter((task) => task.projectId === project.id && task.milestoneId === milestone.id);
      return {
        milestone, project, owner: userById.get(project.ownerId) || null,
        completedTasks: children.filter((task) => task.status === 'done').length,
        totalTasks: children.length, overdue: isOverdue(milestone.dueDate, instant),
        carryover: deadlineMs(milestone.dueDate) < weekStart,
      };
    });

  const weeklyTasks = tasks.filter((task) => projectById.has(task.projectId) && deadlineMs(task.dueDate) >= weekStart && deadlineMs(task.dueDate) <= weekEnd);
  const dueTasks = weeklyTasks.filter((task) => deadlineMs(task.dueDate) <= instant);
  const statsState = { tasks: dueTasks };
  const people = users.map((user) => {
    const planned = weeklyTasks.filter((task) => task.ownerId === user.id);
    return {
      user, stats: memberStats(statsState, user.id, week.start, week.end),
      weeklyTotal: planned.length,
      notDue: planned.filter((task) => deadlineMs(task.dueDate) > instant).length,
      pendingReview: dueTasks.filter((task) => task.ownerId === user.id && task.status === 'review').length,
    };
  });

  return { week, now: instant, projects, required, people };
}
