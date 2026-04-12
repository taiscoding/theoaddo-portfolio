import { json, err, requireAdmin } from '../../../_utils.js';

export async function onRequestGet({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const id = Number(params.id);
  if (!id) return err('Invalid id');

  const person = await env.THEO_OS_DB.prepare(
    'SELECT id, name, aliases FROM people WHERE id = ?'
  ).bind(id).first();

  if (!person) return err('Not found', 404);

  let aliases = [];
  try { aliases = JSON.parse(person.aliases || '[]'); } catch { /* malformed, return empty */ }

  return json({ id: person.id, name: person.name, aliases });
}

export async function onRequestPut({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const id = Number(params.id);
  if (!id) return err('Invalid id');

  const body = await request.json().catch(() => ({}));
  const { aliases } = body;
  if (!Array.isArray(aliases)) return err('aliases must be an array');

  // Validate: all entries must be non-empty strings
  const clean = aliases.map(a => String(a).trim()).filter(Boolean);

  await env.THEO_OS_DB.prepare(
    'UPDATE people SET aliases = ? WHERE id = ?'
  ).bind(JSON.stringify(clean), id).run();

  return json({ ok: true, id, aliases: clean });
}
