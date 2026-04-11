import { json, err, requireAdmin } from '../../_utils.js';

export async function onRequestPatch({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id) return err('Invalid id', 400);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { draft } = body;
  if (typeof draft !== 'string') return err('draft field required');

  const { results } = await env.THEO_OS_DB.prepare(
    `UPDATE email_drafts SET draft = ?, updated_at = datetime('now') WHERE id = ? RETURNING *`
  ).bind(draft, id).all();

  if (!results[0]) return err('Draft not found', 404);

  return json(results[0]);
}
