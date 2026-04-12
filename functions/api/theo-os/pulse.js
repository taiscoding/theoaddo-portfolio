import { json, err, requireAdmin } from './_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  try {
    const pulse = await env.THEO_OS_KV.get('pulse:current', { type: 'json' });
    return json({ pulse: pulse || null });
  } catch {
    return json({ pulse: null });
  }
}
