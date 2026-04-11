import { json, err, requireAdmin, AREAS } from '../_utils.js';

const VALID_STATUSES = ['active', 'paused', 'achieved', 'abandoned'];

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const area = url.searchParams.get('area');
  const status = url.searchParams.get('status');

  let query = `
    SELECT
      g.*,
      (SELECT COUNT(*) FROM milestones WHERE goal_id = g.id) AS milestone_count,
      (SELECT COUNT(*) FROM milestones WHERE goal_id = g.id AND status = 'done') AS milestone_done
    FROM goals g
    WHERE 1=1
  `;
  const bindings = [];

  if (area) {
    query += ' AND g.area = ?';
    bindings.push(area);
  }
  if (status) {
    query += ' AND g.status = ?';
    bindings.push(status);
  }

  query += ' ORDER BY g.created_at DESC';

  const stmt = env.THEO_OS_DB.prepare(query);
  const { results } = bindings.length
    ? await stmt.bind(...bindings).all()
    : await stmt.all();

  return json(results);
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { title, area, description, status, target_date } = body;
  if (!title || !String(title).trim()) return err('title is required');

  const goalStatus = status || 'active';
  if (!VALID_STATUSES.includes(goalStatus)) return err('Invalid status');
  if (area !== undefined && area !== null && !AREAS.includes(area)) return err('Invalid area');

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO goals (title, area, description, status, target_date)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `).bind(
    String(title).trim(),
    area || null,
    description || null,
    goalStatus,
    target_date || null
  ).all();

  return json(results[0], 201);
}
