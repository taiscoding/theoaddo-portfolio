// Standalone Cloudflare Worker for scheduled cron jobs.
// Shares the same D1 and KV bindings as the Pages project.
// Schedules: 0 6 * * * (morning briefing), 0 10 * * 0 (weekly insights)

async function getGoogleToken(env, account = 'primary') {
  const key = `google_tokens:${account}`;
  const stored = await env.THEO_OS_KV.get(key);
  if (!stored) return null;
  const tokens = JSON.parse(stored);
  if (tokens.expiry_date && tokens.expiry_date > Date.now() + 60000) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const refreshed = await res.json();
  if (!refreshed.access_token) { await env.THEO_OS_KV.delete(key); return null; }
  const updated = { ...tokens, ...refreshed, expiry_date: Date.now() + refreshed.expires_in * 1000 };
  await env.THEO_OS_KV.put(key, JSON.stringify(updated), { expirationTtl: 30 * 24 * 3600 });
  return refreshed.access_token;
}

async function runMorningBriefing(env) {
  const today = new Date().toISOString().split('T')[0];
  const kvKey = `briefing:${today}`;

  const existing = await env.THEO_OS_KV.get(kvKey);
  if (existing) return;

  const token = await getGoogleToken(env).catch(() => null);

  let gmailUnread = 0, gmailSubjects = [], calendarEvents = [];

  if (token) {
    const gmailRes = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=3',
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => null);

    if (gmailRes?.ok) {
      const gmailData = await gmailRes.json();
      gmailUnread = gmailData.resultSizeEstimate || 0;
      const subjectFetches = (gmailData.messages || []).slice(0, 3).map(m =>
        fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject`,
          { headers: { Authorization: `Bearer ${token}` } }
        ).then(r => r.ok ? r.json() : null).catch(() => null)
      );
      gmailSubjects = (await Promise.all(subjectFetches))
        .filter(Boolean)
        .map(d => (d.payload?.headers || []).find(h => h.name === 'Subject')?.value || '(no subject)');
    }

    const todayISO = `${today}T00:00:00Z`;
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowISO = `${tomorrow.toISOString().split('T')[0]}T00:00:00Z`;
    const calRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(todayISO)}&timeMax=${encodeURIComponent(tomorrowISO)}&singleEvents=true&orderBy=startTime`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => null);
    if (calRes?.ok) {
      const calData = await calRes.json();
      calendarEvents = (calData.items || []).map(e => ({
        summary: e.summary || '(untitled)',
        start: e.start?.dateTime || e.start?.date || ''
      }));
    }
  }

  let overdueTasks = [], dueTodayTasks = [], activeGoalsCount = 0;
  try {
    const [overdueRes, dueTodayRes, activeGoalsRes] = await Promise.all([
      env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?`).bind(today).all(),
      env.THEO_OS_DB.prepare(`SELECT title, area FROM tasks WHERE status = 'today' OR (status != 'done' AND due_date = ?)`).bind(today).all(),
      env.THEO_OS_DB.prepare(`SELECT area, COUNT(*) as count FROM goals WHERE status = 'active' GROUP BY area`).all(),
    ]);
    overdueTasks = overdueRes.results || [];
    dueTodayTasks = dueTodayRes.results || [];
    activeGoalsCount = (activeGoalsRes.results || []).reduce((sum, r) => sum + r.count, 0);
  } catch (_) {}

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
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
  });
  if (!aiRes.ok) return;

  const aiData = await aiRes.json();
  const briefingText = aiData.content?.[0]?.text;
  if (!briefingText) return;

  await env.THEO_OS_KV.put(kvKey, JSON.stringify({
    text: briefingText,
    generated_at: new Date().toISOString(),
    data: { date: today, gmail_unread: gmailUnread, gmail_subjects: gmailSubjects, calendar_events: calendarEvents, due_today: dueTodayTasks, overdue_tasks: overdueTasks.length, active_goals: activeGoalsCount }
  }), { expirationTtl: 48 * 3600 });
}

async function runWeeklyInsights(env) {
  const lastRun = await env.THEO_OS_KV.get('insights:last_run');
  if (lastRun && (Date.now() - new Date(lastRun).getTime()) / 86400000 < 6) return;

  const today = new Date().toISOString().split('T')[0];
  let areaActivity = [], overduePeople = [], staleGoals = [], staleCollectionsCount = 0;
  try {
    const [areaRes, peopleRes, goalsRes] = await Promise.all([
      env.THEO_OS_DB.prepare(`
        SELECT area, MAX(last_active) as last_active FROM (
          SELECT area, MAX(updated_at) as last_active FROM tasks WHERE updated_at >= datetime('now', '-14 days') GROUP BY area
          UNION ALL
          SELECT area, MAX(updated_at) as last_active FROM goals WHERE updated_at >= datetime('now', '-14 days') GROUP BY area
        ) GROUP BY area`).all(),
      env.THEO_OS_DB.prepare(`SELECT name, relationship, next_touchpoint FROM people WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= ?`).bind(today).all(),
      env.THEO_OS_DB.prepare(`
        SELECT g.title, g.area FROM goals g WHERE g.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.updated_at >= datetime('now', '-30 days'))`).all(),
    ]);
    areaActivity = areaRes.results || [];
    overduePeople = peopleRes.results || [];
    staleGoals = goalsRes.results || [];
    const staleCollRes = await env.THEO_OS_DB.prepare(`SELECT COUNT(*) as count FROM collections WHERE status = 'want' AND created_at <= datetime('now', '-30 days')`).first();
    staleCollectionsCount = staleCollRes?.count || 0;
  } catch (_) {}

  const prompt = `You are analyzing behavioral data for a personal life OS. Generate 3-5 behavioral pattern observations.

Data:
- Life area activity (last 14 days): ${areaActivity.length > 0 ? areaActivity.map(a => `${a.area}: last active ${a.last_active}`).join(', ') : 'no activity recorded'}
- People overdue for contact: ${overduePeople.length > 0 ? overduePeople.map(p => `${p.name} (${p.relationship}, overdue since ${p.next_touchpoint})`).join(', ') : 'none'}
- Goals with no recent task progress: ${staleGoals.length > 0 ? staleGoals.map(g => `${g.title} [${g.area}]`).join(', ') : 'none'}
- Collections waiting over 30 days: ${staleCollectionsCount} items

Write observations that are honest and specific. Return JSON array: [{area, insight, type}] where type is one of: drift, decay, pattern, relationship`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: prompt }] })
  });
  if (!aiRes.ok) return;

  const aiData = await aiRes.json();
  const rawText = aiData.content?.[0]?.text;
  if (!rawText) return;

  let insights;
  try {
    const match = rawText.match(/\[[\s\S]*\]/);
    insights = match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch { return; }
  if (!Array.isArray(insights)) return;

  const now = new Date().toISOString();
  for (const insight of insights.slice(0, 5)) {
    await env.THEO_OS_DB.prepare(
      `INSERT INTO insights_log (area, insight, type, surfaced_at, dismissed) VALUES (?, ?, ?, ?, 0)`
    ).bind(
      typeof insight.area === 'string' ? insight.area : 'general',
      typeof insight.insight === 'string' ? insight.insight : String(insight.insight),
      typeof insight.type === 'string' ? insight.type : 'pattern',
      now
    ).run();
  }

  await env.THEO_OS_KV.put('insights:last_run', new Date().toISOString());
}

async function consolidateMemories(env) {
  // 1. Decay all memories not reinforced in 14+ days (skip manual)
  await env.THEO_OS_DB.prepare(`
    UPDATE memories
    SET confidence = MAX(0.1, confidence - 0.05),
        updated_at = datetime('now')
    WHERE last_reinforced <= date('now', '-14 days')
      AND source != 'manual'
  `).run();

  // 2. Pull recent chat sessions (last 7 days) for cross-referencing
  const { results: recentSessions } = await env.THEO_OS_DB.prepare(
    `SELECT summary FROM chat_memory WHERE created_at >= datetime('now', '-7 days') ORDER BY created_at DESC LIMIT 10`
  ).all();

  if (recentSessions.length === 0) return;

  // 3. Pull existing low-confidence memories for potential revision
  const { results: weakMemories } = await env.THEO_OS_DB.prepare(
    `SELECT id, type, content, confidence FROM memories WHERE confidence < 0.4 LIMIT 10`
  ).all();

  if (!weakMemories.length) return;

  const sessionText = recentSessions.map(s => s.summary).join('\n');
  const weakText = weakMemories.map(m => `[${m.id}] ${m.type}: ${m.content} (conf: ${m.confidence})`).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are reviewing weak memories against recent session data.

Recent sessions:
${sessionText}

Weak memories (below 0.4 confidence):
${weakText}

For each weak memory, decide: "reinforce" (recent sessions support it) or "delete" (contradicted or irrelevant).
Return JSON: [{"id": N, "action": "reinforce"|"delete"}]`
      }]
    })
  });

  if (!res.ok) return;
  const data = await res.json();
  const raw = data.content?.[0]?.text;
  if (!raw) return;

  let decisions;
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    decisions = match ? JSON.parse(match[0]) : JSON.parse(raw);
  } catch { return; }

  for (const d of (decisions || [])) {
    if (d.action === 'delete') {
      await env.THEO_OS_DB.prepare(`DELETE FROM memories WHERE id = ? AND source != 'manual'`).bind(d.id).run();
    } else if (d.action === 'reinforce') {
      await env.THEO_OS_DB.prepare(
        `UPDATE memories SET confidence = MIN(1.0, confidence + 0.1), last_reinforced = datetime('now'), updated_at = datetime('now') WHERE id = ?`
      ).bind(d.id).run();
    }
  }
}

