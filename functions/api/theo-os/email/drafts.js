import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const today = new Date().toISOString().split('T')[0];

  // Wake up any snoozed emails whose snooze period has expired
  if (status === 'pending') {
    await env.THEO_OS_DB.prepare(
      `UPDATE email_drafts SET status = 'pending', snoozed_until = NULL, updated_at = datetime('now')
       WHERE status = 'snoozed' AND snoozed_until <= ?`
    ).bind(today).run().catch(() => null);
  }

  const { results } = await env.THEO_OS_DB.prepare(
    'SELECT * FROM email_drafts WHERE status = ? ORDER BY created_at DESC'
  ).bind(status).all();

  return json(results);
}
