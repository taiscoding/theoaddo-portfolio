import { json, err, requireAdmin } from './_utils.js';

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

  const [overdue, dueToday, upcomingGoals, overduePeople] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status = 'today' OR (status != 'done' AND due_date = ?)`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, area, target_date FROM goals WHERE status = 'active' AND target_date IS NOT NULL AND target_date BETWEEN ? AND date(?, '+30 days')`).bind(today, today).all(),
    env.THEO_OS_DB.prepare(`SELECT name, relationship FROM people WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= ?`).bind(today).all(),
  ]);

  const context = {
    date: today,
    overdue_tasks: overdue.results,
    due_today: dueToday.results,
    upcoming_goal_deadlines: upcomingGoals.results,
    overdue_relationships: overduePeople.results,
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
Data: ${JSON.stringify(context, null, 2)}

Write 2-3 short paragraphs. First: what today looks like (tasks due, overdue items).
Second: what needs attention (relationships, upcoming deadlines).
Third: one honest observation about momentum based on the context.
No greeting. No filler. Just signal. If there's nothing to report in a section, skip it.`
      }]
    })
  });

  const aiData = await aiRes.json();
  const briefingText = aiData.content?.[0]?.text || 'No briefing available.';

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
