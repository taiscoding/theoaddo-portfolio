import { json, err, requireAdmin } from '../_utils.js';

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

const STEP_PERSONAS = {
  2: {
    focus: 'slippage and patterns',
    guidance: 'Ask what slipped this week and why. Push for honest pattern recognition, not just listing tasks. The question should probe the underlying behavior or belief that caused things to slip, not just the surface event.'
  },
  3: {
    focus: 'avoidance and blind spots',
    guidance: 'Based on the prior answers and any system insights, ask what Theo has been avoiding. Name the specific thing the system or the answers suggest he is sidestepping. Be direct.'
  },
  4: {
    focus: 'priorities for next week',
    guidance: 'Ask Theo to identify the 3 most important things for next week. Anchor this in what he said earlier in the review. Not just what is urgent, but what actually matters.'
  },
  5: {
    focus: 'final capture',
    guidance: 'Ask if there is anything else to capture before closing the review — loose thoughts, decisions made, things to track. This is a catch-all to clear mental RAM.'
  }
};

async function saveReview(history, summary, env) {
  // Save full review as journal entry with weekly-review tag
  const reviewContent = history.map(h =>
    `STEP ${h.step}: ${h.question}\n\nAnswer: ${h.answer}`
  ).join('\n\n---\n\n');

  const fullContent = `Weekly Review\n\n${reviewContent}\n\n---\n\nSummary: ${summary}`;

  try {
    await env.THEO_OS_DB.prepare(`
      INSERT INTO journal (content, tags, created_at, updated_at)
      VALUES (?, 'weekly-review', datetime('now'), datetime('now'))
    `).bind(fullContent).run();
  } catch (_) {}

  // Save key insights as insights_log entries of type "pattern"
  // Extract patterns from the review summary via a brief Anthropic call is optional;
  // instead we save the summary itself as a pattern insight
  try {
    await env.THEO_OS_DB.prepare(`
      INSERT INTO insights_log (area, insight, type, surfaced_at, dismissed)
      VALUES ('general', ?, 'pattern', datetime('now'), 0)
    `).bind(`Weekly review: ${summary.slice(0, 500)}`).run();
  } catch (_) {}
}

export async function onRequestPost({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON'); }

  const { step, answer, history } = body;

  if (!step || typeof step !== 'number') return err('step is required');
  if (!answer || !String(answer).trim()) return err('answer is required');
  if (!Array.isArray(history)) return err('history is required');

  const nextStep = step + 1;

  // Build conversation context for Anthropic
  const historyContext = history.map(h =>
    `Step ${h.step} — ${h.question}\nAnswer: ${h.answer}`
  ).join('\n\n');

  const currentAnswer = `Step ${step} answer: ${answer}`;

  // Step 5 is final — generate summary and save
  if (step === 5) {
    const summarySystemPrompt = `You are Theo's weekly review facilitator. You are generating a closing summary for a completed weekly review.
Be honest and specific. Reference what was actually said. 2-4 sentences. No fluff.
Return ONLY a JSON object with field "summary".`;

    const summaryPrompt = `Here is the completed weekly review:

${historyContext}

${currentAnswer}

Generate a closing summary that captures the key theme of this week, the main pattern or insight, and the most important thing going into next week. Be honest and direct.`;

    let summary = 'Weekly review complete.';

    try {
      const aiRes = await callAnthropic(
        [{ role: 'user', content: summaryPrompt }],
        summarySystemPrompt,
        env
      );

      const rawText = (aiRes.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.summary) summary = parsed.summary;
      }
    } catch (_) {
      // Use default summary
    }

    // Save review and insights (fire and forget style — but we await in case of fast response)
    try {
      const fullHistory = [...history, { step, question: history[history.length - 1]?.question || '', answer }];
      await saveReview(fullHistory, summary, env);
    } catch (_) {}

    return json({ step: 6, done: true, summary });
  }

  // Steps 2-4: generate the next question
  if (nextStep > 5) return err('Invalid step progression');

  const persona = STEP_PERSONAS[nextStep];
  if (!persona) return err(`No persona defined for step ${nextStep}`);

  const systemPrompt = `You are Theo's weekly review facilitator. You ask focused, honest, probing questions.
Your current focus: ${persona.focus}.
${persona.guidance}

Be specific to what Theo has already said. Reference his actual words. Do not be generic.
Return ONLY a JSON object with two fields: "question" (the next step question) and "context" (optional, 1-2 sentence framing based on what was said, or empty string).`;

  const userPrompt = `Here is the weekly review so far:

${historyContext}

${currentAnswer}

Now generate Step ${nextStep} question. Focus: ${persona.focus}.`;

  let question = `Step ${nextStep}: ${persona.focus}`;
  let context = '';

  try {
    const aiRes = await callAnthropic(
      [{ role: 'user', content: userPrompt }],
      systemPrompt,
      env
    );

    const rawText = (aiRes.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.question) question = parsed.question;
      if (parsed.context !== undefined) context = parsed.context;
    }
  } catch (e) {
    return err(`Failed to generate next question: ${e.message}`, 502);
  }

  return json({ step: nextStep, question, context });
}
