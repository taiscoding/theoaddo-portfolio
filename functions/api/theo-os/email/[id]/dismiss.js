import { json, err, requireAdmin } from '../../_utils.js';

export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id) return err('Invalid id', 400);

  const result = await env.THEO_OS_DB.prepare(
    `UPDATE email_drafts SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  if (result.meta?.changes === 0) return err('Draft not found', 404);

  return json({ ok: true });
}
