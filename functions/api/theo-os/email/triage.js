import { json, err, requireAdmin, getGoogleToken } from '../_utils.js';

// Walk Gmail's MIME tree to find the first text/plain part and decode it
function extractBody(payload, maxChars = 600) {
  if (!payload) return '';

  // Simple message — body directly on payload
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    const raw = payload.body.data.replace(/-/g, '+').replace(/_/g, '/');
    try { return atob(raw).slice(0, maxChars); } catch { return ''; }
  }

  // Multipart — recurse into parts
  for (const part of (payload.parts || [])) {
    const found = extractBody(part, maxChars);
    if (found) return found;
  }

  return '';
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const token = await getGoogleToken(env);
  if (!token) return err('Google not connected', 400);

  // Fetch unread/important messages (not sent)
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=20&q=is:unread%20OR%20is:important%20-is:sent',
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!listRes.ok) {
    const e = await listRes.json().catch(() => ({}));
    return err(`Gmail list error: ${e.error?.message || listRes.status}`, 502);
  }
  const listData = await listRes.json();
  const messages = listData.messages || [];
  if (messages.length === 0) return json({ staged: 0 });

  // Fetch full message (body + headers) for each message in parallel
  const fullResults = (await Promise.all(
    messages.map(m =>
      fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } }
      ).then(r => r.ok ? r.json() : null).catch(() => null)
    )
  )).filter(Boolean);

  // Extract fields including decoded body
  const emails = fullResults.map((msg, i) => {
    const headers = msg.payload?.headers || [];
    const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
    const fromRaw = headers.find(h => h.name === 'From')?.value || '';
    const match = fromRaw.match(/^(.*?)\s*<(.+)>$/);
    const fromName = match ? match[1].trim().replace(/^"|"$/g, '') : fromRaw;
    const fromAddress = match ? match[2].trim() : fromRaw;
    const body = extractBody(msg.payload);
    return {
      index: i,
      threadId: msg.threadId || msg.id,
      subject,
      fromName,
      fromAddress,
      snippet: msg.snippet || '',
      body
    };
  });

  // Single Anthropic call to triage all emails — now with body content
  const aiPayload = emails.map(e => ({
    index: e.index,
    subject: e.subject,
    from: e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress,
    body: e.body || e.snippet  // body if available, fall back to snippet
  }));

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are triaging emails for Theo. For each email, read the body content and provide:
1. urgency: "high" (needs action today), "medium" (worth reading), or "low" (newsletter/promo/automated)
2. draft: a concise, direct reply draft if a reply is warranted — 2-3 sentences. If no reply is needed (newsletter, receipt, notification), return an empty string.

Base urgency on what the email actually says, not just the subject line.

Emails:
${JSON.stringify(aiPayload, null, 2)}

Respond with a JSON array: [{index, urgency, draft}]
Return only the JSON array, no other text.`
      }]
    })
  });

  const triageMap = {};
  if (aiRes.ok) {
    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '[]';
    try {
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const triageArr = JSON.parse(cleaned);
      if (Array.isArray(triageArr)) {
        triageArr.forEach(t => {
          triageMap[t.index] = {
            urgency: ['high', 'medium', 'low'].includes(t.urgency) ? t.urgency : 'medium',
            draft: t.draft || ''
          };
        });
      }
    } catch {
      // Parse failure: staged with defaults, ai_failed flag returned below
    }
  }

  const aiFailed = Object.keys(triageMap).length === 0 && emails.length > 0;

  // Upsert into email_drafts — INSERT OR IGNORE preserves drafts the user has already edited
  let staged = 0;
  for (const email of emails) {
    const triage = triageMap[email.index] || { urgency: 'medium', draft: '' };
    const result = await env.THEO_OS_DB.prepare(`
      INSERT OR IGNORE INTO email_drafts
        (thread_id, subject, from_address, from_name, snippet, urgency, draft, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).bind(
      email.threadId,
      email.subject,
      email.fromAddress,
      email.fromName,
      email.snippet,
      triage.urgency,
      triage.draft
    ).run();

    if (result.meta?.changes > 0) staged++;
  }

  return json({ staged, ...(aiFailed ? { ai_failed: true } : {}) });
}
