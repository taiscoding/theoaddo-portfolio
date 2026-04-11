import { json, err, requireAdmin } from '../_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const [tasks, goals, people, collections, journal] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT id, 'task' as type, title, area as meta, created_at FROM tasks ORDER BY created_at DESC LIMIT 10`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, 'goal' as type, title, area as meta, created_at FROM goals ORDER BY created_at DESC LIMIT 5`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, 'person' as type, name as title, relationship as meta, created_at FROM people ORDER BY created_at DESC LIMIT 5`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, type, title, source as meta, created_at FROM collections ORDER BY created_at DESC LIMIT 10`).all(),
    env.THEO_OS_DB.prepare(`SELECT id, 'journal' as type, substr(content, 1, 80) as title, tags as meta, created_at FROM journal ORDER BY created_at DESC LIMIT 5`).all(),
  ]);

  const all = [
    ...tasks.results,
    ...goals.results,
    ...people.results,
    ...collections.results,
    ...journal.results
  ].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20);

  return json({ recent: all });
}
