import { json, err, requireAdmin, loadMemoryContext } from '../_utils.js';

const KV_KEY = 'time:now:digest';
const KV_TTL = 4 * 3600; // 4 hours max, but invalidated on write

const NOW_SYSTEM = `You are generating a short "now" digest for Theo OS.
Given open tasks, upcoming goals, and overdue touchpoints, write 3-5 sentences
that feel like a trusted friend catching you up on what actually matters right now.
Not a list — a paragraph. Calm, honest, direct. No alarm language.
Return plain text only, no JSON, no markdown.`;

export async function onRequestGet({ request, env, ctx }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  // Check cache first
  if (!force) {
    try {
      const cached = await env.THEO_OS_KV.get(KV_KEY, { type: 'json' });
      if (cached) return json(cached);
    } catch { /* cache miss is fine */ }
  }

  // Build context from DB
  let taskLines = '', goalLines = '', peopleLines = '';
  try {
    const { results: tasks } = await env.THEO_OS_DB.prepare(
      `SELECT title, due_date, area FROM tasks WHERE status != 'done'
       ORDER BY weight DESC, due_date ASC NULLS LAST LIMIT 10`
    ).all();
    taskLines = tasks.map(t => `- ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`).join('\n');

    const { results: goals } = await env.THEO_OS_DB.prepare(
      `SELECT title, target_date FROM goals ORDER BY weight DESC LIMIT 5`
    ).all();
    goalLines = goals.map(g => `- ${g.title}${g.target_date ? ` (target ${g.target_date})` : ''}`).join('\n');

    const { results: people } = await env.THEO_OS_DB.prepare(
      `SELECT name, next_touchpoint FROM people
       WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= date('now', '+7 days')
       ORDER BY next_touchpoint ASC LIMIT 5`
    ).all();
    peopleLines = people.map(p => `- ${p.name} (touchpoint ${p.next_touchpoint})`).join('\n');
  } catch (e) { console.warn('[time/now] DB context error:', e?.message); }

  const memory = await loadMemoryContext(env);

  let digest = 'Nothing urgent right now. You\'re on top of it.';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `${NOW_SYSTEM}\n\nUser context:\nFacts: ${memory.facts}\nPatterns: ${memory.patterns}`,
        messages: [{
          role: 'user',
          content: `Open tasks:\n${taskLines || 'none'}\n\nGoals:\n${goalLines || 'none'}\n\nUpcoming touchpoints:\n${peopleLines || 'none'}`
        }]
      })
    });
    if (res.ok) {
      const data = await res.json();
      digest = data.content?.[0]?.text?.trim() || digest;
    }
  } catch (e) { console.warn('[time/now] AI call failed:', e?.message); }

  const result = { digest, generated_at: new Date().toISOString() };

  // Cache it — fire and forget, never blocks response
  ctx.waitUntil(
    env.THEO_OS_KV.put(KV_KEY, JSON.stringify(result), { expirationTtl: KV_TTL }).catch(() => null)
  );

  return json(result);
}
