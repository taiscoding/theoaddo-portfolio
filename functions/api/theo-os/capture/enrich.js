import { json, err, requireAdmin, loadMemoryContext } from '../_utils.js';

const ENRICH_SYSTEM = `You are enriching a capture for Theo OS. Given search results about an item,
produce a personalized digest relevant to what you know about the user.

Respond with JSON ONLY (no markdown):
{
  "notes": "2-3 sentence digest, personalized to user context, written for them not about them",
  "release_date": "YYYY-MM-DD or null",
  "source": "domain of most useful source or null",
  "extra_fields": {}
}

Rules:
- notes should feel like a knowledgeable friend telling you what matters
- if user memory mentions relevant preferences, tailor the digest to those
- release_date only for movies/events, null otherwise
- keep notes under 200 chars`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { type, data, mentioned_people } = body;

  if (!type) return err('type required');

  // Only enrich collections and goals
  if (!['collection', 'goal'].includes(type)) {
    return json({ enriched: data, people: mentioned_people || [] });
  }

  if (!data?.title) return err('data.title required for enrichment');

  // Tavily search
  let searchResults = '';
  try {
    const tavRes = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query: `${data.title}${data.type ? ' ' + data.type : ''}`.trim(),
        max_results: 4,
        search_depth: 'basic'
      })
    });
    if (tavRes.ok) {
      const tavData = await tavRes.json();
      searchResults = (tavData.results || [])
        .slice(0, 4)
        .map(r => `${r.title}: ${(r.content || '').slice(0, 200)}`)
        .join('\n');
    }
  } catch { /* enrichment degrades gracefully if Tavily fails */ }

  const memory = await loadMemoryContext(env);

  let enriched = { ...data };
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: `${ENRICH_SYSTEM}\n\nUser context:\n- Facts: ${memory.facts}\n- Patterns: ${memory.patterns}\n- Preferences: ${memory.preferences}`,
        messages: [{
          role: 'user',
          content: `Enrich this ${type}: "${data.title}"\n\nSearch results:\n${searchResults || 'No results found.'}`
        }]
      })
    });
    if (aiRes.ok) {
      const aiData = await aiRes.json();
      const rawText = aiData.content?.[0]?.text;
      if (rawText) {
        let raw = rawText.trim()
          .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const match = raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(match ? match[0] : raw);
        enriched = { ...data, ...parsed };
      }
    }
  } catch { /* degrade gracefully — return un-enriched data if AI call fails */ }

  // Resolve mentioned people IDs to full records
  let people = [];
  if (mentioned_people?.length) {
    const ids = mentioned_people
      .map(p => p.id)
      .filter(id => typeof id === 'number' || typeof id === 'string');
    if (ids.length) {
      try {
        const placeholders = ids.map(() => '?').join(',');
        const { results } = await env.THEO_OS_DB.prepare(
          `SELECT id, name, relationship FROM people WHERE id IN (${placeholders})`
        ).bind(...ids).all();
        people = results;
      } catch { /* people resolution failure doesn't block enrichment */ }
    }
  }

  return json({ enriched, people });
}
