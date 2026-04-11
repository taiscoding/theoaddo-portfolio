import { json, err, requireAdmin, loadMemoryContext } from '../_utils.js';

async function callAnthropic(messages, systemPrompt, env) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages
    })
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(`Anthropic API error: ${errData.error?.message || res.status}`);
  }
  return res.json();
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 19);
  const today = new Date().toISOString().split('T')[0];

  // Query context in parallel
  let completedTasks = [];
  let slippedTasks = [];
  let weekInsights = [];
  let noProgressGoals = [];

  try {
    const [completedRes, slippedRes, insightsRes, goalsRes] = await Promise.all([
      env.THEO_OS_DB.prepare(
        `SELECT title, area, updated_at FROM tasks
         WHERE status = 'done' AND updated_at >= ?
         ORDER BY area ASC, updated_at DESC`
      ).bind(sevenDaysAgo).all(),

      env.THEO_OS_DB.prepare(
        `SELECT title, area, due_date FROM tasks
         WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?
         ORDER BY due_date ASC LIMIT 20`
      ).bind(today).all(),

      env.THEO_OS_DB.prepare(
        `SELECT insight, area, type FROM insights_log
         WHERE surfaced_at >= ? AND dismissed = 0
         ORDER BY surfaced_at DESC LIMIT 10`
      ).bind(sevenDaysAgo).all(),

      env.THEO_OS_DB.prepare(
        `SELECT g.title, g.area FROM goals g
         WHERE g.status = 'active'
         AND g.id NOT IN (
           SELECT DISTINCT goal_id FROM tasks
           WHERE status = 'done' AND updated_at >= ? AND goal_id IS NOT NULL
         )
         ORDER BY g.area ASC LIMIT 10`
      ).bind(sevenDaysAgo).all()
    ]);

    completedTasks = completedRes.results || [];
    slippedTasks = slippedRes.results || [];
    weekInsights = insightsRes.results || [];
    noProgressGoals = goalsRes.results || [];
  } catch (e) {
    // Proceed with empty context if DB queries fail
  }

  // Build context summary
  const completedByArea = {};
  for (const task of completedTasks) {
    const area = task.area || 'general';
    if (!completedByArea[area]) completedByArea[area] = [];
    completedByArea[area].push(task.title);
  }

  let completedSummary;
  if (completedTasks.length === 0) {
    completedSummary = 'nothing recorded yet';
  } else {
    completedSummary = Object.entries(completedByArea)
      .map(([area, titles]) => `${area}: ${titles.join(', ')}`)
      .join(' | ');
  }

  const contextData = {
    completedTasks,
    slippedTasks,
    weekInsights,
    noProgressGoals,
    completedSummary
  };

  const memory = await loadMemoryContext(env);

  // Call Anthropic to generate the Step 1 question
  const systemPrompt = `You are Theo's weekly review facilitator. You generate focused, honest questions for a structured weekly review.

Known patterns about Theo (use to make questions specific, not generic):
${memory.patterns}

Do not ask about things already well-understood. Probe the areas where patterns show avoidance or drift.

Keep questions grounded — reference real data when available. Be direct, not motivational.
Your response should be ONLY a JSON object with two fields: "question" (the Step 1 question string) and "context" (a brief 2-3 sentence context summary of what the system found this week).`;

  const userPrompt = `Generate the Step 1 opening question for Theo's weekly review.

Completed tasks this week: ${completedSummary}
Slipped tasks (overdue): ${slippedTasks.length > 0 ? slippedTasks.map(t => t.title).join(', ') : 'none'}
Insights this week: ${weekInsights.length > 0 ? weekInsights.map(i => i.insight).join(' | ') : 'none'}
Goals with no progress: ${noProgressGoals.length > 0 ? noProgressGoals.map(g => g.title).join(', ') : 'none'}

The Step 1 question should ask: "Looking at this week, what did you complete across each area of your life? Here's what the system tracked: [list of completed tasks by area, or 'nothing recorded yet']"

Make the question personal and specific to the data. The context field should briefly summarize what the system found (tasks done, slipped, patterns surfaced).`;

  let question = `Looking at this week, what did you complete across each area of your life? Here's what the system tracked: ${completedSummary}.`;
  let context = `The system found ${completedTasks.length} completed task(s) this week${slippedTasks.length > 0 ? `, ${slippedTasks.length} slipped task(s)` : ''}${weekInsights.length > 0 ? `, and ${weekInsights.length} behavioral pattern(s) surfaced` : ''}.`;

  try {
    const aiRes = await callAnthropic(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      env
    );

    const rawText = (aiRes.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    // Extract JSON from response
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.question) question = parsed.question;
      if (parsed.context) context = parsed.context;
    }
  } catch (_) {
    // Use fallback question/context defined above
  }

  return json({
    step: 1,
    question,
    context,
    _data: {
      completedCount: completedTasks.length,
      slippedCount: slippedTasks.length,
      insightsCount: weekInsights.length,
      noProgressGoalsCount: noProgressGoals.length,
      // Pass full data so next.js can use it in subsequent steps
      slippedTasks: slippedTasks.slice(0, 10),
      weekInsights: weekInsights.slice(0, 5),
      noProgressGoals: noProgressGoals.slice(0, 5)
    }
  });
}
