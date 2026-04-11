import { json, err, requireAdmin } from './_utils.js';

const CAPTURE_SYSTEM = `You are the routing intelligence for Theo OS, a personal life OS.
Parse a single natural-language capture and route it to the correct data type.

Respond with a JSON object ONLY (no markdown, no explanation):
{
  "type": "task" | "goal" | "person" | "collection" | "journal",
  "confirmation": "short human-readable confirmation of what you're creating (under 60 chars)",
  "data": { ...fields specific to the type }
}

Field specs by type:
- task: { title, area (work/finances/health/relationships/growth/creative/exploration/life), due_date (YYYY-MM-DD or null), notes (or null) }
- goal: { title, area, description (or null), target_date (YYYY-MM-DD or null) }
- person: { name, relationship (or null), notes (or null), next_touchpoint (YYYY-MM-DD or null) }
- collection: { type (restaurant/travel/movie/book/idea/other), title, notes (or null), source (or null) }
- journal: { content, tags (comma-separated string or null) }

Rules:
- Default to "task" for action items, reminders, and things to do
- Use "goal" for aspirations with a future outcome
- Use "person" only when adding someone to track a relationship with
- Use "collection" for recommendations, watchlists, places to visit, ideas
- Use "journal" for reflections, thoughts, or things to remember/process
- Use "life" area for administrative tasks (renewals, appointments, life admin)
- Be decisive. Pick one type. Do not add extra fields.`;

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { text } = body;
  if (!text?.trim()) return err('Text required');

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
      system: CAPTURE_SYSTEM,
      messages: [{ role: 'user', content: text.trim() }]
    })
  });

  if (!aiRes.ok) return err('AI routing failed', 502);

  const aiData = await aiRes.json();
  let routed;
  try {
    routed = JSON.parse(aiData.content[0].text);
  } catch {
    return err('Failed to parse routing response', 502);
  }

  const { type, data, confirmation } = routed;
  let saved;

  if (type === 'task') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO tasks (title, area, due_date, notes, status) VALUES (?, ?, ?, ?, 'inbox') RETURNING *`
    ).bind(data.title, data.area || 'life', data.due_date || null, data.notes || null).all();
    saved = results[0];
  } else if (type === 'goal') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO goals (title, area, description, target_date) VALUES (?, ?, ?, ?) RETURNING *`
    ).bind(data.title, data.area, data.description || null, data.target_date || null).all();
    saved = results[0];
  } else if (type === 'person') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO people (name, relationship, notes, next_touchpoint) VALUES (?, ?, ?, ?) RETURNING *`
    ).bind(data.name, data.relationship || null, data.notes || null, data.next_touchpoint || null).all();
    saved = results[0];
  } else if (type === 'collection') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO collections (type, title, notes, source) VALUES (?, ?, ?, ?) RETURNING *`
    ).bind(data.type, data.title, data.notes || null, data.source || null).all();
    saved = results[0];
  } else if (type === 'journal') {
    const { results } = await env.THEO_OS_DB.prepare(
      `INSERT INTO journal (content, tags) VALUES (?, ?) RETURNING *`
    ).bind(data.content, data.tags || null).all();
    saved = results[0];
  } else {
    return err(`Unknown type: ${type}`, 400);
  }

  return json({ type, confirmation, saved });
}
