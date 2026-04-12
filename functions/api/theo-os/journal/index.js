import { json, err, requireAdmin } from '../_utils.js';

function normalizeTags(raw) {
  if (!raw) return null;
  const cleaned = raw.split(',').map(t => t.trim()).filter(Boolean).join(',');
  return cleaned || null;
}

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const tag = url.searchParams.get('tag');
  const q = url.searchParams.get('q');

  let query = 'SELECT * FROM journal WHERE 1=1';
  const bindings = [];

  if (tag) {
    query += " AND ',' || tags || ',' LIKE '%,' || ? || ',%'";
    bindings.push(tag);
  }
  if (q) {
    query += " AND content LIKE '%' || ? || '%'";
    bindings.push(q);
  }

  query += ' ORDER BY created_at DESC';

  const stmt = env.THEO_OS_DB.prepare(query);
  const { results } = bindings.length
    ? await stmt.bind(...bindings).all()
    : await stmt.all();

  return json(results);
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { content, tags } = body;
  if (!content || !content.trim()) return err('content is required');

  const normalizedTags = normalizeTags(tags);

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO journal (content, tags)
    VALUES (?, ?)
    RETURNING *
  `).bind(content.trim(), normalizedTags).all();

  env.THEO_OS_KV.delete('time:now:digest').catch(() => null);
  return json(results[0], 201);
}
