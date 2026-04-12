import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const body = await request.json().catch(() => ({}));
  const { type, title } = body;
  if (!type || !title) return err('type and title required');

  const tableMap = {
    task: { table: 'tasks', field: 'title' },
    goal: { table: 'goals', field: 'title' },
    collection: { table: 'collections', field: 'title' },
    person: { table: 'people', field: 'name' },
  };

  const mapping = tableMap[type];
  if (!mapping) return json({ match: null });

  const { results } = await env.THEO_OS_DB.prepare(
    `SELECT id, ${mapping.field} as label, weight FROM ${mapping.table} ORDER BY weight DESC, id DESC LIMIT 50`
  ).all();

  const normalize = s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const words = s => new Set(normalize(s).split(/\s+/).filter(w => w.length > 3));

  const titleWords = words(title);
  let bestMatch = null;
  let bestScore = 0;

  for (const record of results) {
    const recordWords = words(record.label);
    const intersection = [...titleWords].filter(w => recordWords.has(w));
    const union = new Set([...titleWords, ...recordWords]);
    const score = union.size === 0 ? 0 : intersection.length / union.size;

    if (score > bestScore) {
      bestScore = score;
      bestMatch = record;
    }
  }

  if (bestScore < 0.4 || !bestMatch) return json({ match: null });

  return json({
    match: {
      id: bestMatch.id,
      label: bestMatch.label,
      type,
      score: Math.round(bestScore * 100)
    }
  });
}