async function consolidateKnowledge(env) {
  // Recalculate decay_score for all notes using Ebbinghaus formula: e^(-k * days_since_review)
  // k values: aware=0.14, familiar=0.05, fluent=0.02
  // Uses SQLite's exp() function — one UPDATE per depth level
  const depthK = [
    { depth: 'aware', k: 0.14 },
    { depth: 'familiar', k: 0.05 },
    { depth: 'fluent', k: 0.02 }
  ];

  for (const { depth, k } of depthK) {
    await env.THEO_OS_DB.prepare(`
      UPDATE knowledge_notes
      SET decay_score = exp(-${k} * MAX(0, CAST((julianday('now') - julianday(COALESCE(last_reviewed, created_at))) AS REAL))),
          updated_at = datetime('now')
      WHERE depth = ?
    `).bind(depth).run().catch(() => {});
  }

  // Set next_review for notes that don't have one yet (first-time scheduling by depth)
  await env.THEO_OS_DB.prepare(`
    UPDATE knowledge_notes
    SET next_review = CASE depth
      WHEN 'aware'    THEN date('now', '+3 days')
      WHEN 'familiar' THEN date('now', '+7 days')
      WHEN 'fluent'   THEN date('now', '+21 days')
    END,
    updated_at = datetime('now')
    WHERE next_review IS NULL
  `).run().catch(() => {});

  // Flag severely faded notes (decay < 0.2) as a KV hint for tomorrow's briefing
  try {
    const { results: severelyFaded } = await env.THEO_OS_DB.prepare(
      `SELECT title FROM knowledge_notes WHERE decay_score < 0.2 ORDER BY decay_score ASC LIMIT 10`
    ).all();

    if (severelyFaded.length > 0) {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
      await env.THEO_OS_KV.put(
        `knowledge_drift:${tomorrow}`,
        JSON.stringify(severelyFaded.map(n => n.title)),
        { expirationTtl: 48 * 3600 }
      );
    }
  } catch (_) {}
}

