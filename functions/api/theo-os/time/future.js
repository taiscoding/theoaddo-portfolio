import { json, err, requireAdmin } from '../_utils.js';

// Group tasks and goals into paths by area, rank by aggregate weight
function buildPaths(tasks, goals) {
  const areas = {};

  for (const goal of goals) {
    const a = goal.area || 'life';
    if (!areas[a]) areas[a] = { area: a, goal: null, tasks: [], weight: 0, people: [] };
    areas[a].goal = goal;
    // Only the highest-weight goal per area is kept (goals are sorted by weight DESC)
    areas[a].weight += goal.weight || 1;
  }

  for (const task of tasks) {
    const a = task.area || 'life';
    if (!areas[a]) areas[a] = { area: a, goal: null, tasks: [], weight: 0, people: [] };
    areas[a].tasks.push(task);
    areas[a].weight += task.weight || 1;
  }

  return Object.values(areas)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5); // top 5 paths only
}

// Label a due date relative to now
function horizonLabel(dateStr) {
  if (!dateStr) return 'someday';
  const due = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.ceil((due - now) / 86400000);
  if (diffDays < 0) return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays <= 7) return `in ${diffDays} days`;
  if (diffDays <= 14) return 'this week';
  if (diffDays <= 31) return 'this month';
  if (diffDays <= 365) return 'this year';
  return 'someday';
}

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  try {
    // Open tasks, sorted by weight then due date
    const { results: tasks } = await env.THEO_OS_DB.prepare(
      `SELECT id, title, area, due_date, weight, notes
       FROM tasks WHERE status != 'done'
       ORDER BY weight DESC, due_date ASC NULLS LAST LIMIT 60`
    ).all();

    // Active goals
    const { results: goals } = await env.THEO_OS_DB.prepare(
      `SELECT id, title, area, target_date, weight, description
       FROM goals ORDER BY weight DESC LIMIT 20`
    ).all();

    // Annotate horizon labels
    const annotatedTasks = tasks.map(t => ({ ...t, horizon: horizonLabel(t.due_date) }));
    const annotatedGoals = goals.map(g => ({ ...g, horizon: horizonLabel(g.target_date) }));

    const paths = buildPaths(annotatedTasks, annotatedGoals);

    // Check for anything due in 48 hours (for nav dot)
    const now = Date.now();
    const soon = annotatedTasks.some(t =>
      t.due_date && new Date(t.due_date).getTime() - now < 48 * 3600000 && new Date(t.due_date).getTime() > now
    );

    return json({ paths, nav_dot: soon ? 'amber' : 'green' });
  } catch (e) {
    return err(`Failed to fetch future: ${e.message}`, 500);
  }
}
