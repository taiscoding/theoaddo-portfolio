import { json, err, requireAdmin } from '../../_utils.js';

const DEPTH_ORDER = ['aware', 'familiar', 'fluent'];

function applySpacedRepetition(note, score) {
  let ease_factor = parseFloat(note.ease_factor) || 2.5;
  const depth = note.depth || 'aware';
  const depthIdx = DEPTH_ORDER.indexOf(depth);

  // Calculate previous interval
  const BASE_INTERVALS = { aware: 3, familiar: 7, fluent: 21 };
  let prevInterval = BASE_INTERVALS[depth] || 3;
  if (note.next_review && note.last_reviewed) {
    const diff = (new Date(note.next_review) - new Date(note.last_reviewed.replace(' ', 'T') + 'Z')) / 86400000;
    if (diff > 0) prevInterval = Math.round(diff);
  }

  let newInterval, newEase, newDepth = depth;

  if (score >= 4) {
    newEase = Math.min(3.5, ease_factor + 0.1);
    newInterval = Math.round(prevInterval * newEase);
    if (score === 5 && depthIdx < 2) newDepth = DEPTH_ORDER[depthIdx + 1];
  } else if (score === 3) {
    newEase = ease_factor;
    newInterval = Math.max(1, Math.round(prevInterval * 1.2));
  } else {
    newEase = Math.max(1.3, ease_factor - 0.2);
    newInterval = 1;
    if (score === 1 && depthIdx > 0) newDepth = DEPTH_ORDER[depthIdx - 1];
  }

  const nextReviewDate = new Date(Date.now() + newInterval * 86400000).toISOString().split('T')[0];
  return { newInterval, newEase, newDepth, nextReviewDate };
}

// POST /api/theo-os/knowledge/[id]/score
export async function onRequestPost(context) {
  const { request, env, params } = context;
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const id = Number(params.id);
  if (!id || isNaN(id)) return err('Invalid id');

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { response, prompt } = body;
  if (!response || !response.trim()) return err('response is required');

  const note = await env.THEO_OS_DB.prepare('SELECT * FROM knowledge_notes WHERE id = ?').bind(id).first();
  if (!note) return err('Not found', 404);

  // Score with Haiku
  let score = 3;
  const scoreRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `Score this recall response 1-5. Return only JSON: {"score": N}

Topic: ${note.title}
Question: ${prompt || '(not provided)'}
Response: ${response.trim().slice(0, 500)}

1=blank/wrong, 2=vague recognition, 3=partial, 4=solid+complete, 5=deep+connected+applied`
      }]
    })
  }).catch(() => null);

  if (scoreRes?.ok) {
    const sd = await scoreRes.json().catch(() => null);
    const raw = sd?.content?.[0]?.text;
    try {
      const parsed = JSON.parse(raw?.match(/\{[\s\S]*\}/)?.[0] || raw);
      const s = parseInt(parsed.score);
      if (s >= 1 && s <= 5) score = s;
    } catch (_) {}
  }

  const { newInterval, newEase, newDepth, nextReviewDate } = applySpacedRepetition(note, score);

  await env.THEO_OS_DB.prepare(`
    UPDATE knowledge_notes
    SET last_score = ?, ease_factor = ?, depth = ?, next_review = ?,
        last_reviewed = datetime('now'), decay_score = 1.0
    WHERE id = ?
  `).bind(score, newEase, newDepth, nextReviewDate, id).run();

  const updated = await env.THEO_OS_DB.prepare('SELECT * FROM knowledge_notes WHERE id = ?').bind(id).first();

  // Fire-and-forget: infer connections for this note
  const inferPromise = (async () => {
    try {
      const [goalsRes, neighborsRes] = await Promise.all([
        env.THEO_OS_DB.prepare(`SELECT id, title, area FROM goals WHERE status = 'active' LIMIT 20`).all(),
        env.THEO_OS_DB.prepare(`SELECT id, title, area, depth FROM knowledge_notes WHERE id != ? LIMIT 15`).bind(id).all(),
      ]);
      const goals = goalsRes.results || [];
      const neighbors = neighborsRes.results || [];

      const entityList = [
        `knowledge:${note.id} "${note.title}" [area: ${note.area || 'general'}, depth: ${note.depth}]`,
        ...goals.map(g => `goal:${g.id} "${g.title}" [area: ${g.area || 'general'}]`),
        ...neighbors.map(k => `knowledge:${k.id} "${k.title}" [area: ${k.area || 'general'}, depth: ${k.depth}]`),
      ].join('\n');

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: `Identify connections FROM "knowledge:${note.id}" to other entities. Max 5. Labels: "supports","requires","relates to","builds on","enables". Return JSON array only: [{"from_type":"knowledge","from_id":${note.id},"to_type":"goal","to_id":N,"label":"supports"}]\n\n${entityList}` }]
        })
      }).catch(() => null);
      if (!aiRes?.ok) return;
      const aiData = await aiRes.json().catch(() => null);
      const raw = aiData?.content?.[0]?.text;
      if (!raw) return;
      let conns;
      try { const m = raw.match(/\[[\s\S]*\]/); conns = m ? JSON.parse(m[0]) : JSON.parse(raw); } catch { return; }
      const VALID_TYPES = new Set(['goal', 'knowledge', 'task', 'person', 'journal']);
      const { results: existing } = await env.THEO_OS_DB.prepare(
        `SELECT from_type, from_id, to_type, to_id FROM connections WHERE from_type = 'knowledge' AND from_id = ?`
      ).bind(id).all().catch(() => ({ results: [] }));
      const existSet = new Set((existing || []).map(c => `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`));
      for (const c of (conns || []).slice(0, 5)) {
        if (!c.from_type || !c.from_id || !c.to_type || !c.to_id) continue;
        if (!VALID_TYPES.has(c.from_type) || !VALID_TYPES.has(c.to_type)) continue;
        const key = `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`;
        if (existSet.has(key)) continue;
        await env.THEO_OS_DB.prepare(
          `INSERT INTO connections (from_id, from_type, to_id, to_type, label, inferred, created_at) VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
        ).bind(Number(c.from_id), String(c.from_type), Number(c.to_id), String(c.to_type), String(c.label || '').slice(0, 60)).run().catch(() => {});
      }
    } catch (_) {}
  })();

  // Use waitUntil if available (Cloudflare Pages context)
  if (context?.waitUntil) context.waitUntil(inferPromise);

  return json({ score, new_depth: newDepth, next_review: nextReviewDate, interval_days: newInterval, note: updated }, 200, request);
}
