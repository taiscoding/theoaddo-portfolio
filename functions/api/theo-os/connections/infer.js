import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let goals = [], knowledge = [], tasks = [];
  try {
    const [goalsRes, knowledgeRes, tasksRes] = await Promise.all([
      env.THEO_OS_DB.prepare(`SELECT id, title, area FROM goals WHERE status = 'active' LIMIT 25`).all(),
      env.THEO_OS_DB.prepare(`SELECT id, title, area, depth FROM knowledge_notes LIMIT 30`).all(),
      env.THEO_OS_DB.prepare(`SELECT id, title, area FROM tasks WHERE status != 'done' LIMIT 30`).all(),
    ]);
    goals = goalsRes.results || [];
    knowledge = knowledgeRes.results || [];
    tasks = tasksRes.results || [];
  } catch (e) {
    return err('Failed to load entities', 500);
  }

  if (goals.length + knowledge.length + tasks.length < 2) {
    return json({ created: 0, message: 'Not enough entities to infer connections' }, 200, request);
  }

  const entityList = [
    ...goals.map(g => `goal:${g.id} "${g.title}" [area: ${g.area || 'general'}]`),
    ...knowledge.map(k => `knowledge:${k.id} "${k.title}" [area: ${k.area || 'general'}, depth: ${k.depth}]`),
    ...tasks.map(t => `task:${t.id} "${t.title}" [area: ${t.area || 'general'}]`),
  ].join('\n');

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `You are analyzing a personal life OS. Identify meaningful connections between the entities below.

Entities (format: type:id "title" [metadata]):
${entityList}

Rules:
- Only connect entities that genuinely relate (a knowledge concept supports a goal, a task advances a goal, a topic relates to another topic)
- Prefer strong, specific relationships over vague ones
- Labels should be short: "supports", "requires", "relates to", "builds on", "part of", "enables"
- Generate 5-15 connections maximum
- Do NOT connect things just because they share an area

Return a JSON array only, no markdown:
[{"from_type":"goal","from_id":1,"to_type":"knowledge","to_id":2,"label":"requires"}]`
      }]
    })
  }).catch(() => null);

  if (!aiRes?.ok) return err('Inference API error', 502);

  const aiData = await aiRes.json().catch(() => null);
  const raw = aiData?.content?.[0]?.text;
  if (!raw) return err('No response from inference', 502);

  let connections;
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    connections = match ? JSON.parse(match[0]) : JSON.parse(raw);
  } catch {
    return err('Failed to parse inference response', 502);
  }

  if (!Array.isArray(connections)) return err('Invalid inference response', 502);

  let existing = [];
  try {
    const { results } = await env.THEO_OS_DB.prepare(
      `SELECT from_type, from_id, to_type, to_id FROM connections`
    ).all();
    existing = results || [];
  } catch (_) {}

  const existingSet = new Set(
    existing.map(c => `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`)
  );

  let created = 0;
  for (const c of connections.slice(0, 15)) {
    if (!c.from_type || !c.from_id || !c.to_type || !c.to_id) continue;
    const key = `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`;
    if (existingSet.has(key)) continue;
    existingSet.add(key);
    try {
      await env.THEO_OS_DB.prepare(
        `INSERT INTO connections (from_id, from_type, to_id, to_type, label, inferred, created_at)
         VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
      ).bind(Number(c.from_id), String(c.from_type), Number(c.to_id), String(c.to_type), c.label || '').run();
      created++;
    } catch (_) {}
  }

  return json({ created, total: connections.length }, 200, request);
}
