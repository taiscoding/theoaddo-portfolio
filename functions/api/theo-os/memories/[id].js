import { json, err, requireAdmin } from '../_utils.js';

// PATCH /api/theo-os/memories/[id]
export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const sets = [];
  const binds = [];

  if (body.content !== undefined) {
    sets.push('content = ?');
    binds.push(String(body.content).trim());
  }
  if (body.confidence !== undefined) {
    const conf = Math.min(1.0, Math.max(0.1, parseFloat(body.confidence)));
    sets.push('confidence = ?');
    binds.push(isNaN(conf) ? 0.7 : conf);
  }
  if (body.area !== undefined) {
    sets.push('area = ?');
    binds.push(body.area || null);
  }
  if (sets.length === 0) return err('No fields to update');

  sets.push("updated_at = datetime('now')");
  binds.push(id);

  const { results } = await env.THEO_OS_DB.prepare(
    `UPDATE memories SET ${sets.join(', ')} WHERE id = ? RETURNING *`
  ).bind(...binds).all();

  if (!results[0]) return err('Not found', 404);
  return json({ memory: results[0] }, 200, request);
}

// DELETE /api/theo-os/memories/[id]
export async function onRequestDelete({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  await env.THEO_OS_DB.prepare('DELETE FROM memories WHERE id = ?').bind(id).run();
  return json({ ok: true }, 200, request);
}
