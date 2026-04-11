import { json, err, requireAdmin } from '../_utils.js';

function normalizeTags(raw) {
  if (!raw) return null;
  const cleaned = raw.split(',').map(t => t.trim()).filter(Boolean).join(',');
  return cleaned || null;
}

export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM journal WHERE id = ?'
  ).bind(id).first();
  if (!existing) return err('Not found', 404);

  const allowed = ['content', 'tags'];
  const fieldsObj = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      fieldsObj[key] = body[key];
    }
  }

  if (Object.keys(fieldsObj).length === 0) return err('No fields to update');
  if ('content' in fieldsObj && (!fieldsObj.content || !String(fieldsObj.content).trim())) {
    return err('content cannot be empty');
  }

  if ('tags' in fieldsObj) {
    fieldsObj.tags = normalizeTags(fieldsObj.tags);
  }

  const setClauses = [];
  const values = [];
  for (const key of Object.keys(fieldsObj)) {
    setClauses.push(`${key} = ?`);
    values.push(fieldsObj[key]);
  }
  setClauses.push("updated_at = datetime('now')");
  values.push(id);

  await env.THEO_OS_DB.prepare(
    `UPDATE journal SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const entry = await env.THEO_OS_DB.prepare(
    'SELECT * FROM journal WHERE id = ?'
  ).bind(id).first();

  return json(entry);
}

export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM journal WHERE id = ?'
  ).bind(id).first();
  if (!existing) return err('Not found', 404);

  await env.THEO_OS_DB.prepare('DELETE FROM journal WHERE id = ?').bind(id).run();

  return json({ ok: true });
}
