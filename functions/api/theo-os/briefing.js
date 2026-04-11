import { json, err, requireAdmin, loadMemoryContext } from './_utils.js';

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const today = new Date().toISOString().split('T')[0];
  const cached = await env.THEO_OS_KV.get(`briefing:${today}`);
  if (cached) return json({ briefing: JSON.parse(cached), cached: true });
  return json({ briefing: null, cached: false });
}

// Manual trigger — calls the generation logic directly for testing
export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);
  const today = new Date().toISOString().split('T')[0];

  const memory = await loadMemoryContext(env);

  const [overdue, dueToday, upcomingGoals, overduePeople, knowledgeDue] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status = 'today' OR (status != 'done' AND due_date = ?)`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, area, target_date FROM goals WHERE status = 'active' AND target_date IS NOT NULL AND target_date BETWEEN ? AND date(?, '+30 days')`).bind(today, today).all(),
    env.THEO_OS_DB.prepare(`SELECT name, relationship FROM people WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= ?`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, depth, decay_score FROM knowledge_notes WHERE next_review <= ? OR decay_score < 0.4 ORDER BY decay_score ASC LIMIT 5`).bind(today).all().catch(() => ({ results: [] })),
  ]);

  const knowledgeDueList = knowledgeDue.results || [];

  const context = {
    date: today,
    overdue_tasks: overdue.results,
    due_today: dueToday.results,
    upcoming_goal_deadlines: upcomingGoals.results,
    overdue_relationships: overduePeople.results,
    knowledge_due: knowledgeDueList,
  };

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Generate a morning briefing for Theo. Be direct and useful, not performative.

What you know about Theo:
- Patterns: ${memory.patterns}
- Preferences: ${memory.preferences}

Use this to calibrate tone and emphasis. If patterns show stress or avoidance, acknowledge it briefly. Don't mention the memory system explicitly.

Context: ${JSON.stringify(context, null, 2)}

Write 2-3 short paragraphs. First: what today looks like (tasks due, overdue items).
Second: what needs attention (relationships, upcoming deadlines).
Third: one honest observation about momentum based on the context.

If context.knowledge_due has items, add a brief line at the end naming the topics due for review (e.g. "3 knowledge areas due: X, Y, Z"). If decay is very low (<0.2), treat it like an overdue task — acknowledge the cognitive drift directly.
No greeting. No filler. Just signal. If there's nothing to report in a section, skip it.`
      }]
    })
  });

  if (!aiRes.ok) {
    const errData = await aiRes.json().catch(() => ({}));
    return err(`Anthropic API error: ${errData.error?.message || aiRes.status}`, 502);
  }
  const aiData = await aiRes.json();
  const briefingText = aiData.content?.[0]?.text;
  if (!briefingText) return err('Anthropic returned no content', 502);

  const briefing = {
    text: briefingText,
    generated_at: new Date().toISOString(),
    data: context
  };

  await env.THEO_OS_KV.put(`briefing:${today}`, JSON.stringify(briefing), {
    expirationTtl: 48 * 3600
  });

  return json({ briefing, cached: false });
}
