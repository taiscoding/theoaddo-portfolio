import { json, err, requireAdmin } from '../_utils.js';

// GET /api/theo-os/knowledge/[id]
export async function onRequestGet({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  const note = await env.THEO_OS_DB.prepare(
    'SELECT * FROM knowledge_notes WHERE id = ?'
  ).bind(id).first();

  if (!note) return err('Not found', 404);
  return json({ note }, 200, request);
}

// PATCH /api/theo-os/knowledge/[id]
export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const sets = [];
  const binds = [];

  if (body.title !== undefined) { sets.push('title = ?'); binds.push(String(body.title).trim()); }
  if (body.content !== undefined) { sets.push('content = ?'); binds.push(body.content || null); }
  if (body.area !== undefined) { sets.push('area = ?'); binds.push(body.area || null); }
  if (body.depth !== undefined && ['aware','familiar','fluent'].includes(body.depth)) {
    sets.push('depth = ?'); binds.push(body.depth);
  }
  if (sets.length === 0) return err('No fields to update');

  sets.push("last_reviewed = datetime('now')");
  binds.push(id);

  const { results } = await env.THEO_OS_DB.prepare(
    `UPDATE knowledge_notes SET ${sets.join(', ')} WHERE id = ? RETURNING *`
  ).bind(...binds).all();

  if (!results[0]) return err('Not found', 404);
  return json({ note: results[0] }, 200, request);
}

// DELETE /api/theo-os/knowledge/[id]
export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  await env.THEO_OS_DB.prepare('DELETE FROM knowledge_notes WHERE id = ?').bind(id).run();
  return json({ ok: true }, 200, request);
}
