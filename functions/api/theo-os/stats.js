import { json, err, requireAdmin } from './_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const today = new Date().toISOString().split('T')[0];

  const [tasksByStatus, tasksByArea, goalsByArea, overdueTasksRes,
         dueTodayRes, overduePeopleRes, upcomingRes, insightsRes] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT status, COUNT(*) as count FROM tasks WHERE status != 'done' GROUP BY status`).all(),
    env.THEO_OS_DB.prepare(`SELECT area, COUNT(*) as count FROM tasks WHERE status != 'done' GROUP BY area`).all(),
    env.THEO_OS_DB.prepare(`SELECT area, status, COUNT(*) as count FROM goals GROUP BY area, status`).all(),
    env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?`).bind(today).first(),
    env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND (status = 'today' OR due_date = ?)`).bind(today).first(),
    env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM people WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= ?`).bind(today).first(),
    env.THEO_OS_DB.prepare(`
      SELECT 'task' as type, id, title, area, due_date FROM tasks
      WHERE status != 'done' AND due_date IS NOT NULL AND due_date BETWEEN ? AND date(?, '+14 days')
      UNION ALL
      SELECT 'goal' as type, id, title, area, target_date as due_date FROM goals
      WHERE status = 'active' AND target_date IS NOT NULL AND target_date BETWEEN ? AND date(?, '+14 days')
      ORDER BY due_date ASC LIMIT 8
    `).bind(today, today, today, today).all(),
    env.THEO_OS_DB.prepare(`SELECT * FROM insights_log WHERE dismissed = 0 ORDER BY surfaced_at DESC LIMIT 3`).all(),
  ]);

  // Area activity in last 14 days — for life health card signal
  const { results: areaActivity } = await env.THEO_OS_DB.prepare(`
    SELECT area, MAX(updated_at) as last_active FROM tasks
    WHERE updated_at >= datetime('now', '-14 days') GROUP BY area
    UNION
    SELECT area, MAX(updated_at) as last_active FROM goals
    WHERE updated_at >= datetime('now', '-14 days') GROUP BY area
  `).all();

  return json({
    tasks_by_status: tasksByStatus.results,
    tasks_by_area: tasksByArea.results,
    goals_by_area: goalsByArea.results,
    overdue_tasks: overdueTasksRes?.count || 0,
    due_today: dueTodayRes?.count || 0,
    overdue_people: overduePeopleRes?.count || 0,
    upcoming: upcomingRes.results,
    insights: insightsRes.results,
    area_activity: areaActivity,
  });
}
