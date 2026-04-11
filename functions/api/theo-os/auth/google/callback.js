const REDIRECT_URI = 'https://theo-os.pages.dev/api/theo-os/auth/google/callback';

function page(body, color = '#a8e6cf') {
  return new Response(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Theo OS — Google Auth</title>
<style>body{font-family:monospace;padding:48px;background:#050505;color:${color};line-height:1.7}
a{color:#4ecdc4}h2{margin:0 0 16px;font-size:14px;letter-spacing:.08em;text-transform:uppercase}</style>
</head><body>${body}</body></html>`, { headers: { 'Content-Type': 'text/html' } });
}

// GET /api/theo-os/auth/google/callback
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return page(`<h2>Auth Error</h2>Google returned: ${error}<br><br><a href="/admin/dashboard.html">← Dashboard</a>`, '#ff6b6b');
  if (!code || !state) return page(`<h2>Auth Error</h2>Missing code or state.<br><br><a href="/admin/dashboard.html">← Dashboard</a>`, '#ff6b6b');

  // Verify state token (CSRF protection)
  const account = await env.THEO_OS_KV.get(`oauth_state:${state}`);
  if (!account) return page(`<h2>Auth Error</h2>State expired or invalid. Please try connecting again.<br><br><a href="/admin/dashboard.html">← Dashboard</a>`, '#ff6b6b');

  await env.THEO_OS_KV.delete(`oauth_state:${state}`);

  // Exchange code for tokens
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
    return page(`<h2>Token Error</h2>${tokens.error_description || tokens.error || 'Unknown error'}<br><br><a href="/admin/dashboard.html">← Dashboard</a>`, '#ff6b6b');
  }

  // Get email to display
  let email = account;
  try {
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      email = profile.email || account;
    }
  } catch (_) {}

  // Store tokens keyed by account
  const toStore = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || null,
    expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
    scope: tokens.scope,
    email
  };
  await env.THEO_OS_KV.put(`google_tokens:${account}`, JSON.stringify(toStore), { expirationTtl: 30 * 24 * 3600 });

  // Update accounts index
  const indexRaw = await env.THEO_OS_KV.get('google_accounts');
  const accounts = indexRaw ? JSON.parse(indexRaw) : [];
  if (!accounts.includes(account)) accounts.push(account);
  await env.THEO_OS_KV.put('google_accounts', JSON.stringify(accounts));

  return page(`<h2>Connected</h2>
    Google account <strong>${email}</strong> connected as <strong>${account}</strong>.<br><br>
    <a href="/admin/email.html">Open Email Triage →</a>
    &nbsp;&nbsp;
    <a href="/admin/dashboard.html">Dashboard</a>`);
}
