import { json, err, requireAdmin, AREAS } from '../_utils.js';

const VALID_STATUSES = ['inbox', 'today', 'this_week', 'later', 'someday'];

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const area = url.searchParams.get('area');

  let query = 'SELECT * FROM tasks WHERE 1=1';
  const bindings = [];

  if (status) {
    query += ' AND status = ?';
    bindings.push(status);
  }
  if (area) {
    query += ' AND area = ?';
    bindings.push(area);
  }

  query += ' ORDER BY created_at DESC';

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

  const { title, area, status, due_date, notes, goal_id } = body;
  if (!title || !title.trim()) return err('title is required');

  if (status !== undefined && !VALID_STATUSES.includes(status)) return err('Invalid status');
  if (area !== undefined && !AREAS.includes(area)) return err('Invalid area');

  const taskStatus = status || 'inbox';

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO tasks (title, area, status, due_date, notes, goal_id)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `).bind(
    title.trim(),
    area || null,
    taskStatus,
    due_date || null,
    notes || null,
    goal_id || null
  ).all();

  env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
  return json(results[0], 201);
}
