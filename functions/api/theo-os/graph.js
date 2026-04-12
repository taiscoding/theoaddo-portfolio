import { json, err, requireAdmin } from './_utils.js';

// Area → color mapping (matches admin.css palette)
const AREA_COLORS = {
  work:          '#00d1c1',
  growth:        '#00b8a9',
  health:        '#ff5b5b',
  life:          '#ff7b6b',
  relationships: '#9b5de5',
  creative:      '#c77dff',
  finances:      '#f5c842',
  exploration:   '#f8d95a',
};
const DEFAULT_COLOR = '#4a5568';

const DEPTH_WEIGHT = { aware: 0.8, familiar: 1.2, fluent: 1.6 };

export async function onRequestGet({ request, env }) {
  if (!await requireAdmin(request, env)) return err('Unauthorized', 401);

  let nodes, edges;
  try {
    const [tasksRes, goalsRes, knowledgeRes, peopleRes, journalRes, connectionsRes] = await Promise.all([
      env.THEO_OS_DB.prepare(
        `SELECT id, title, area, status FROM tasks WHERE status != 'done' ORDER BY updated_at DESC LIMIT 50`
      ).all(),
      env.THEO_OS_DB.prepare(
        `SELECT id, title, area, status FROM goals WHERE status = 'active' ORDER BY updated_at DESC LIMIT 30`
      ).all(),
      env.THEO_OS_DB.prepare(
        `SELECT id, title, area, depth, decay_score FROM knowledge_notes ORDER BY created_at DESC LIMIT 50`
      ).all(),
      env.THEO_OS_DB.prepare(
        `SELECT id, name, relationship FROM people ORDER BY name ASC LIMIT 30`
      ).all(),
      env.THEO_OS_DB.prepare(
        `SELECT id, substr(content, 1, 80) as preview, created_at FROM journal ORDER BY created_at DESC LIMIT 20`
      ).all(),
      env.THEO_OS_DB.prepare(
        `SELECT from_id, from_type, to_id, to_type, label FROM connections ORDER BY from_id, to_id LIMIT 500`
      ).all(),
    ]);

    nodes = [];
    const nodeSet = new Set();

    function addNode(data) {
      nodeSet.add(data.id);
      nodes.push({ data });
    }

    for (const t of (tasksRes.results || [])) {
      addNode({
        id: `task:${t.id}`,
        label: t.title,
        type: 'task',
        area: t.area || 'general',
        color: AREA_COLORS[t.area] || DEFAULT_COLOR,
        weight: 0.7,
        decay: 1.0,
        url: `/admin/tasks.html`,
      });
    }

    for (const g of (goalsRes.results || [])) {
      addNode({
        id: `goal:${g.id}`,
        label: g.title,
        type: 'goal',
        area: g.area || 'general',
        color: AREA_COLORS[g.area] || DEFAULT_COLOR,
        weight: 1.4,
        decay: 1.0,
        url: `/admin/goals.html`,
      });
    }

    for (const k of (knowledgeRes.results || [])) {
      addNode({
        id: `knowledge:${k.id}`,
        label: k.title,
        type: 'knowledge',
        area: k.area || 'general',
        color: AREA_COLORS[k.area] || '#a0aec0',
        weight: DEPTH_WEIGHT[k.depth] || 1.0,
        decay: k.decay_score ?? 1.0,
        url: `/admin/learn.html?id=${k.id}`,
      });
    }

    for (const p of (peopleRes.results || [])) {
      addNode({
        id: `person:${p.id}`,
        label: p.name,
        type: 'person',
        area: 'relationships',
        color: AREA_COLORS.relationships,
        weight: 1.1,
        decay: 1.0,
        url: `/admin/people.html`,
      });
    }

    for (const j of (journalRes.results || [])) {
      const preview = (j.preview || '').replace(/\n/g, ' ').slice(0, 50);
      addNode({
        id: `journal:${j.id}`,
        label: preview || 'Journal entry',
        type: 'journal',
        area: 'life',
        color: '#718096',
        weight: 0.5,
        decay: 1.0,
        url: `/admin/journal.html`,
      });
    }

    edges = [];
    for (const c of (connectionsRes.results || [])) {
      const source = `${c.from_type}:${c.from_id}`;
      const target = `${c.to_type}:${c.to_id}`;
      if (nodeSet.has(source) && nodeSet.has(target)) {
        edges.push({ data: { id: `${source}->${target}`, source, target, label: c.label || '', strength: 1 } });
      }
    }
  } catch (e) {
    return err('Failed to load graph data', 500);
  }

  return json({ nodes, edges }, 200, request);
}