async function runConnectionInference(env) {
  try {
    let goals = [], knowledge = [], tasks = [];
    const [goalsRes, knowledgeRes, tasksRes] = await Promise.all([
      env.THEO_OS_DB.prepare(`SELECT id, title, area FROM goals WHERE status = 'active' LIMIT 25`).all(),
      env.THEO_OS_DB.prepare(`SELECT id, title, area, depth FROM knowledge_notes LIMIT 30`).all(),
      env.THEO_OS_DB.prepare(`SELECT id, title, area FROM tasks WHERE status != 'done' LIMIT 30`).all(),
    ]).catch(() => [{ results: [] }, { results: [] }, { results: [] }]);
    goals = goalsRes.results || [];
    knowledge = knowledgeRes.results || [];
    tasks = tasksRes.results || [];

    if (goals.length + knowledge.length + tasks.length < 2) return;

    const entityList = [
      ...goals.map(g => `goal:${g.id} "${g.title}" [area: ${g.area || 'general'}]`),
      ...knowledge.map(k => `knowledge:${k.id} "${k.title}" [area: ${k.area || 'general'}, depth: ${k.depth}]`),
      ...tasks.map(t => `task:${t.id} "${t.title}" [area: ${t.area || 'general'}]`),
    ].join('\n');

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: `You are analyzing a personal life OS. Identify meaningful connections between the entities below.

Entities (format: type:id "title" [metadata]):
${entityList}

Rules:
- Only connect entities that genuinely relate (a knowledge concept supports a goal, a task advances a goal, a topic relates to another topic)
- Prefer strong, specific relationships over vague ones
- Labels should be short: "supports", "requires", "relates to", "builds on", "part of", "enables"
- Generate 5-15 connections maximum
- Do NOT connect things just because they share an area

Return a JSON array only, no markdown:
[{"from_type":"goal","from_id":1,"to_type":"knowledge","to_id":2,"label":"requires"}]`
        }]
      })
    }).catch(() => null);

    if (!aiRes?.ok) return;

    const aiData = await aiRes.json().catch(() => null);
    const raw = aiData?.content?.[0]?.text;
    if (!raw) return;

    let connections;
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      connections = match ? JSON.parse(match[0]) : JSON.parse(raw);
    } catch { return; }
    if (!Array.isArray(connections)) return;

    const VALID_TYPES = new Set(['goal', 'knowledge', 'task', 'person', 'journal']);

    let existing = [];
    try {
      const { results } = await env.THEO_OS_DB.prepare(
        `SELECT from_type, from_id, to_type, to_id FROM connections LIMIT 2000`
      ).all();
      existing = results || [];
    } catch (_) {}

    const existingSet = new Set(
      existing.map(c => `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`)
    );

    for (const c of connections.slice(0, 15)) {
      if (!c.from_type || !c.from_id || !c.to_type || !c.to_id) continue;
      if (!VALID_TYPES.has(c.from_type) || !VALID_TYPES.has(c.to_type)) continue;
      const key = `${c.from_type}:${c.from_id}->${c.to_type}:${c.to_id}`;
      if (existingSet.has(key)) continue;
      existingSet.add(key);
      await env.THEO_OS_DB.prepare(
        `INSERT INTO connections (from_id, from_type, to_id, to_type, label, inferred, created_at)
         VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`
      ).bind(Number(c.from_id), String(c.from_type), Number(c.to_id), String(c.to_type), String(c.label || '').slice(0, 60)).run().catch(() => {});
    }
  } catch (_) {}
}

export default {
  async fetch(request, env, ctx) {
    // Health check only — all real traffic goes to Pages
    return new Response('theo-os-cron ok', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    if (event.cron === '0 6 * * *') ctx.waitUntil(runMorningBriefing(env));
    else if (event.cron === '0 10 * * 7') {
      ctx.waitUntil(runWeeklyInsights(env));
      ctx.waitUntil(consolidateMemories(env));
      ctx.waitUntil(consolidateKnowledge(env));
      ctx.waitUntil(runConnectionInference(env));
    }
  }
};
