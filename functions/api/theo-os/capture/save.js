import { json, err, requireAdmin } from '../_utils.js';

// Spreading activation: boost weight on mentioned people
async function spreadActivation(env, peopleIds) {
  const boost = 0.15;
  for (const pid of peopleIds) {
    await env.THEO_OS_DB.prepare(
      'UPDATE people SET weight = MIN(weight + ?, 10.0) WHERE id = ?'
    ).bind(boost, pid).run().catch(() => null);
  }
}

// Background memory extraction — fire and forget
async function extractMemory(env, type, data, originalText, peopleNames) {
  try {
    const context = peopleNames.length
      ? `${originalText} (involves: ${peopleNames.join(', ')})`
      : originalText;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        system: `Extract ONE memorable fact or preference about the user from this capture, if any.
Return JSON only: { "memory": "short fact string under 80 chars", "type": "fact"|"preference"|"pattern" }
Return { "memory": null } if nothing worth remembering.`,
        messages: [{ role: 'user', content: `Capture: "${context}"\nRouted as: ${type}` }]
      })
    });

    if (!res.ok) return;
    const aiData = await res.json();
    let raw = aiData.content?.[0]?.text?.trim() || '';
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);

    if (parsed.memory) {
      await env.THEO_OS_DB.prepare(
        'INSERT INTO memories (type, content, confidence, source, weight, emotional_score) VALUES (?, ?, 0.7, "capture", 1.0, 0.0)'
      ).bind(parsed.type || 'fact', parsed.memory).run();
    }
  } catch { /* silent — memory extraction never blocks save */ }
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { type, data, people_ids = [], original_text = '', existing_id = null } = body;

  if (!type || !data) return err('type and data required');

  let saved;

  // If linking to existing record (dedup path), boost its weight and return
  if (existing_id) {
    const tableMap = { task: 'tasks', goal: 'goals', collection: 'collections', person: 'people' };
    const table = tableMap[type];
    if (table) {
      await env.THEO_OS_DB.prepare(
        `UPDATE ${table} SET weight = MIN(weight + 0.25, 10.0) WHERE id = ?`
      ).bind(existing_id).run().catch(() => null);
    }
    saved = { id: existing_id, _linked: true };
  } else {
    // Create new record
    try {
      if (type === 'task') {
        const { results } = await env.THEO_OS_DB.prepare(
          `INSERT INTO tasks (title, area, due_date, notes, status, weight) VALUES (?, ?, ?, ?, 'inbox', 1.0) RETURNING *`
        ).bind(data.title, data.area || 'life', data.due_date || null, data.notes || null).all();
        saved = results[0];
      } else if (type === 'goal') {
        const { results } = await env.THEO_OS_DB.prepare(
          `INSERT INTO goals (title, area, description, target_date, weight) VALUES (?, ?, ?, ?, 1.0) RETURNING *`
        ).bind(data.title, data.area || 'life', data.description || null, data.target_date || null).all();
        saved = results[0];
      } else if (type === 'person') {
        const { results } = await env.THEO_OS_DB.prepare(
          `INSERT INTO people (name, relationship, notes, next_touchpoint, weight, aliases) VALUES (?, ?, ?, ?, 1.0, '[]') RETURNING *`
        ).bind(data.name, data.relationship || null, data.notes || null, data.next_touchpoint || null).all();
        saved = results[0];
      } else if (type === 'collection') {
        const { results } = await env.THEO_OS_DB.prepare(
          `INSERT INTO collections (type, title, notes, source, weight) VALUES (?, ?, ?, ?, 1.0) RETURNING *`
        ).bind(data.type || 'other', data.title, data.notes || null, data.source || null).all();
        saved = results[0];
      } else if (type === 'journal') {
        const tags = Array.isArray(data.tags) ? JSON.stringify(data.tags) : (data.tags || null);
        const { results } = await env.THEO_OS_DB.prepare(
          `INSERT INTO journal (content, tags, weight) VALUES (?, ?, 1.0) RETURNING *`
        ).bind(data.content, tags).all();
        saved = results[0];
      } else {
        return err(`Unknown type: ${type}`, 400);
      }
    } catch (e) {
      const msg = e?.cause?.message || e?.message || String(e);
      return err(`Failed to save record: ${msg}`, 500);
    }
  }

  if (!saved?.id) return err('Save failed — no record returned', 500);

  // Create connections to linked people (ignore duplicates)
  for (const pid of people_ids) {
    await env.THEO_OS_DB.prepare(
      `INSERT OR IGNORE INTO connections (from_type, from_id, to_type, to_id, strength) VALUES (?, ?, 'person', ?, 1.0)`
    ).bind(type, saved.id, pid).run().catch(() => null);
  }

  // Spreading activation — boost weight on mentioned people
  await spreadActivation(env, people_ids);

  // Get people names for memory extraction context (parameterized)
  let peopleNames = [];
  if (people_ids.length) {
    try {
      const placeholders = people_ids.map(() => '?').join(',');
      const { results } = await env.THEO_OS_DB.prepare(
        `SELECT name FROM people WHERE id IN (${placeholders})`
      ).bind(...people_ids).all();
      peopleNames = results.map(r => r.name);
    } catch { /* non-fatal */ }
  }

  // Fire background memory extraction (don't await — never blocks save)
  extractMemory(env, type, data, original_text, peopleNames).catch(() => null);

  env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
  return json({ type, saved, confirmation: `${type} saved` });
}
