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

  const [overdue, dueToday, upcomingGoals, overduePeople, knowledgeDue, recentJournal, crossLinks] = await Promise.all([
    env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status = 'today' OR (status != 'done' AND due_date = ?)`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, area, target_date FROM goals WHERE status = 'active' AND target_date IS NOT NULL AND target_date BETWEEN ? AND date(?, '+30 days')`).bind(today, today).all(),
    env.THEO_OS_DB.prepare(`SELECT name, relationship FROM people WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= ?`).bind(today).all(),
    env.THEO_OS_DB.prepare(`SELECT title, depth, decay_score FROM knowledge_notes WHERE next_review <= ? OR decay_score < 0.4 ORDER BY decay_score ASC LIMIT 5`).bind(today).all().catch(() => ({ results: [] })),
    // Journal: what has Theo actually been thinking about recently
    env.THEO_OS_DB.prepare(`SELECT content, created_at FROM journal ORDER BY created_at DESC LIMIT 4`).all().catch(() => ({ results: [] })),
    // Cross-domain links: explicit connections between records
    env.THEO_OS_DB.prepare(`
      SELECT c.from_type, c.to_type, c.strength,
        CASE c.from_type
          WHEN 'task' THEN (SELECT title FROM tasks WHERE id = c.from_id)
          WHEN 'goal' THEN (SELECT title FROM goals WHERE id = c.from_id)
          WHEN 'collection' THEN (SELECT title FROM collections WHERE id = c.from_id)
          ELSE NULL
        END as from_label,
        CASE c.to_type
          WHEN 'person' THEN (SELECT name FROM people WHERE id = c.to_id)
          WHEN 'goal' THEN (SELECT title FROM goals WHERE id = c.to_id)
          WHEN 'task' THEN (SELECT title FROM tasks WHERE id = c.to_id)
          ELSE NULL
        END as to_label
      FROM connections c
      ORDER BY c.strength DESC LIMIT 15
    `).all().catch(() => ({ results: [] })),
  ]);

  const context = {
    date: today,
    overdue_tasks: overdue.results,
    due_today: dueToday.results,
    upcoming_goal_deadlines: upcomingGoals.results,
    overdue_relationships: overduePeople.results,
    knowledge_due: (knowledgeDue.results || []),
    recent_journal: (recentJournal.results || []).map(j => ({
      date: j.created_at,
      entry: j.content?.slice(0, 300)
    })),
    connections: (crossLinks.results || []).filter(c => c.from_label && c.to_label),
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
        content: `Here is everything relevant about Theo's life right now. What are the actual threads running through this — across tasks, goals, people, and what he's been writing about?

Known patterns: ${memory.patterns}
Known preferences: ${memory.preferences}

Context: ${JSON.stringify(context, null, 2)}

Don't summarize each domain separately. Look across them. If a task, a person, a journal entry, and a goal are all pulling at the same thing, name that thing. If there's a gap between what he's working on and what he's been thinking about, say so. If something is overdue that connects to something larger, make that connection explicit.

No headers. No structure. 2-3 paragraphs. Write from the context, not about it.`
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
