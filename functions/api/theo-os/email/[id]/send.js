import { json, err, requireAdmin, getGoogleToken } from '../../_utils.js';

export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id) return err('Invalid id', 400);

  const { results } = await env.THEO_OS_DB.prepare(
    'SELECT * FROM email_drafts WHERE id = ?'
  ).bind(id).all();

  const draft = results[0];
  if (!draft) return err('Draft not found', 404);
  if (draft.status === 'sent') return err('Already sent', 400);

  const token = await getGoogleToken(env);
  if (!token) return err('Google not connected', 400);

  // Build RFC 2822 message
  const rawEmail = [
    `To: ${draft.from_address}`,
    `Subject: Re: ${draft.subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    draft.draft || ''
  ].join('\r\n');

  const encoded = btoa(unescape(encodeURIComponent(rawEmail)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const sendBody = { raw: encoded };
  if (draft.thread_id) sendBody.threadId = draft.thread_id;

  const sendRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(sendBody)
    }
  );

  if (!sendRes.ok) {
    const e = await sendRes.json().catch(() => ({}));
    return err(`Gmail send error: ${e.error?.message || sendRes.status}`, 502);
  }

  const sent = await sendRes.json();

  await env.THEO_OS_DB.prepare(
    `UPDATE email_drafts SET status = 'sent', updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  return json({ ok: true, message_id: sent.id });
}
