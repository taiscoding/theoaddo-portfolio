import { json, err, requireAdmin } from '../_utils.js';

// ---- Tool definitions ----

const TOOLS = [
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
      if (!id) return { error: 'id is required' };
      const sets = [];
      const binds = [];
      if (status !== undefined) { sets.push('status = ?'); binds.push(status); }
      if (area !== undefined) { sets.push('area = ?'); binds.push(area); }
      if (notes !== undefined) { sets.push('notes = ?'); binds.push(notes); }
      if (sets.length === 0) return { error: 'no fields to update' };
      sets.push(`updated_at = datetime('now')`);
      binds.push(id);
      const { results } = await env.THEO_OS_DB.prepare(
        `UPDATE tasks SET ${sets.join(', ')} WHERE id = ? RETURNING *`
      ).bind(...binds).all();
      return { task: results[0] || null };
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

async function buildSystemPrompt(env) {
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

  return `You are Theo's secretary and thinking partner. You have full access to his life OS data.

Your role has two modes:

AS SECRETARY: You answer questions, query data, and take actions. Be efficient and precise.

AS THINKING PARTNER: This is the more important role. Your job is not to answer — it is to help Theo think clearly. You ask before you tell. You surface the assumption underneath the question before answering it. You push back when the reasoning is soft. You are explicitly not sycophantic. You do not validate ideas to make Theo feel good. You do not agree to avoid friction. You do not soften challenges that should be direct.

Rules:
- If Theo presents a conclusion, ask what led him there before agreeing.
- If Theo asks for validation, give your honest assessment instead.
- If Theo's reasoning has a gap, name the gap directly.
- Never start responses with affirmations ("Great question!", "Absolutely!", etc.)
- Keep responses concise. Long responses are usually a failure to distill.

Life context:
${life_vision_summary}

Recent behavioral patterns:
${recent_insights}

What the system knows about how Theo thinks:
${chat_memory_summary}`;
}

// ---- Save chat memory (fire and forget) ----

async function saveMemory(session_id, userMessage, assistantMessage, env) {
  try {
    const summaryRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Summarize in 1-2 sentences what this exchange reveals about how Theo thinks or what is on his mind. Be specific and pattern-focused, not generic.

User: ${userMessage}
Assistant: ${assistantMessage}`
        }]
      })
    });

    if (!summaryRes.ok) return;
    const summaryData = await summaryRes.json();
    const summary = summaryData.content?.[0]?.text;
    if (!summary) return;

    await env.THEO_OS_DB.prepare(
      `INSERT INTO chat_memory (session_id, summary, knowledge_updates, pattern_observations, created_at)
       VALUES (?, ?, NULL, NULL, datetime('now'))`
    ).bind(session_id || null, summary).run();
  } catch (_) {}
}

// ---- Main handler ----

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { message, session_id, history } = body;

  if (!message || !String(message).trim()) return err('message is required');

  let systemPrompt;
  try {
    systemPrompt = await buildSystemPrompt(env);
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
      } else {
        // unexpected stop reason, break
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
