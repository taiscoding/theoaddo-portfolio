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

  // Step 2: Search + extract content via Tavily (gracefully skip if no API key)
  let resources = [];
  let digest = null;

  if (env.TAVILY_API_KEY) {
    const query = `${note.title} ${note.area || ''} learn explained`.trim();
    const searchRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        include_raw_content: true,
        max_results: 3
      })
    }).catch(() => null);

    if (searchRes?.ok) {
      const searchData = await searchRes.json().catch(() => ({}));
      resources = (searchData.results || []).slice(0, 3).map(r => ({
        title: r.title,
        url: r.url,
        description: r.content || ''
      }));

      // Step 3: Digest top resource using Tavily's pre-extracted content
      const topContent = searchData.results?.[0]?.raw_content?.slice(0, 5000) || '';
      if (topContent.length > 200) {
        const digestRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1200,
            messages: [{
              role: 'user',
              content: `You are helping Theo learn "${note.title}". He is a medical student at Brown with the following cognitive profile:
- What he knows: ${memory.facts}
- How he learns: ${memory.patterns}
- What works for him: ${memory.preferences}

Digest this resource and re-present the core ideas in a way that matches how he thinks. Use analogies he would find resonant. Connect to what he already knows. Make it engaging, not encyclopedic.

Resource content:
${topContent}

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

  return json({
    note: { id: note.id, title: note.title, depth: note.depth, decay_score: note.decay_score },
    prompt: socraticPrompt,
    digest,
    resources
  }, 200, request);
}
