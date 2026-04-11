import { json, err, requireAdmin } from '../_utils.js';

const VALID_TYPES = ['fact', 'pattern', 'preference'];

// GET /api/theo-os/memories?type=fact&min_confidence=0.5&area=work
export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const area = url.searchParams.get('area');
  const minConf = parseFloat(url.searchParams.get('min_confidence') || '0');

  let query = 'SELECT * FROM memories WHERE confidence >= ?';
  const binds = [isNaN(minConf) ? 0 : minConf];
  if (type) { query += ' AND type = ?'; binds.push(type); }
  if (area) { query += ' AND area = ?'; binds.push(area); }
  query += ' ORDER BY confidence DESC, last_reinforced DESC';

  const { results } = await env.THEO_OS_DB.prepare(query).bind(...binds).all();
  return json({ memories: results }, 200, request);
}

// POST /api/theo-os/memories — manually add a memory
export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { type, content, confidence, area } = body;
  if (!type || !VALID_TYPES.includes(type)) return err('Invalid type');
  if (!content || !content.trim()) return err('content is required');

  const conf = Math.min(1.0, Math.max(0.1, parseFloat(confidence) || 0.7));

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO memories (type, content, confidence, source, area, updated_at)
    VALUES (?, ?, ?, 'manual', ?, datetime('now'))
    RETURNING *
  `).bind(type, content.trim(), conf, area || null).all();

  return json({ memory: results[0] }, 201, request);
}
