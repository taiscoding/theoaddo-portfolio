import { json, err, requireAdmin } from '../_utils.js';

// ---- Tool definitions ----

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for current information about any topic — websites, companies, people, news, products, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_life_summary',
    description: "Get a full picture of Theo's life: task counts by area/status, goal counts by area, active goals, upcoming tasks, area health.",
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_tasks',
    description: 'Get tasks filtered by area and/or status.',
    input_schema: {
      type: 'object',
      properties: {
        area: { type: 'string', description: 'Filter by life area' },
        status: { type: 'string', description: 'Filter by status: inbox, today, this_week, later, someday, done' }
      }
    }
  },
  {
    name: 'get_goals',
    description: 'Get goals filtered by area and/or status.',
    input_schema: {
      type: 'object',
      properties: {
        area: { type: 'string' },
        status: { type: 'string' }
      }
    }
  },
  {
    name: 'get_people',
    description: 'Get all people with relationship health status.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_insights',
    description: 'Get recent behavioral pattern insights from the MindMapper.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'add_task',
    description: 'Add a new task.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        area: { type: 'string' },
        status: { type: 'string', enum: ['inbox', 'today', 'this_week', 'later', 'someday'] },
        due_date: { type: 'string', description: 'YYYY-MM-DD' },
        notes: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'add_journal_entry',
    description: 'Add a journal entry.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        tags: { type: 'string' }
      },
      required: ['content']
    }
  },
  {
    name: 'update_task',
    description: "Update a task's status, area, or notes by ID.",
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        status: { type: 'string' },
        area: { type: 'string' },
        notes: { type: 'string' }
      },
      required: ['id']
    }
  }
];

// ---- Tool execution ----

function computeHealth(person) {
  if (!person.touchpoint_interval_days || !person.last_contact) return 'none';
  const daysSince = Math.floor((Date.now() - new Date(person.last_contact).getTime()) / 86400000);
  const interval = person.touchpoint_interval_days;
  if (daysSince <= interval) return 'green';
  if (daysSince <= interval * 1.5) return 'yellow';
  return 'red';
}

