import { json, err, requireAdmin, AREAS } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const { results } = await env.THEO_OS_DB.prepare(
    'SELECT * FROM life_vision ORDER BY id ASC'
  ).all();

  // Build a keyed object; fill in defaults for any missing areas
  const byArea = {};
  for (const row of results) {
    byArea[row.area] = row;
  }

  for (const area of AREAS) {
    if (!byArea[area]) {
      byArea[area] = {
        area,
        vision: null,
        values: null,
        current_phase: null,
        success_definition: null,
        updated_at: null
      };
    }
  }

  return json(byArea);
}

export async function onRequestPut({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { area, vision, values, current_phase, success_definition } = body;

  if (!area) return err('area is required');
  if (!AREAS.includes(area)) return err('Invalid area');

  let results;
  try {
    ({ results } = await env.THEO_OS_DB.prepare(`
      INSERT INTO life_vision (area, vision, "values", current_phase, success_definition, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(area) DO UPDATE SET
        vision = excluded.vision,
        "values" = excluded."values",
        current_phase = excluded.current_phase,
        success_definition = excluded.success_definition,
        updated_at = datetime('now')
      RETURNING *
    `).bind(
      area,
      vision || null,
      values || null,
      current_phase || null,
      success_definition || null
    ).all());
  } catch {
    return err('Database error', 500);
  }

  return json(results[0]);
}
