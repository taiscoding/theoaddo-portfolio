import { json, err, requireAdmin } from '../_utils.js';

// PUT /api/theo-os/insights — dismiss an insight by id
export async function onRequestPut({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const id = Number(body.id);
  if (!id || isNaN(id)) return err('id is required');

  await env.THEO_OS_DB.prepare(
    `UPDATE insights_log SET dismissed = 1 WHERE id = ?`
  ).bind(id).run();

  return json({ ok: true });
}
