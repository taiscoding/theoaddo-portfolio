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
        content: `Here is Theo's context for today. Synthesize what actually matters — not a summary, not a structure, just what's real.

What you know:
- Patterns: ${memory.patterns}
- Preferences: ${memory.preferences}

Context: ${JSON.stringify(context, null, 2)}

What needs his attention today? What is the honest state of things? If something is overdue and matters, name it. If a relationship has been neglected, say so. If momentum is stalling somewhere, say that. If today is genuinely clear, say that too.

No headers. No "First... Second... Third..." structure. No filler sentences. 2-3 paragraphs. If knowledge areas are decaying, name them specifically. Write as if you are actually thinking about his life, not generating a report about it.`
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
