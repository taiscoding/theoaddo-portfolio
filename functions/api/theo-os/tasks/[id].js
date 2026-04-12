import { json, err, requireAdmin, AREAS } from '../_utils.js';

const VALID_STATUSES = ['inbox', 'today', 'this_week', 'later', 'someday'];

export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const allowed = ['title', 'area', 'status', 'due_date', 'notes', 'goal_id'];
  const fieldsObj = {};

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      fieldsObj[key] = body[key];
    }
  }

  if (Object.keys(fieldsObj).length === 0) return err('No fields to update');

  if ('status' in fieldsObj && !VALID_STATUSES.includes(fieldsObj.status)) return err('Invalid status');
  if ('area' in fieldsObj && fieldsObj.area !== null && !AREAS.includes(fieldsObj.area)) return err('Invalid area');
  if ('title' in fieldsObj && (!fieldsObj.title || !String(fieldsObj.title).trim())) return err('Title cannot be empty');

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM tasks WHERE id = ?'
  ).bind(id).first();
  if (!existing) return err('Not found', 404);

  const setClauses = [];
  const values = [];
  for (const key of Object.keys(fieldsObj)) {
    setClauses.push(`${key} = ?`);
    values.push(fieldsObj[key]);
  }
  setClauses.push("updated_at = datetime('now')");
  values.push(id);

  await env.THEO_OS_DB.prepare(
    `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const task = await env.THEO_OS_DB.prepare(
    'SELECT * FROM tasks WHERE id = ?'
  ).bind(id).first();

  env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
  return json(task);
}

export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM tasks WHERE id = ?'
  ).bind(id).first();

  if (!existing) return err('Not found', 404);

  await env.THEO_OS_DB.prepare('DELETE FROM tasks WHERE id = ?').bind(id).run();

  env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
  return json({ ok: true });
}
