import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 730);
  const area = url.searchParams.get('area') || null;
  const person_id = url.searchParams.get('person_id') || null;

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    // Journal entries — no area filter (journal table has no area column)
    const journalSql = `SELECT 'journal' as source_type, id, content as title, NULL as notes, created_at, NULL as area, weight
         FROM journal WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50`;

    const { results: journalEntries } = await env.THEO_OS_DB.prepare(journalSql)
      .bind(cutoff).all();

    // Completed tasks
    const taskSql = area
      ? `SELECT 'task' as source_type, id, title, notes, updated_at as created_at, area, weight
         FROM tasks WHERE status = 'done' AND updated_at >= ? AND area = ?
         ORDER BY updated_at DESC LIMIT 50`
      : `SELECT 'task' as source_type, id, title, notes, updated_at as created_at, area, weight
         FROM tasks WHERE status = 'done' AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT 50`;

    const { results: completedTasks } = await env.THEO_OS_DB.prepare(taskSql)
      .bind(...(area ? [cutoff, area] : [cutoff])).all();

    // Connection touchpoints — only when a specific person is requested
    let touchpoints = [];
    if (person_id) {
      const { results } = await env.THEO_OS_DB.prepare(
        `SELECT DISTINCT 'person' as source_type, p.id, p.name as title, p.notes, p.updated_at as created_at, NULL as area, p.weight
         FROM people p
         JOIN connections c ON (c.to_type = 'person' AND c.to_id = p.id)
         WHERE p.id = ? AND p.updated_at >= ?
         ORDER BY p.updated_at DESC LIMIT 20`
      ).bind(person_id, cutoff).all();
      touchpoints = results;
    }

    // Merge and sort by created_at descending
    const all = [...journalEntries, ...completedTasks, ...touchpoints]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return json({ episodes: all, days, area, person_id });
  } catch (e) {
    return err(`Failed to fetch past: ${e.message}`, 500);
  }
}
