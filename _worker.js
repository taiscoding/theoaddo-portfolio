import { getGoogleToken } from './functions/api/theo-os/_utils.js';

async function runMorningBriefing(env) {
  const today = new Date().toISOString().split('T')[0];
  const kvKey = `briefing:${today}`;

  // Idempotency check
  const existing = await env.THEO_OS_KV.get(kvKey);
  if (existing) return;

  // Google token (optional — proceed without it if unavailable)
  const token = await getGoogleToken(env).catch(() => null);

  let gmailUnread = 0;
  let gmailSubjects = [];
  let calendarEvents = [];

  if (token) {
    // Gmail: unread count + top 3 subjects
    const gmailRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=3',
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => null);

    if (gmailRes && gmailRes.ok) {
      const gmailData = await gmailRes.json();
      gmailUnread = gmailData.resultSizeEstimate || 0;
      const messages = gmailData.messages || [];

      // Fetch subjects for top 3
      const subjectFetches = messages.slice(0, 3).map(m =>
        fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject`,
          { headers: { Authorization: `Bearer ${token}` } }
        ).then(r => r.ok ? r.json() : null).catch(() => null)
      );
      const msgDetails = await Promise.all(subjectFetches);
      gmailSubjects = msgDetails
        .filter(Boolean)
        .map(d => {
          const subjectHeader = (d.payload?.headers || []).find(h => h.name === 'Subject');
          return subjectHeader?.value || '(no subject)';
        });
    }

    // Google Calendar: today's events
    const todayISO = `${today}T00:00:00Z`;
    const tomorrowDate = new Date(today);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowISO = `${tomorrowDate.toISOString().split('T')[0]}T00:00:00Z`;

    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(todayISO)}&timeMax=${encodeURIComponent(tomorrowISO)}&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => null);

    if (calRes && calRes.ok) {
      const calData = await calRes.json();
      calendarEvents = (calData.items || []).map(e => ({
        summary: e.summary || '(untitled)',
        start: e.start?.dateTime || e.start?.date || ''
      }));
    }
  }

  // D1: overdue tasks and tasks due today
  const [overdueRes, dueTodayRes, activeGoalsRes] = await Promise.all([
    env.THEO_OS_DB.prepare(
      `SELECT title, area FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?`
    ).bind(today).all(),
    env.THEO_OS_DB.prepare(
      `SELECT title, area FROM tasks WHERE status = 'today' OR (status != 'done' AND due_date = ?)`
    ).bind(today).all(),
    env.THEO_OS_DB.prepare(
      `SELECT area, COUNT(*) as count FROM goals WHERE status = 'active' GROUP BY area`
    ).all(),
  ]);

  const overdueTasks = overdueRes.results || [];
  const dueTodayTasks = dueTodayRes.results || [];
  const activeGoals = activeGoalsRes.results || [];
  const activeGoalsCount = activeGoals.reduce((sum, r) => sum + r.count, 0);

  // Build Anthropic prompt
  const calendarText = calendarEvents.length > 0
    ? calendarEvents.map(e => `${e.summary} (${e.start})`).join(', ')
    : 'nothing scheduled';

  const dueTodayText = dueTodayTasks.length > 0
    ? dueTodayTasks.map(t => `${t.title} [${t.area}]`).join(', ')
    : 'none';

  const prompt = `Generate a brief, grounded morning briefing for Theo. Tone: clear, direct, slightly warm. Not cheerful or hype.

Context:
- Date: ${today}
- Gmail: ${gmailUnread} unread, top subjects: ${gmailSubjects.length > 0 ? gmailSubjects.join('; ') : 'n/a'}
- Calendar today: ${calendarText}
- Tasks due today: ${dueTodayText}
- Overdue tasks: ${overdueTasks.length}
- Active goals: ${activeGoalsCount}

Write 2-3 sentences that help him orient to the day. Focus on what actually needs attention. No platitudes.`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!aiRes.ok) return;

  const aiData = await aiRes.json();
  const briefingText = aiData.content?.[0]?.text;
  if (!briefingText) return;

  const briefing = {
    text: briefingText,
    generated_at: new Date().toISOString(),
    data: {
      date: today,
      gmail_unread: gmailUnread,
      gmail_subjects: gmailSubjects,
      calendar_events: calendarEvents,
      due_today: dueTodayTasks,
      overdue_tasks: overdueTasks.length,
      active_goals: activeGoalsCount
    }
  };

  await env.THEO_OS_KV.put(kvKey, JSON.stringify(briefing), {
    expirationTtl: 48 * 3600
  });
}

async function runWeeklyInsights(env) {
  // Idempotency: skip if run in last 6 days
  const lastRun = await env.THEO_OS_KV.get('insights:last_run');
  if (lastRun) {
    const diffMs = Date.now() - new Date(lastRun).getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays < 6) return;
  }

  const today = new Date().toISOString().split('T')[0];

  // Area activity last 14 days
  const { results: areaActivity } = await env.THEO_OS_DB.prepare(`
    SELECT area, MAX(last_active) as last_active FROM (
      SELECT area, MAX(updated_at) as last_active FROM tasks
        WHERE updated_at >= datetime('now', '-14 days') GROUP BY area
      UNION ALL
      SELECT area, MAX(updated_at) as last_active FROM goals
        WHERE updated_at >= datetime('now', '-14 days') GROUP BY area
    ) GROUP BY area
  `).all();

  // People overdue for contact
  const { results: overduePeople } = await env.THEO_OS_DB.prepare(
    `SELECT name, relationship, next_touchpoint FROM people WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= ?`
  ).bind(today).all();

  // Goals with no task activity in 30 days
  const { results: staleGoals } = await env.THEO_OS_DB.prepare(`
    SELECT g.title, g.area FROM goals g
    WHERE g.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM tasks t
      WHERE t.goal_id = g.id AND t.updated_at >= datetime('now', '-30 days')
    )
  `).all();

  // Collections: want items added more than 30 days ago still with status 'want'
  const staleCollectionsRes = await env.THEO_OS_DB.prepare(`
    SELECT COUNT(*) as count FROM collections
    WHERE status = 'want' AND created_at <= datetime('now', '-30 days')
  `).first();
  const staleCollectionsCount = staleCollectionsRes?.count || 0;

  // Build Anthropic prompt
  const areaActivityText = areaActivity.length > 0
    ? areaActivity.map(a => `${a.area}: last active ${a.last_active}`).join(', ')
    : 'no activity recorded';

  const overduePeopleText = overduePeople.length > 0
    ? overduePeople.map(p => `${p.name} (${p.relationship}, overdue since ${p.next_touchpoint})`).join(', ')
    : 'none';

  const staleGoalsText = staleGoals.length > 0
    ? staleGoals.map(g => `${g.title} [${g.area}]`).join(', ')
    : 'none';

  const prompt = `You are analyzing behavioral data for a personal life OS. Generate 3-5 behavioral pattern observations.

Data:
- Life area activity (last 14 days): ${areaActivityText}
- People overdue for contact: ${overduePeopleText}
- Goals with no recent task progress: ${staleGoalsText}
- Collections waiting over 30 days: ${staleCollectionsCount} items

Write observations that are honest and specific. Examples of good observations:
- "You've added 8 restaurants but visited 0 in 90 days."
- "Health area has had no activity in 14 days."
- "3 people haven't heard from you in over a month."

Return JSON array: [{area, insight, type}]
where type is one of: drift, decay, pattern, relationship`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!aiRes.ok) return;

  const aiData = await aiRes.json();
  const rawText = aiData.content?.[0]?.text;
  if (!rawText) return;

  let insights;
  try {
    // Extract JSON array from response (model may wrap it in markdown)
    const match = rawText.match(/\[[\s\S]*\]/);
    insights = match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch {
    return;
  }

  if (!Array.isArray(insights)) return;

  // Write each insight to insights_log
  const now = new Date().toISOString();
  for (const insight of insights.slice(0, 5)) {
    const area = typeof insight.area === 'string' ? insight.area : 'general';
    const text = typeof insight.insight === 'string' ? insight.insight : String(insight.insight);
    const type = typeof insight.type === 'string' ? insight.type : 'pattern';

    await env.THEO_OS_DB.prepare(
      `INSERT INTO insights_log (area, insight, type, surfaced_at, dismissed) VALUES (?, ?, ?, ?, 0)`
    ).bind(area, text, type, now).run();
  }

  // Update last run timestamp
  await env.THEO_OS_KV.put('insights:last_run', today);
}

export default {
  async fetch(request, env, ctx) {
    // Let Pages Functions handle all fetch requests
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const cronExpr = event.cron;
    if (cronExpr === '0 6 * * *') {
      ctx.waitUntil(runMorningBriefing(env));
    } else if (cronExpr === '0 10 * * 0') {
      ctx.waitUntil(runWeeklyInsights(env));
    }
  }
};
