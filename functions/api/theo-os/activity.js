import { json, err, requireAdmin } from './_utils.js';

// GET /api/theo-os/activity?days=90
// Returns per-area activity counts over the last N days
export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '90', 10)));

  const [tasksRes, goalsRes, journalRes] = await Promise.all([
    env.THEO_OS_DB.prepare(`
      SELECT area, COUNT(*) as count FROM tasks
      WHERE updated_at >= datetime('now', ? || ' days')
      GROUP BY area
    `).bind(`-${days}`).all(),
    env.THEO_OS_DB.prepare(`
      SELECT area, COUNT(*) as count FROM goals
      WHERE updated_at >= datetime('now', ? || ' days')
      GROUP BY area
    `).bind(`-${days}`).all(),
    env.THEO_OS_DB.prepare(`
      SELECT 'life' as area, COUNT(*) as count FROM journal_entries
      WHERE created_at >= datetime('now', ? || ' days')
    `).bind(`-${days}`).first(),
  ]);

  // Merge all sources into a single area -> count map
  const totals = {};
  for (const row of (tasksRes.results || [])) {
    const a = row.area || 'general';
    totals[a] = (totals[a] || 0) + row.count;
  }
  for (const row of (goalsRes.results || [])) {
    const a = row.area || 'general';
    totals[a] = (totals[a] || 0) + row.count;
  }
  if (journalRes?.count > 0) {
    totals['life'] = (totals['life'] || 0) + journalRes.count;
  }

  const areas = Object.entries(totals)
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count);

  return json({ areas, days }, 200, request);
}
