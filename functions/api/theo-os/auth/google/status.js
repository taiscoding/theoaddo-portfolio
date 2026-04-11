import { json, err, requireAdmin } from '../../_utils.js';

// GET /api/theo-os/auth/google/status — list connected Google accounts
export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const indexRaw = await env.THEO_OS_KV.get('google_accounts');
  const accountNames = indexRaw ? JSON.parse(indexRaw) : [];

  const accounts = await Promise.all(accountNames.map(async name => {
    const raw = await env.THEO_OS_KV.get(`google_tokens:${name}`);
    if (!raw) return null;
    const tokens = JSON.parse(raw);
    return { account: name, email: tokens.email || name, connected: true };
  }));

  const connected = accounts.filter(Boolean);
  return json({ connected: connected.length > 0, accounts: connected });
}

// DELETE /api/theo-os/auth/google/status — disconnect an account
export async function onRequestDelete({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }
  const account = body.account || 'primary';

  await env.THEO_OS_KV.delete(`google_tokens:${account}`);

  const indexRaw = await env.THEO_OS_KV.get('google_accounts');
  const accounts = indexRaw ? JSON.parse(indexRaw).filter(a => a !== account) : [];
  await env.THEO_OS_KV.put('google_accounts', JSON.stringify(accounts));

  return json({ ok: true });
}