async function executeTool(name, input, env) {
  const today = new Date().toISOString().split('T')[0];
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

  switch (name) {
    case 'get_life_summary': {
      const [tasksByAreaStatus, goalsByArea, activeGoals, upcomingTasks] = await Promise.all([
        env.THEO_OS_DB.prepare(
          `SELECT area, status, COUNT(*) as count FROM tasks GROUP BY area, status`
        ).all(),
        env.THEO_OS_DB.prepare(
          `SELECT area, status, COUNT(*) as count FROM goals GROUP BY area, status`
        ).all(),
        env.THEO_OS_DB.prepare(
          `SELECT id, title, area, target_date FROM goals WHERE status = 'active' ORDER BY target_date ASC LIMIT 10`
        ).all(),
        env.THEO_OS_DB.prepare(
          `SELECT id, title, area, due_date, status FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date BETWEEN ? AND ? ORDER BY due_date ASC`
        ).bind(today, nextWeek).all(),
      ]);
      return {
        tasks_by_area_status: tasksByAreaStatus.results,
        goals_by_area: goalsByArea.results,
        active_goals: activeGoals.results,
        upcoming_tasks_7_days: upcomingTasks.results,
      };
    }

    case 'get_tasks': {
      let query = `SELECT * FROM tasks WHERE 1=1`;
      const binds = [];
      if (input.area) { query += ` AND area = ?`; binds.push(input.area); }
      if (input.status) { query += ` AND status = ?`; binds.push(input.status); }
      query += ` ORDER BY due_date ASC, created_at DESC LIMIT 50`;
      const stmt = binds.length
        ? env.THEO_OS_DB.prepare(query).bind(...binds)
        : env.THEO_OS_DB.prepare(query);
      const { results } = await stmt.all();
      return { tasks: results };
    }

    case 'get_goals': {
      let query = `SELECT * FROM goals WHERE 1=1`;
      const binds = [];
      if (input.area) { query += ` AND area = ?`; binds.push(input.area); }
      if (input.status) { query += ` AND status = ?`; binds.push(input.status); }
      query += ` ORDER BY target_date ASC, created_at DESC LIMIT 50`;
      const stmt = binds.length
        ? env.THEO_OS_DB.prepare(query).bind(...binds)
        : env.THEO_OS_DB.prepare(query);
      const { results } = await stmt.all();
      return { goals: results };
    }

    case 'get_people': {
      const { results } = await env.THEO_OS_DB.prepare(
        `SELECT * FROM people ORDER BY name ASC`
      ).all();
      return { people: (results || []).map(p => ({ ...p, health: computeHealth(p) })) };
    }

    case 'get_insights': {
      const { results } = await env.THEO_OS_DB.prepare(
        `SELECT * FROM insights_log WHERE dismissed = 0 ORDER BY surfaced_at DESC LIMIT 10`
      ).all();
      return { insights: results };
    }

    case 'add_task': {
      const { title, area, status, due_date, notes } = input;
      if (!title) return { error: 'title is required' };
      const { results } = await env.THEO_OS_DB.prepare(`
        INSERT INTO tasks (title, area, status, due_date, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        RETURNING *
      `).bind(
        String(title).trim(),
        area || null,
        status || 'inbox',
        due_date || null,
        notes || null
      ).all();
      return { task: results[0] };
    }

    case 'add_journal_entry': {
      const { content, tags } = input;
      if (!content) return { error: 'content is required' };
      const { results } = await env.THEO_OS_DB.prepare(`
        INSERT INTO journal (content, tags, created_at, updated_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
        RETURNING *
      `).bind(String(content).trim(), tags || null).all();
      return { entry: results[0] };
    }

    case 'update_task': {
      const { id, status, area, notes } = input;
      const taskId = Number(id);
      if (id == null || isNaN(taskId)) return { error: 'id is required' };
      const sets = [];
      const binds = [];
      if (status !== undefined) { sets.push('status = ?'); binds.push(status); }
      if (area !== undefined) { sets.push('area = ?'); binds.push(area); }
      if (notes !== undefined) { sets.push('notes = ?'); binds.push(notes); }
      if (sets.length === 0) return { error: 'no fields to update' };
      sets.push(`updated_at = datetime('now')`);
      binds.push(taskId);
      const { results } = await env.THEO_OS_DB.prepare(
        `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? RETURNING *`
      ).bind(...binds).all();
      return { task: results[0] || null };
    }

    case 'web_search': {
      const { query } = input;
      if (!query) return { error: 'query is required' };
      try {
        const tavRes = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: env.TAVILY_API_KEY,
            query,
            max_results: 5,
            search_depth: 'basic'
          })
        });
        if (!tavRes.ok) return { error: `Search failed: ${tavRes.status}` };
        const tavData = await tavRes.json();
        const results = (tavData.results || []).map(r => ({
          title: r.title,
          url: r.url,
          content: (r.content || '').slice(0, 400)
        }));
        return { results, query };
      } catch (e) {
        return { error: `Search error: ${e.message}` };
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function executeTools(contentBlocks, env) {
  const toolResults = [];
  for (const block of contentBlocks) {
    if (block.type !== 'tool_use') continue;
    let result;
    try {
      result = await executeTool(block.name, block.input || {}, env);
    } catch (e) {
      result = { error: String(e.message || e) };
    }
    toolResults.push({
      type: 'tool_result',
      tool_use_id: block.id,
      content: JSON.stringify(result)
    });
  }
  return toolResults;
}

// ---- Anthropic API call ----

async function callAnthropic(messages, systemPrompt, tools, env) {
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
      tools,
      messages
    })
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(`Anthropic API error: ${errData.error?.message || res.status}`);
  }
  return res.json();
}

// ---- Build system prompt ----

