import { json, err, requireAdmin, getGoogleToken } from '../../_utils.js';

export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id) return err('Invalid id', 400);

  const draft = await env.THEO_OS_DB.prepare(
    `SELECT thread_id FROM email_drafts WHERE id = ?`
  ).bind(id).first();

  if (!draft) return err('Draft not found', 404);

  await env.THEO_OS_DB.prepare(
    `UPDATE email_drafts SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  // Archive the Gmail thread (remove from inbox)
  if (draft.thread_id) {
    const token = await getGoogleToken(env).catch(() => null);
    if (token) {
      await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/threads/${draft.thread_id}/modify`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
        }
      ).catch(() => null);
    }
  }

  return json({ ok: true });
}
