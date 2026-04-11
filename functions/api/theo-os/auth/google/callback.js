import { err } from '../../_utils.js';

const REDIRECT_URI = 'https://theo-os.pages.dev/api/theo-os/auth/google/callback';

// GET /api/theo-os/auth/google/callback — exchange code for tokens
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return new Response(`<html><body style="font-family:monospace;padding:40px;background:#050505;color:#ff6b6b">
      Google OAuth error: ${error}<br><br>
      <a href="/admin/dashboard.html" style="color:#4ecdc4">← Back to dashboard</a>
    </body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  if (!code) return err('No code received', 400);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  });

  const tokens = await res.json();
  if (!tokens.access_token) {
    return new Response(`<html><body style="font-family:monospace;padding:40px;background:#050505;color:#ff6b6b">
      Token exchange failed: ${tokens.error_description || tokens.error || 'unknown error'}<br><br>
      <a href="/admin/dashboard.html" style="color:#4ecdc4">← Back to dashboard</a>
    </body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  const toStore = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || null,
    expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
    scope: tokens.scope
  };

  await env.THEO_OS_KV.put('google_tokens', JSON.stringify(toStore), {
    expirationTtl: 30 * 24 * 3600
  });

  return new Response(`<html><body style="font-family:monospace;padding:40px;background:#050505;color:#a8e6cf">
    Google connected successfully.<br><br>
    <a href="/admin/email.html" style="color:#4ecdc4">← Go to Email Triage</a>
    &nbsp;&nbsp;
    <a href="/admin/dashboard.html" style="color:#4ecdc4">Dashboard</a>
  </body></html>`, { headers: { 'Content-Type': 'text/html' } });
}