async function buildSystemPrompt(env, clientTime, timezone) {
  // Load life vision summary
  let life_vision_summary = 'No life vision data available.';
  try {
    const { results: visionRows } = await env.THEO_OS_DB.prepare(
      `SELECT area, vision, current_phase, success_definition FROM life_vision WHERE vision IS NOT NULL`
    ).all();
    if (visionRows && visionRows.length > 0) {
      life_vision_summary = visionRows.map(r =>
        `${r.area}: ${r.vision || ''}${r.current_phase ? ` (Phase: ${r.current_phase})` : ''}`
      ).join('\n');
    }
  } catch (_) {}

  // Load recent insights
  let recent_insights = 'No recent behavioral patterns.';
  try {
    const { results: insightRows } = await env.THEO_OS_DB.prepare(
      `SELECT insight, area FROM insights_log WHERE dismissed = 0 ORDER BY surfaced_at DESC LIMIT 5`
    ).all();
    if (insightRows && insightRows.length > 0) {
      recent_insights = insightRows.map(r => `- [${r.area || 'general'}] ${r.insight}`).join('\n');
    }
  } catch (_) {}

  // Load chat memory summaries (last 3)
  let chat_memory_summary = 'No prior session memory.';
  try {
    const { results: memoryRows } = await env.THEO_OS_DB.prepare(
      `SELECT summary FROM chat_memory ORDER BY created_at DESC LIMIT 3`
    ).all();
    if (memoryRows && memoryRows.length > 0) {
      chat_memory_summary = memoryRows.map(r => r.summary).join('\n---\n');
    }
  } catch (_) {}

  // Load high-confidence memories (>0.6)
  let memory_facts = '';
  let memory_patterns = '';
  let memory_preferences = '';
  try {
    const { results: memRows } = await env.THEO_OS_DB.prepare(
      `SELECT type, content FROM memories WHERE confidence > 0.6 ORDER BY confidence DESC LIMIT 20`
    ).all();
    memory_facts = memRows.filter(m => m.type === 'fact').map(m => `- ${m.content}`).join('\n');
    memory_patterns = memRows.filter(m => m.type === 'pattern').map(m => `- ${m.content}`).join('\n');
    memory_preferences = memRows.filter(m => m.type === 'preference').map(m => `- ${m.content}`).join('\n');
  } catch (_) {}

  // Load knowledge notes due for review or with low decay
  let knowledge_due = '';
  try {
    const today = new Date().toISOString().split('T')[0];
    const { results: dueNotes } = await env.THEO_OS_DB.prepare(
      `SELECT title, depth, decay_score, area FROM knowledge_notes
       WHERE next_review <= ? OR decay_score < 0.5
       ORDER BY decay_score ASC LIMIT 5`
    ).bind(today).all();
    if (dueNotes && dueNotes.length > 0) {
      knowledge_due = dueNotes.map(n =>
        `- ${n.title} (${n.depth}, decay: ${n.decay_score?.toFixed(2) ?? '?'}${n.area ? `, ${n.area}` : ''})`
      ).join('\n');
    }
  } catch (_) {}

  const probing_rule = knowledge_due
    ? `\nKnowledge probing:
The following topics are due for depth review (faded or overdue). When any of these come up naturally in conversation, ask one active recall question — not "do you know X" but something that requires applying, connecting, or explaining the concept. Do this once per session at most. Never announce you are testing.

Due topics:
${knowledge_due}`
    : '';

  // Use client-supplied time and timezone (travels with user), fall back to UTC
  const tz = timezone || 'UTC';
  const now = clientTime ? new Date(clientTime) : new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });

  return `You have full context on Theo's life. Current time: ${timeStr} on ${dateStr} (${tz}).

Answer what he asks. Query data when you need it. Take actions when requested.

When his reasoning has a gap, name the gap. When a conclusion is premature, surface the assumption underneath it before agreeing. When he asks for validation, give your honest read instead. Push back when you disagree — friction is useful, avoidance is not.

Actively look for connections across domains. A task, a goal, a journal entry, and a person might all be part of the same thing — surface that if it's there, without being asked. When something in the conversation touches multiple areas of his life, name the thread.

Never start with affirmations. Keep responses tight — length is a failure to distill, not a sign of thoroughness. Use what you already know about him. Don't re-ask things that are already in context.
${probing_rule}
What I know about Theo:
${memory_facts || 'Nothing recorded yet.'}

Patterns I have observed:
${memory_patterns || 'None yet.'}

How he likes to work:
${memory_preferences || 'None yet.'}

Life context:
${life_vision_summary}

Recent behavioral patterns (MindMapper):
${recent_insights}

Recent session memory:
${chat_memory_summary}`;
}

// ---- Save chat memory (fire and forget) ----

