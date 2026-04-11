import { json, err, requireAdmin } from '../../_utils.js';

export async function onRequestPost({ request, env, params }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = parseInt(params.id, 10);
  if (!id || id < 1) return err('Invalid id', 400);

  const person = await env.THEO_OS_DB.prepare(
    'SELECT * FROM people WHERE id = ?'
  ).bind(id).first();
  if (!person) return err('Not found', 404);

  const relationshipPart = person.relationship ? ` (${person.relationship})` : '';
  const notesPart = person.notes ? ` Context: ${person.notes}.` : '';
  const prompt = `Draft a warm, genuine, brief reach-out message for ${person.name}${relationshipPart}.${notesPart} Keep it natural and personal. 2-3 sentences max.`;

  let aiRes;
  try {
    aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch {
    return err('AI service unavailable', 502);
  }
  if (!aiRes.ok) return err('AI service error', 502);
  const aiData = await aiRes.json();
  const draft = aiData.content?.[0]?.text;
  if (!draft) return err('AI returned no content', 502);
  return json({ draft });
}
