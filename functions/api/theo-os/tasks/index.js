import { json, err, requireAdmin } from '../_utils.js';

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

  const taskStatus = status || 'inbox';

  const result = await env.THEO_OS_DB.prepare(`
    INSERT INTO tasks (title, area, status, due_date, notes, goal_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    title.trim(),
    area || null,
    taskStatus,
    due_date || null,
    notes || null,
    goal_id || null
  ).run();

  const task = await env.THEO_OS_DB.prepare(
    'SELECT * FROM tasks WHERE id = ?'
  ).bind(result.meta.last_row_id).first();

  return json(task, 201);
}