async function saveMemory(session_id, userMessage, assistantMessage, env) {
  try {
    const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: `Analyze this exchange and extract memory and knowledge signals. Return JSON only, no markdown.

{
  "summary": "1-2 sentences about what this exchange reveals about how Theo thinks",
  "memories": [
    {
      "type": "fact|pattern|preference",
      "content": "specific, concrete memory string under 100 chars",
      "confidence": 0.6-0.9,
      "area": "work|finances|health|relationships|growth|creative|exploration|life|null"
    }
  ],
  "knowledge": [
    {
      "title": "concept or topic name",
      "area": "medicine|research|technology|philosophy|finance|general|null",
      "depth": "aware|familiar|fluent",
      "signal": "what in the exchange suggests this depth"
    }
  ]
}

Memory rules:
- fact: something explicitly stated as true about Theo's life/situation
- pattern: a behavioral tendency observable from this exchange
- preference: how Theo likes to work or be spoken to
- Only extract 0-3 memories. Extract nothing if the exchange has no durable signal.
- confidence 0.6 = first time seen, 0.9 = very clear explicit statement

Knowledge rules:
- Only extract topics Theo himself mentioned or demonstrated understanding of
- aware: Theo mentioned the topic but showed limited depth
- familiar: Theo explained it, applied it, or discussed it with moderate fluency
- fluent: Theo connected it to other concepts, critiqued it, or explained it to others
- Extract 0-2 knowledge signals. Skip if no clear topic signal from Theo's messages.
- Do NOT extract topics only mentioned in the assistant response

Exchange:
User: ${userMessage}
Assistant: ${assistantMessage}`
        }]
      })
    });

    if (!extractRes.ok) return;
    const extractData = await extractRes.json();
    const raw = extractData.content?.[0]?.text;
    if (!raw) return;

    let parsed;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : JSON.parse(raw);
    } catch { return; }

    // Save session summary
    const summary = parsed.summary;
    if (summary) {
      await env.THEO_OS_DB.prepare(
        `INSERT INTO chat_memory (session_id, summary, created_at) VALUES (?, ?, datetime('now'))`
      ).bind(session_id || null, summary).run();
    }

    // Upsert memories: reinforce if similar exists, else create
    for (const mem of (parsed.memories || []).slice(0, 3)) {
      if (!mem.type || !mem.content) continue;
      const conf = Math.min(1.0, Math.max(0.1, parseFloat(mem.confidence) || 0.7));

      // Check for existing similar memory (same type + overlapping content)
      const { results: existing } = await env.THEO_OS_DB.prepare(
        `SELECT id, confidence, reinforcement_count FROM memories
         WHERE type = ? AND content LIKE ? LIMIT 1`
      ).bind(mem.type, `%${mem.content.slice(0, 30)}%`).all();

      if (existing.length > 0) {
        const e = existing[0];
        const newConf = Math.min(1.0, e.confidence + 0.1);
        await env.THEO_OS_DB.prepare(
          `UPDATE memories SET confidence = ?, reinforcement_count = reinforcement_count + 1,
           last_reinforced = datetime('now'), updated_at = datetime('now') WHERE id = ?`
        ).bind(newConf, e.id).run();
      } else {
        await env.THEO_OS_DB.prepare(
          `INSERT INTO memories (type, content, confidence, source, area, updated_at)
           VALUES (?, ?, ?, 'chat', ?, datetime('now'))`
        ).bind(mem.type, mem.content.trim(), conf, mem.area || null).run();
      }
    }

    // Upsert knowledge signals: soft score (3) if existing, else create at extracted depth
    const VALID_DEPTHS = ['aware', 'familiar', 'fluent'];
    for (const kn of (parsed.knowledge || []).slice(0, 2)) {
      if (!kn.title) continue;
      const depth = VALID_DEPTHS.includes(kn.depth) ? kn.depth : 'aware';
      const existing = await env.THEO_OS_DB.prepare(
        `SELECT id FROM knowledge_notes WHERE title LIKE ? LIMIT 1`
      ).bind(`%${kn.title.slice(0, 40)}%`).first();

      if (existing) {
        // Soft reinforce: update last_reviewed and apply a gentle score-3 (no interval change)
        await env.THEO_OS_DB.prepare(
          `UPDATE knowledge_notes SET last_reviewed = datetime('now'), last_score = 3,
           updated_at = datetime('now') WHERE id = ?`
        ).bind(existing.id).run();
      } else {
        await env.THEO_OS_DB.prepare(
          `INSERT INTO knowledge_notes (title, area, depth, decay_score, source, last_score, created_at, updated_at)
           VALUES (?, ?, ?, 1.0, 'chat', 3, datetime('now'), datetime('now'))`
        ).bind(kn.title.trim(), kn.area || null, depth).run();
      }
    }
  } catch (_) {}
}

// ---- Main handler ----

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { message, session_id, history, client_time, timezone } = body;

  if (!message || !String(message).trim()) return err('message is required');

  let systemPrompt;
  try {
    systemPrompt = await buildSystemPrompt(env, client_time, timezone);
  } catch (e) {
    return err(`Failed to build system prompt: ${e.message}`, 500);
  }

  // Build message list: last 10 from history + current user message
  const safeHistory = Array.isArray(history) ? history.slice(-10) : [];
  let messages = [
    ...safeHistory.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: String(message).trim() }
  ];

  let response;
  let toolCallsTotal = 0;

  try {
    for (let round = 0; round < 3; round++) {
      response = await callAnthropic(messages, systemPrompt, TOOLS, env);

      if (response.stop_reason === 'end_turn') break;

      if (response.stop_reason === 'tool_use') {
        const toolResults = await executeTools(response.content, env);
        toolCallsTotal += toolResults.length;
        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: toolResults }
        ];
        // On the last round, make one final call to get a text response
        if (round === 2) {
          response = await callAnthropic(messages, systemPrompt, TOOLS, env);
        }
      } else {
        break;
      }
    }
  } catch (e) {
    return err(`Chat error: ${e.message}`, 502);
  }

  // Extract final text content
  const finalText = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!finalText) return err('No response from assistant', 502);

  // Fire-and-forget: save memory summary
  const memoryPromise = saveMemory(
    session_id || null,
    String(message).trim(),
    finalText,
    env
  );

  if (context.waitUntil) {
    context.waitUntil(memoryPromise);
  }

  return json({ message: finalText, tool_calls_made: toolCallsTotal });
}
