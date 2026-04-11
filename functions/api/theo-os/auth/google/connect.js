import { verifyJWT, err } from '../../_utils.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

const REDIRECT_URI = 'https://theo-os.pages.dev/api/theo-os/auth/google/callback';

// GET /api/theo-os/auth/google/connect?t=JWT&account=primary
// Verifies JWT from query param (browser navigation can't set headers),
// generates a CSRF state token stored in KV, then redirects to Google.
export async function onRequestGet({ request, env }) {
  const reqUrl = new URL(request.url);
  const token = reqUrl.searchParams.get('t');
  const account = reqUrl.searchParams.get('account') || 'primary';

  if (!token) return err('Missing token', 401);
  const payload = await verifyJWT(token, env.THEO_OS_JWT_SECRET);
  if (!payload) return err('Invalid or expired token', 401);

  // Generate a random state token, store account name in KV for 5 minutes
  const state = crypto.randomUUID();
  await env.THEO_OS_KV.put(`oauth_state:${state}`, account, { expirationTtl: 300 });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);

  return Response.redirect(url.toString(), 302);
}
