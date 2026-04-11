import { json, err, requireAdmin } from '../_utils.js';

const VALID_DEPTHS = ['aware', 'familiar', 'fluent'];

// GET /api/theo-os/knowledge?area=work&depth=aware&max_decay=0.5&due=true
export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const area = url.searchParams.get('area');
  const depth = url.searchParams.get('depth');
  const maxDecay = parseFloat(url.searchParams.get('max_decay') || '1');
  const due = url.searchParams.get('due');
  const today = new Date().toISOString().split('T')[0];

  let query = 'SELECT * FROM knowledge_notes WHERE decay_score <= ?';
  const binds = [isNaN(maxDecay) ? 1 : maxDecay];
  if (area) { query += ' AND area = ?'; binds.push(area); }
  if (depth) { query += ' AND depth = ?'; binds.push(depth); }
  if (due === 'true') { query += ' AND (next_review IS NULL OR next_review <= ?)'; binds.push(today); }
  query += ' ORDER BY decay_score ASC, next_review ASC';

  const { results } = await env.THEO_OS_DB.prepare(query).bind(...binds).all();
  return json({ notes: results }, 200, request);
}

// POST /api/theo-os/knowledge
export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { title, content, area, depth } = body;
  if (!title || !title.trim()) return err('title is required');
  const d = VALID_DEPTHS.includes(depth) ? depth : 'aware';

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO knowledge_notes (title, content, area, depth, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    RETURNING *
  `).bind(title.trim(), content?.trim() || null, area || null, d).all();

  return json({ note: results[0] }, 201, request);
}
