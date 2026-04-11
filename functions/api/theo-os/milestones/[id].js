import { json, err, requireAdmin } from '../_utils.js';

const VALID_STATUSES = ['pending', 'done'];

export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const allowed = ['title', 'status', 'due_date'];
  const fieldsObj = {};

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      fieldsObj[key] = body[key];
    }
  }

  if (Object.keys(fieldsObj).length === 0) return err('No fields to update');

  if ('status' in fieldsObj && !VALID_STATUSES.includes(fieldsObj.status)) return err('Invalid status');
  if ('title' in fieldsObj && (!fieldsObj.title || !String(fieldsObj.title).trim())) return err('Title cannot be empty');

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM milestones WHERE id = ?'
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
    `UPDATE milestones SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const milestone = await env.THEO_OS_DB.prepare(
    'SELECT * FROM milestones WHERE id = ?'
  ).bind(id).first();

  return json(milestone);
}

export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM milestones WHERE id = ?'
  ).bind(id).first();
  if (!existing) return err('Not found', 404);

  await env.THEO_OS_DB.prepare('DELETE FROM milestones WHERE id = ?').bind(id).run();

  return json({ ok: true });
}
