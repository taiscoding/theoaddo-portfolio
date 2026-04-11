import { json, err, requireAdmin } from '../_utils.js';

const VALID_TYPES = ['restaurant', 'travel', 'movie', 'book', 'idea'];
const VALID_STATUSES = ['want', 'done'];

export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const allowed = ['title', 'notes', 'source', 'status', 'type'];
  const fieldsObj = {};

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      fieldsObj[key] = body[key];
    }
  }

  if (Object.keys(fieldsObj).length === 0) return err('No fields to update');

  if ('type' in fieldsObj && !VALID_TYPES.includes(fieldsObj.type)) return err('Invalid type');
  if ('status' in fieldsObj && !VALID_STATUSES.includes(fieldsObj.status)) return err('Invalid status');
  if ('title' in fieldsObj && (!fieldsObj.title || !String(fieldsObj.title).trim())) return err('Title cannot be empty');

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM collections WHERE id = ?'
  ).bind(id).first();
  if (!existing) return err('Not found', 404);

  const setClauses = [];
  const values = [];
  for (const key of Object.keys(fieldsObj)) {
    setClauses.push(`${key} = ?`);
    values.push(fieldsObj[key]);
  }
  values.push(id);

  await env.THEO_OS_DB.prepare(
    `UPDATE collections SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const item = await env.THEO_OS_DB.prepare(
    'SELECT * FROM collections WHERE id = ?'
  ).bind(id).first();

  return json(item);
}

export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM collections WHERE id = ?'
  ).bind(id).first();
  if (!existing) return err('Not found', 404);

  await env.THEO_OS_DB.prepare('DELETE FROM collections WHERE id = ?').bind(id).run();

  return json({ ok: true });
}
