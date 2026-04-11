import { json, err, requireAdmin, loadMemoryContext } from '../../_utils.js';

// POST /api/theo-os/knowledge/[id]/review
export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  const note = await env.THEO_OS_DB.prepare(
    'SELECT * FROM knowledge_notes WHERE id = ?'
  ).bind(id).first();
  if (!note) return err('Not found', 404);

  const memory = await loadMemoryContext(env);

  // Step 1: Generate Socratic prompt
  let socraticPrompt = `How would you explain "${note.title}" to someone encountering it for the first time?`;
  const promptRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Generate one Socratic question to test deep understanding of: "${note.title}"
Current depth: ${note.depth}. Area: ${note.area || 'general'}.
What Theo knows: ${memory.facts}
His learning patterns: ${memory.patterns}

Rules:
- Do NOT ask "what is X" — ask something that requires applying, explaining to someone else, or connecting to something else
- Match the question to current depth: aware=recall+explain, familiar=apply+connect, fluent=critique+extend
- One question only, no preamble

Return just the question.`
      }]
    })
  }).catch(() => null);

  if (promptRes?.ok) {
    const pd = await promptRes.json().catch(() => null);
    const text = pd?.content?.[0]?.text?.trim();
    if (text) socraticPrompt = text;
  }

  // Step 2: Search for best resource (gracefully skip if no API key)
  let resources = [];
  let digest = null;

  if (env.BRAVE_SEARCH_API_KEY) {
    const query = `${note.title} ${note.area || ''} learn explained`.trim();
    const searchRes = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=3`,
      { headers: { 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY, 'Accept': 'application/json' } }
    ).catch(() => null);

    if (searchRes?.ok) {
      const searchData = await searchRes.json().catch(() => ({}));
      resources = (searchData.web?.results || []).slice(0, 3).map(r => ({
        title: r.title,
        url: r.url,
        description: r.description || ''
      }));
    }

    // Step 3: Fetch and digest top resource
    if (resources.length > 0) {
      const pageRes = await fetch(resources[0].url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TheoOS/1.0)' }
      }).catch(() => null);

      if (pageRes?.ok) {
        const html = await pageRes.text().catch(() => '');
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 5000);

        if (text.length > 200) {
          const digestRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 600,
              messages: [{
                role: 'user',
                content: `You are helping Theo learn "${note.title}". He is a medical student at Brown with the following cognitive profile:
- What he knows: ${memory.facts}
- How he learns: ${memory.patterns}
- What works for him: ${memory.preferences}

Digest this resource and re-present the core ideas in a way that matches how he thinks. Use analogies he would find resonant. Connect to what he already knows. Make it engaging, not encyclopedic.

Resource content:
${text}

Write 3-5 short paragraphs. Be direct. No filler. End with one concrete takeaway.`
              }]
            })
          }).catch(() => null);

          if (digestRes?.ok) {
            const dd = await digestRes.json().catch(() => null);
            digest = dd?.content?.[0]?.text?.trim() || null;
          }
        }
      }
    }
  }

  return json({
    note: { id: note.id, title: note.title, depth: note.depth, decay_score: note.decay_score },
    prompt: socraticPrompt,
    digest,
    resources
  }, 200, request);
}
