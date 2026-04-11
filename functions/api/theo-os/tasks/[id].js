import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = params.id;
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const allowed = ['title', 'area', 'status', 'due_date', 'notes', 'goal_id'];
  const fields = [];
  const values = [];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      fields.push(`${key} = ?`);
      values.push(body[key]);
    }
  }

  if (fields.length === 0) return err('No fields to update');

  fields.push("updated_at = datetime('now')");
  values.push(id);

  await env.THEO_OS_DB.prepare(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const task = await env.THEO_OS_DB.prepare(
    'SELECT * FROM tasks WHERE id = ?'
  ).bind(id).first();

  if (!task) return err('Not found', 404);

  return json(task);
}

export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = params.id;

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM tasks WHERE id = ?'
  ).bind(id).first();

  if (!existing) return err('Not found', 404);

  await env.THEO_OS_DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();

  return json({ ok: true });
}
