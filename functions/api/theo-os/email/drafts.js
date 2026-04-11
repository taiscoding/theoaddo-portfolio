import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';

  const { results } = await env.THEO_OS_DB.prepare(
    'SELECT * FROM email_drafts WHERE status = ? ORDER BY created_at DESC'
  ).bind(status).all();

  return json(results);
}
