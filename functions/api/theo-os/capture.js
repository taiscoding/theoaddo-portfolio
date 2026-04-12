import { json, err, requireAdmin, loadMemoryContext, resolveAliases } from './_utils.js';

const ROUTE_SYSTEM = `You are the routing intelligence for Theo OS, a personal life OS.
Parse a natural-language capture and route it. Respond with JSON ONLY (no markdown):

{
  "confidence": 0.0-1.0,
  "needs_clarification": true|false,
  "question": "short targeted question if needs_clarification is true, else null",
  "answer_chips": ["Option A", "Option B"] or null,
  "type": "task" | "goal" | "person" | "collection" | "journal",
  "data": { ...type-specific fields },
  "emotional_score": 0.0-1.0
}

Field specs by type:
- task: { title, area (work/finances/health/relationships/growth/creative/exploration/life), due_date (YYYY-MM-DD or null), notes: null }
- goal: { title, area, description: null, target_date: null }
- person: { name, relationship: null, notes: null, next_touchpoint: null }
- collection: { type (restaurant/travel/movie/book/idea/other), title, notes: null, source: null }
- journal: { content, tags: null }

Confidence rules:
- 0.9+: clearly one type, all key fields obvious
- 0.7-0.89: likely correct but one field ambiguous
- below 0.7: set needs_clarification=true, provide question + 2 answer_chips

Clarification fires ONLY for type ambiguity or enrichment target ambiguity (e.g. "The Odyssey" — film or book?).
Never ask about missing optional fields. Make your best guess on those.

Emotional score: 0=neutral log entry, 1=high emotional intensity (love, fear, loss, joy, urgency).

People: text may contain [person:ID] annotations — use these to identify mentioned people.
Return the canonical names only in data fields.`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { text, clarification } = body;
  if (!text?.trim()) return err('Text required');

  // Resolve aliases before routing
  const { resolvedText, mentionedPeople } = await resolveAliases(text.trim(), env);

  const memory = await loadMemoryContext(env);
  const fullText = clarification
    ? `Original: ${resolvedText}\nClarification: ${clarification}`
    : resolvedText;

  const system = `${ROUTE_SYSTEM}

Known context about Theo:
- Facts: ${memory.facts}
- Patterns: ${memory.patterns}`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: fullText }]
    })
  });

  if (!aiRes.ok) return err('Routing failed', 502);

  const aiData = await aiRes.json();
  let routed;
  try {
    let raw = aiData.content[0].text.trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const match = raw.match(/\{[\s\S]*\}/);
    routed = JSON.parse(match ? match[0] : raw);
  } catch {
    return err('Failed to parse routing response', 502);
  }

  return json({
    ...routed,
    mentioned_people: mentionedPeople,
    original_text: text.trim(),
    resolved_text: resolvedText
  });
}
