import { json, err, requireAdmin } from '../_utils.js';

// POST /api/theo-os/insights/run — manually trigger weekly insight generation
export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  const today = new Date().toISOString().split('T')[0];
  let areaActivity = [], overduePeople = [], staleGoals = [], staleCollectionsCount = 0, lifeVision = [];

  let recentJournal = [];
  try {
    const [areaRes, peopleRes, goalsRes, visionRes, journalRes] = await Promise.all([
      env.THEO_OS_DB.prepare(`
        SELECT area, MAX(last_active) as last_active FROM (
          SELECT area, MAX(updated_at) as last_active FROM tasks WHERE updated_at >= datetime('now', '-14 days') GROUP BY area
          UNION ALL
          SELECT area, MAX(updated_at) as last_active FROM goals WHERE updated_at >= datetime('now', '-14 days') GROUP BY area
        ) GROUP BY area`).all(),
      env.THEO_OS_DB.prepare(
        `SELECT name, relationship, next_touchpoint FROM people WHERE next_touchpoint IS NOT NULL AND next_touchpoint <= ?`
      ).bind(today).all(),
      env.THEO_OS_DB.prepare(`
        SELECT g.title, g.area FROM goals g WHERE g.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.goal_id = g.id AND t.updated_at >= datetime('now', '-30 days'))`).all(),
      env.THEO_OS_DB.prepare(
        `SELECT area, vision, current_phase FROM life_vision WHERE vision IS NOT NULL`
      ).all(),
      env.THEO_OS_DB.prepare(
        `SELECT content, created_at FROM journal WHERE created_at >= datetime('now', '-14 days') ORDER BY created_at DESC LIMIT 8`
      ).all().catch(() => ({ results: [] })),
    ]);
    areaActivity = areaRes.results || [];
    overduePeople = peopleRes.results || [];
    staleGoals = goalsRes.results || [];
    lifeVision = visionRes.results || [];
    recentJournal = (journalRes.results || []).map(j => `[${j.created_at?.slice(0, 10)}] ${j.content?.slice(0, 250)}`);
    const staleCollRes = await env.THEO_OS_DB.prepare(
      `SELECT COUNT(*) as count FROM collections WHERE status = 'want' AND created_at <= datetime('now', '-30 days')`
    ).first();
    staleCollectionsCount = staleCollRes?.count || 0;
  } catch (e) {
    return err('Failed to load data', 500);
  }

  const activeAreas = new Set(areaActivity.map(a => a.area));
  const visionText = lifeVision.length > 0
    ? lifeVision.map(v => `${v.area}: "${v.vision}"${v.current_phase ? ` (current phase: ${v.current_phase})` : ''}`).join('\n')
    : 'No life vision recorded.';
  const driftingAreas = lifeVision.filter(v => !activeAreas.has(v.area)).map(v => v.area);
  const journalText = recentJournal.length > 0 ? recentJournal.join('\n') : 'none';

  const prompt = `You are analyzing the past 14 days of Theo's life. Generate 3-5 honest, specific observations about patterns, alignment with stated intentions, and what the data actually suggests.

Important: the logged activity data only reflects what was captured in this OS. Journal entries are the ground truth of what was actually happening — weight them heavily. If the journal describes real work or focus that doesn't show up in task/goal logs, that means the OS is undercaptured, not that the work didn't happen.

What Theo says matters to him (life vision):
${visionText}

Logged activity in OS (last 14 days — may be incomplete):
- Active life areas: ${areaActivity.length > 0 ? areaActivity.map(a => `${a.area} (last: ${a.last_active})`).join(', ') : 'none logged'}
- Areas with stated vision but no logged activity: ${driftingAreas.length > 0 ? driftingAreas.join(', ') : 'none'}
- People overdue for contact: ${overduePeople.length > 0 ? overduePeople.map(p => `${p.name} (${p.relationship})`).join(', ') : 'none'}
- Goals with no recent task progress: ${staleGoals.length > 0 ? staleGoals.map(g => `${g.title} [${g.area}]`).join(', ') : 'none'}
- Collections waiting over 30 days: ${staleCollectionsCount} items

Journal entries (last 14 days — ground truth of what was actually happening):
${journalText}

Rules:
- Journal entries override logged activity as evidence of what actually happened
- If journal and logs conflict, trust the journal and note the capture gap
- Where behavior contradicts stated vision AND the journal confirms it, name it directly
- Do not claim drift or inactivity if the journal suggests otherwise
- Be specific, not generic

Return JSON array only: [{area, insight, type}] where type is one of: drift, decay, pattern, relationship`;

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 800, messages: [{ role: 'user', content: prompt }] })
  }).catch(() => null);

  if (!aiRes?.ok) return err('AI generation failed', 502);

  const aiData = await aiRes.json().catch(() => null);
  const rawText = aiData?.content?.[0]?.text;
  if (!rawText) return err('No response from AI', 502);

  let insights;
  try {
    const match = rawText.match(/\[[\s\S]*\]/);
    insights = match ? JSON.parse(match[0]) : JSON.parse(rawText);
  } catch { return err('Failed to parse insights', 502); }
  if (!Array.isArray(insights)) return err('Invalid insights format', 502);

  const now = new Date().toISOString();
  let created = 0;
  for (const insight of insights.slice(0, 5)) {
    if (typeof insight.insight !== 'string') continue;
    await env.THEO_OS_DB.prepare(
      `INSERT INTO insights_log (area, insight, type, surfaced_at, dismissed) VALUES (?, ?, ?, ?, 0)`
    ).bind(
      typeof insight.area === 'string' ? insight.area : 'general',
      insight.insight,
      typeof insight.type === 'string' ? insight.type : 'pattern',
      now
    ).run().catch(() => null);
    created++;
  }

  // Return the freshly created insights so dashboard can render immediately
  const { results: fresh } = await env.THEO_OS_DB.prepare(
    `SELECT * FROM insights_log WHERE dismissed = 0 ORDER BY surfaced_at DESC LIMIT 5`
  ).all();

  return json({ created, insights: fresh || [] }, 200, request);
}
