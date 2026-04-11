import { json, err, signJWT, timingSafeEqual } from '../_utils.js';

export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => ({}));
  if (!body.password) return err('Password required');
  const match = await timingSafeEqual(
    body.password,
    env.THEO_OS_ADMIN_PASSWORD || ''
  );
  if (!match) return err('Invalid password', 401);
  const token = await signJWT(
    { role: 'theo_admin', exp: Math.floor(Date.now() / 1000) + 72 * 3600 },
    env.THEO_OS_JWT_SECRET
  );
  return json({ token });
}
