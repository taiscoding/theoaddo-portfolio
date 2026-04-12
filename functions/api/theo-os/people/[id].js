import { json, err, requireAdmin } from '../_utils.js';

function computeHealth(person) {
  if (!person.touchpoint_interval_days || !person.last_contact) return 'none';
  const daysSince = Math.floor((Date.now() - new Date(person.last_contact).getTime()) / 86400000);
  const interval = person.touchpoint_interval_days;
  if (daysSince <= interval) return 'green';
  if (daysSince <= interval * 1.5) return 'yellow';
  return 'red';
}

export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const allowed = ['name', 'relationship', 'notes', 'last_contact', 'next_touchpoint', 'touchpoint_interval_days'];
  const fieldsObj = {};

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      fieldsObj[key] = body[key];
    }
  }

  if (Object.keys(fieldsObj).length === 0) return err('No fields to update');

  if ('name' in fieldsObj && (!fieldsObj.name || !String(fieldsObj.name).trim())) {
    return err('name cannot be empty');
  }

  if ('touchpoint_interval_days' in fieldsObj && fieldsObj.touchpoint_interval_days !== null) {
    const interval = parseInt(fieldsObj.touchpoint_interval_days, 10);
    if (!Number.isInteger(interval) || interval < 1) return err('touchpoint_interval_days must be a positive integer');
    fieldsObj.touchpoint_interval_days = interval;
  }

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM people WHERE id = ?'
  ).bind(id).first();
  if (!existing) return err('Not found', 404);

  const setClauses = [];
  const values = [];
  for (const key of Object.keys(fieldsObj)) {
    setClauses.push(`${key} = ?`);
    values.push(fieldsObj[key] === '' ? null : fieldsObj[key]);
  }
  setClauses.push("updated_at = datetime('now')");
  values.push(id);

  await env.THEO_OS_DB.prepare(
    `UPDATE people SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const person = await env.THEO_OS_DB.prepare(
    'SELECT * FROM people WHERE id = ?'
  ).bind(id).first();

  env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
  return json({ ...person, health: computeHealth(person) });
}

export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  const existing = await env.THEO_OS_DB.prepare(
    'SELECT id FROM people WHERE id = ?'
  ).bind(id).first();
  if (!existing) return err('Not found', 404);

  await env.THEO_OS_DB.prepare('DELETE FROM people WHERE id = ?').bind(id).run();

  env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
  return json({ ok: true });
}
