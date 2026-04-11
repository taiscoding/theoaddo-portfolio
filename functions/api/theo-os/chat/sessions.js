import { json, err, requireAdmin } from '../_utils.js';

// GET /api/theo-os/chat/sessions?limit=20
export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));

  const { results } = await env.THEO_OS_DB.prepare(
    `SELECT id, session_id, summary, created_at FROM chat_memory ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all();

  return json({ sessions: results || [] }, 200, request);
}

// DELETE /api/theo-os/chat/sessions/:id — delete a single memory entry
export async function onRequestDelete({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id'), 10);
  if (!id) return err('id required');

  await env.THEO_OS_DB.prepare('DELETE FROM chat_memory WHERE id = ?').bind(id).run();
  return json({ ok: true }, 200, request);
}
