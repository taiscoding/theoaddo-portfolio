import { json, err, requireAdmin } from '../../_utils.js';

export async function onRequestGet({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  const { results } = await env.THEO_OS_DB.prepare(`
    SELECT * FROM milestones
    WHERE goal_id = ?
    ORDER BY due_date ASC NULLS LAST, created_at ASC
  `).bind(id).all();

  return json(results);
}

export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { title, due_date } = body;
  if (!title || !String(title).trim()) return err('title is required');

  const goalExists = await env.THEO_OS_DB.prepare(
    'SELECT id FROM goals WHERE id = ?'
  ).bind(id).first();
  if (!goalExists) return err('Goal not found', 404);

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO milestones (goal_id, title, status, due_date)
    VALUES (?, ?, 'pending', ?)
    RETURNING *
  `).bind(id, String(title).trim(), due_date || null).all();

  return json(results[0], 201);
}
