import { json, err, requireAdmin } from '../_utils.js';

function computeHealth(person) {
  if (!person.touchpoint_interval_days || !person.last_contact) return 'none';
  const daysSince = Math.floor((Date.now() - new Date(person.last_contact).getTime()) / 86400000);
  const interval = person.touchpoint_interval_days;
  if (daysSince <= interval) return 'green';
  if (daysSince <= interval * 1.5) return 'yellow';
  return 'red';
}

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const { results } = await env.THEO_OS_DB.prepare(
    'SELECT * FROM people ORDER BY name ASC'
  ).all();

  const people = (results || []).map(p => ({ ...p, health: computeHealth(p) }));
  return json(people);
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { name, relationship, notes, last_contact, next_touchpoint, touchpoint_interval_days } = body;

  if (!name || !String(name).trim()) return err('name is required');

  if (touchpoint_interval_days !== undefined && touchpoint_interval_days !== null) {
    const interval = parseInt(touchpoint_interval_days, 10);
    if (!Number.isInteger(interval) || interval < 1) return err('touchpoint_interval_days must be a positive integer');
  }

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO people (name, relationship, notes, last_contact, next_touchpoint, touchpoint_interval_days)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `).bind(
    String(name).trim(),
    relationship || null,
    notes || null,
    last_contact || null,
    next_touchpoint || null,
    touchpoint_interval_days ? parseInt(touchpoint_interval_days, 10) : null
  ).all();

  const person = results[0];
  return json({ ...person, health: computeHealth(person) }, 201);
}
