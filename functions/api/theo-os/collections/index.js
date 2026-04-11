import { json, err, requireAdmin } from '../_utils.js';

const VALID_TYPES = ['restaurant', 'travel', 'movie', 'book', 'idea'];
const VALID_STATUSES = ['want', 'done'];

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const status = url.searchParams.get('status');

  let query = 'SELECT * FROM collections WHERE 1=1';
  const bindings = [];

  if (type) {
    query += ' AND type = ?';
    bindings.push(type);
  }
  if (status) {
    query += ' AND status = ?';
    bindings.push(status);
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

  const { type, title, notes, source, status } = body;

  if (!type || !type.trim()) return err('type is required');
  if (!title || !title.trim()) return err('title is required');
  if (!VALID_TYPES.includes(type)) return err('Invalid type');

  const itemStatus = status || 'want';
  if (!VALID_STATUSES.includes(itemStatus)) return err('Invalid status');

  const { results } = await env.THEO_OS_DB.prepare(`
    INSERT INTO collections (type, title, notes, source, status)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `).bind(
    type.trim(),
    title.trim(),
    notes || null,
    source || null,
    itemStatus
  ).all();

  return json(results[0], 201);
}
