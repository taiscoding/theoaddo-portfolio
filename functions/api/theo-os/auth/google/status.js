import { json, err, requireAdmin, getGoogleToken } from '../../_utils.js';

// GET /api/theo-os/auth/google/status
export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const token = await getGoogleToken(env).catch(() => null);
  return json({ connected: !!token });
}
