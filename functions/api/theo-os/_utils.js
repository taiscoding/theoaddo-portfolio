export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export function err(message, status = 400) {
  return json({ error: message }, status);
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function encodeObj(obj) {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

export async function signJWT(payload, secret) {
  const header = encodeObj({ alg: 'HS256', typ: 'JWT' });
  const body = encodeObj(payload);
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(
    atob(sig.replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );
  const valid = await crypto.subtle.verify(
    'HMAC', key, sigBytes,
    new TextEncoder().encode(`${header}.${payload}`)
  );
  if (!valid) return null;
  const decoded = JSON.parse(
    atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
  );
  if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) return null;
  return decoded;
}

export async function requireAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyJWT(auth.slice(7), env.THEO_OS_JWT_SECRET);
}

export async function timingSafeEqual(a, b) {
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const [ka, kb] = await Promise.all([
    crypto.subtle.importKey('raw', new TextEncoder().encode(a),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    crypto.subtle.importKey('raw', new TextEncoder().encode(b),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  ]);
  const [sa, sb] = await Promise.all([
    crypto.subtle.sign('HMAC', ka, nonce),
    crypto.subtle.sign('HMAC', kb, nonce)
  ]);
  const va = new Uint8Array(sa), vb = new Uint8Array(sb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function getGoogleToken(env) {
  const stored = await env.THEO_OS_KV.get('google_tokens');
  if (!stored) return null;
  const tokens = JSON.parse(stored);
  if (tokens.expiry_date && tokens.expiry_date > Date.now() + 60000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const refreshed = await res.json();
  if (!refreshed.access_token) return null;
  const updated = { ...tokens, ...refreshed, expiry_date: Date.now() + refreshed.expires_in * 1000 };
  await env.THEO_OS_KV.put('google_tokens', JSON.stringify(updated), { expirationTtl: 30 * 24 * 3600 });
  return refreshed.access_token;
}

export const AREAS = [
  'work', 'finances', 'health', 'relationships',
  'growth', 'creative', 'exploration', 'life'
];
