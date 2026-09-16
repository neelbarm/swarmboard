/**
 * swarmboard dashboard.
 *
 * The server pushes a whole snapshot on every change. Rendering patches the DOM
 * in place against keyed maps rather than re-creating it, so a card that did not
 * change is never touched and the browser never flashes mid-stream.
 */

const EASE = (t) => 1 - Math.pow(1 - t, 4); // matches cubic-bezier(0.22, 1, 0.36, 1) closely enough
const COUNT_MS = 560;
const FEED_DOM_CAP = 60;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = {
  rootPath: document.getElementById('root-path'),
  demoBadge: document.getElementById('demo-badge'),
  live: document.getElementById('live'),
  liveLabel: document.querySelector('#live .label'),
  stats: document.getElementById('stats'),
  swarmSection: document.getElementById('swarm-section'),
  swarm: document.getElementById('swarm'),
  swarmHint: document.getElementById('swarm-hint'),
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  agentsHint: document.getElementById('agents-hint'),
  feed: document.getElementById('feed'),
  feedCount: document.getElementById('feed-count'),
  filterActive: document.getElementById('filter-active'),
  filterRecent: document.getElementById('filter-recent'),
  filterProject: document.getElementById('filter-project'),
  scrim: document.getElementById('scrim'),
  drawer: document.getElementById('drawer'),
  drawerTitle: document.getElementById('drawer-title'),
  drawerSub: document.getElementById('drawer-sub'),
  drawerDot: document.getElementById('drawer-dot'),
  drawerBody: document.getElementById('drawer-body'),
  drawerClose: document.getElementById('drawer-close'),
};

const state = {
  snapshot: null,
  activeOnly: false,
  // A machine accumulates months of transcripts; the board is for watching today.
  recentOnly: true,
  project: '',
  selected: null,
  cards: new Map(),
  feedSeen: new Set(),
  swarmSignature: '',
  swarmNodes: new Map(),
  projectOptions: '',
};

/* ------------------------------------------------------------ formatting */

function compact(n) {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 0 : 1)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function money(n) {
  if (!Number.isFinite(n)) return '$0';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function ago(iso) {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function clock(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function agentLabel(a) {
  return a.description || a.title || (a.kind === 'subagent' ? `agent ${(a.agentId || '').slice(0, 8)}` : `session ${a.sessionId.slice(0, 8)}`);
}

function modelLabel(a) {
  return (a.model || 'unknown model').replace(/^claude-/, '');
}

function tokensIn(a) {
  return a.tokens.input + a.tokens.cacheCreate + a.tokens.cacheRead;
}

/* --------------------------------------------------- animated numbers */

/** Tween an element's text from its previous numeric value to the new one. */
function setNum(node, value, format) {
  const from = typeof node._v === 'number' ? node._v : null;
  node._v = value;
  if (REDUCED || from === null || from === value) {
    node.textContent = format(value);
    return;
  }
  if (node._raf) cancelAnimationFrame(node._raf);
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / COUNT_MS);
    node.textContent = format(from + (value - from) * EASE(t));
    if (t < 1) node._raf = requestAnimationFrame(step);
    else node._raf = 0;
  };
  node._raf = requestAnimationFrame(step);
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function setAttr(node, name, value) {
  if (node.getAttribute(name) !== String(value)) node.setAttribute(name, value);
}

/* ------------------------------------------------------------ sparkline */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

/**
 * Cumulative output tokens over time, drawn as a monotone line with a soft fill.
 * The path is only animated the first time it appears; later updates just swap `d`.
 */
function sparkPaths(series, w, h) {
  if (!series || series.length < 2) return null;
  const xs = series.map((p) => p.t);
  const ys = series.map((p) => p.out);
  const minX = xs[0];
  const maxX = xs[xs.length - 1];
  const spanX = maxX - minX || 1;
  const maxY = Math.max(...ys, 1);
  const pad = 2;
  const px = (v) => pad + ((v - minX) / spanX) * (w - pad * 2);
  const py = (v) => h - pad - (v / maxY) * (h - pad * 2);

  let line = '';
  series.forEach((p, i) => {
    line += `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)} ${py(p.out).toFixed(1)}`;
  });
  const area = `${line}L${px(maxX).toFixed(1)} ${h}L${px(minX).toFixed(1)} ${h}Z`;
  return { line, area };
}

function buildSpark() {
  const node = svg('svg', { class: 'spark', viewBox: '0 0 300 34', preserveAspectRatio: 'none' });
  const grad = svg('linearGradient', { id: `g${Math.random().toString(36).slice(2, 9)}`, x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.appendChild(svg('stop', { offset: '0%', 'stop-color': '#7d8cff' }));
  grad.appendChild(svg('stop', { offset: '100%', 'stop-color': '#7d8cff', 'stop-opacity': '0' }));
  const defs = svg('defs', {});
  defs.appendChild(grad);
  node.appendChild(defs);
  const area = svg('path', { class: 'area', fill: `url(#${grad.getAttribute('id')})`, d: '' });
  const line = svg('path', { class: 'line', d: '' });
  node.appendChild(area);
  node.appendChild(line);
  node._area = area;
  node._line = line;
  return node;
}

function updateSpark(node, series) {
  const paths = sparkPaths(series, 300, 34);
  if (!paths) {
    setAttr(node._line, 'd', '');
    setAttr(node._area, 'd', '');
    return;
  }
  const changed = node._line.getAttribute('d') !== paths.line;
  setAttr(node._line, 'd', paths.line);
  setAttr(node._area, 'd', paths.area);
  if (changed && !node._drawn && !REDUCED) {
    node._drawn = true;
    const len = node._line.getTotalLength();
    node.style.setProperty('--len', len.toFixed(0));
    node._line.style.strokeDasharray = len.toFixed(0);
    node.classList.add('draw');
    node._line.addEventListener(
      'animationend',
      () => {
        node.classList.remove('draw');
        node._line.style.strokeDasharray = '';
      },
      { once: true },
    );
  }
}

/* ---------------------------------------------------------- agent cards */

function buildCard(agent) {
  const card = document.createElement('article');
  card.className = 'card';
  card.tabIndex = 0;
  card.innerHTML = `
    <div class="card-head">
      <span class="dot"></span>
      <div class="card-title">
        <span class="name"></span>
        <span class="where"></span>
      </div>
      <span class="kind"></span>
    </div>
    <div class="metrics">
      <div class="metric"><span class="k">Tools</span><span class="v" data-f="int"></span></div>
      <div class="metric"><span class="k">Msgs</span><span class="v" data-f="int"></span></div>
      <div class="metric"><span class="k">Tok in</span><span class="v" data-f="tok"></span></div>
      <div class="metric"><span class="k">Tok out</span><span class="v" data-f="tok"></span></div>
    </div>
    <div class="tools"></div>
    <div class="card-foot">
      <span class="model"></span>
      <span class="when"></span>
      <span class="cost"></span>
    </div>`;

  const metrics = card.querySelectorAll('.metric .v');
  const refs = {
    dot: card.querySelector('.dot'),
    name: card.querySelector('.name'),
    where: card.querySelector('.where'),
    kind: card.querySelector('.kind'),
    tools: metrics[0],
    msgs: metrics[1],
    tin: metrics[2],
    tout: metrics[3],
    chips: card.querySelector('.tools'),
    model: card.querySelector('.model'),
    when: card.querySelector('.when'),
    cost: card.querySelector('.cost'),
    spark: buildSpark(),
  };
  card.insertBefore(refs.spark, card.querySelector('.tools'));
  card._refs = refs;

  card.addEventListener('click', () => select(card._agentId));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(card._agentId);
    }
  });
  return card;
}

function updateCard(card, agent) {
  const r = card._refs;
  card._agentId = agent.id;
  setAttr(card, 'data-status', agent.status);
  card.classList.toggle('is-selected', state.selected === agent.id);

  setText(r.name, agentLabel(agent));
  setText(r.where, `${agent.projectName}${agent.gitBranch ? ` · ${agent.gitBranch}` : ''}`);
  setAttr(r.where, 'title', agent.projectPath);
  setText(r.kind, agent.kind === 'subagent' ? 'agent' : 'session');

  setNum(r.tools, agent.toolCalls, (v) => String(Math.round(v)));
  setNum(r.msgs, agent.messageCount, (v) => String(Math.round(v)));
  setNum(r.tin, tokensIn(agent), compact);
  setNum(r.tout, agent.tokens.output, compact);

  updateSpark(r.spark, agent.tokenSeries);

  const top = Object.entries(agent.toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const sig = top.map(([n, c]) => `${n}${c}`).join('|');
  if (r.chips._sig !== sig) {
    r.chips._sig = sig;
    r.chips.textContent = '';
    for (const [name, count] of top) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      // MCP tools carry long `mcp__server__tool` names; show the tool, keep the rest in the tooltip.
      chip.innerHTML = `${escapeHTML(shortToolName(name))} <b>${count}</b>`;
      chip.title = name;
      r.chips.appendChild(chip);
    }
  }

  setText(r.model, modelLabel(agent));
  setText(r.when, ago(agent.lastActivityAt));
  setText(r.cost, `${money(agent.costUSD)}~`);
  setAttr(r.cost, 'title', 'Estimated from list prices, not a bill');
}

function shortToolName(name) {
  const tail = name.startsWith('mcp__') ? name.split('__').pop() || name : name;
  return tail.length > 16 ? `${tail.slice(0, 15)}…` : tail;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderGrid(agents) {
  const seen = new Set();
  let index = 0;
  for (const agent of agents) {
    seen.add(agent.id);
    let card = state.cards.get(agent.id);
    if (!card) {
      card = buildCard(agent);
      card.style.setProperty('--stagger', `${Math.min(index, 12) * 42}ms`);
      state.cards.set(agent.id, card);
    }
    updateCard(card, agent);
    // Reorder only when the node is genuinely out of place; moving a node in the
    // DOM restarts CSS animations, so this stays as quiet as possible.
    const current = el.grid.children[index];
    if (current !== card) el.grid.insertBefore(card, current || null);
    index++;
  }
  for (const [id, card] of state.cards) {
    if (!seen.has(id)) {
      card.remove();
      state.cards.delete(id);
    }
  }
  el.empty.hidden = agents.length > 0;
}

/* ------------------------------------------------------------ swarm tree */

function buildTree(agents) {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const kids = new Map();
  const roots = [];
  for (const a of agents) {
    if (a.parentId && byId.has(a.parentId)) {
      if (!kids.has(a.parentId)) kids.set(a.parentId, []);
      kids.get(a.parentId).push(a);
    } else {
      roots.push(a);
    }
  }
  return roots
    .map((node) => ({
      node,
      children: (kids.get(node.id) || []).sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '')),
    }))
    .filter((g) => g.children.length > 0)
    .sort((a, b) => (b.node.lastActivityAt || '').localeCompare(a.node.lastActivityAt || ''));
}

function fitText(text, width, fontPx) {
  const max = Math.max(4, Math.floor(width / (fontPx * 0.56)));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function swarmNode(agent, x, y, w, h, isRoot) {
  // The outer group owns the position via the SVG transform attribute; the inner
  // group owns the entry animation. A CSS transform overrides the attribute, so
  // animating the positioned element directly would collapse every node to 0,0.
  const outer = svg('g', { transform: `translate(${x} ${y})` });
  const g = svg('g', { class: `node${agent.status === 'active' ? ' is-active' : ''}` });
  outer.appendChild(g);
  g.appendChild(svg('rect', { x: 0, y: 0, width: w, height: h, rx: 11 }));

  const color = agent.status === 'active' ? '#32d74b' : agent.status === 'finished' ? '#0a84ff' : '#ffd60a';
  g.appendChild(svg('circle', { class: 'halo', cx: 17, cy: h / 2, r: 4, stroke: color }));
  g.appendChild(svg('circle', { class: 'dot', cx: 17, cy: h / 2, r: 4, fill: color }));

  const title = svg('text', { x: 31, y: h / 2 - 3, class: 'title' });
  title.textContent = fitText(agentLabel(agent), w - 44, 12);
  g.appendChild(title);

  const meta = svg('text', { x: 31, y: h / 2 + 13, class: 'meta' });
  meta._w = w - 44;
  meta.textContent = fitText(metaLine(agent, isRoot), meta._w, 10.5);
  g.appendChild(meta);

  const tip = svg('title', {});
  tip.textContent = `${agentLabel(agent)}\n${agent.projectPath}\n${agent.status}`;
  g.appendChild(tip);

  g.addEventListener('click', () => select(agent.id));
  outer._meta = meta;
  outer._box = g;
  return outer;
}

function metaLine(agent, isRoot) {
  const bits = [
    `${agent.toolCalls} tools`,
    `${compact(agent.tokens.output)} out`,
    `${money(agent.costUSD)}~`,
    ago(agent.lastActivityAt),
  ];
  if (isRoot) bits.unshift(modelLabel(agent));
  return bits.join('  ·  ');
}

const SWARM_GROUP_CAP = 4;

function renderSwarm(agents) {
  const allGroups = buildTree(agents);
  const groups = allGroups.slice(0, SWARM_GROUP_CAP);
  if (groups.length === 0) {
    el.swarmSection.hidden = true;
    state.swarmSignature = '';
    return;
  }
  el.swarmSection.hidden = false;
  const totalKids = groups.reduce((n, g) => n + g.children.length, 0);
  const hidden = allGroups.length - groups.length;
  setText(
    el.swarmHint,
    `${groups.length} planner${groups.length === 1 ? '' : 's'} · ${totalKids} subagent${totalKids === 1 ? '' : 's'}` +
      (hidden > 0 ? ` · ${hidden} older fan-out${hidden === 1 ? '' : 's'} hidden` : ''),
  );

  const available = Math.max(560, el.swarm.clientWidth - 24);
  const rootW = 300;
  const gap = 62;
  const childW = Math.max(240, Math.min(620, available - rootW - gap - 24));
  const signature =
    `${childW}|` +
    groups
      .map((g) => `${g.node.id}:${g.node.status}>${g.children.map((c) => `${c.id}:${c.status}`).join(',')}`)
      .join(';');

  if (signature === state.swarmSignature) {
    // Same shape: only the numbers under each node moved.
    for (const g of groups) {
      const rootNode = state.swarmNodes.get(g.node.id);
      if (rootNode) setText(rootNode._meta, fitText(metaLine(g.node, true), rootNode._meta._w, 10.5));
      for (const child of g.children) {
        const childNode = state.swarmNodes.get(child.id);
        if (childNode) setText(childNode._meta, fitText(metaLine(child, false), childNode._meta._w, 10.5));
      }
    }
    return;
  }
  state.swarmSignature = signature;
  state.swarmNodes.clear();

  const nodeH = 44;
  const rowGap = 12;
  const groupGap = 26;
  const padTop = 12;

  let y = padTop;
  const layout = [];
  for (const g of groups) {
    const blockH = g.children.length * nodeH + (g.children.length - 1) * rowGap;
    layout.push({ group: g, y, blockH });
    y += Math.max(blockH, nodeH) + groupGap;
  }
  const height = y - groupGap + padTop;
  const width = 12 + rootW + gap + childW + 12;

  const root = svg('svg', { width: '100%', height: String(height), viewBox: `0 0 ${width} ${height}` });
  root.setAttribute('preserveAspectRatio', 'xMinYMin meet');

  let delay = 0;
  for (const { group, y: top, blockH } of layout) {
    const rootY = top + blockH / 2 - nodeH / 2;
    const rootX = 12;
    const childX = rootX + rootW + gap;

    group.children.forEach((child, i) => {
      const childY = top + i * (nodeH + rowGap);
      const x1 = rootX + rootW;
      const y1 = rootY + nodeH / 2;
      const x2 = childX;
      const y2 = childY + nodeH / 2;
      const mid = x1 + (x2 - x1) / 2;
      const edge = svg('path', {
        class: `edge${child.status === 'active' ? ' is-live' : ''}`,
        d: `M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`,
      });
      root.appendChild(edge);
    });

    const rootNode = swarmNode(group.node, rootX, rootY, rootW, nodeH, true);
    rootNode._box.style.animationDelay = `${delay}ms`;
    delay += 45;
    state.swarmNodes.set(group.node.id, rootNode);
    root.appendChild(rootNode);

    group.children.forEach((child, i) => {
      const node = swarmNode(child, childX, top + i * (nodeH + rowGap), childW, nodeH, false);
      node._box.style.animationDelay = `${delay}ms`;
      delay += 45;
      state.swarmNodes.set(child.id, node);
      root.appendChild(node);
    });
  }

  el.swarm.textContent = '';
  el.swarm.appendChild(root);
  syncSwarmSelection();
}

function syncSwarmSelection() {
  for (const [id, node] of state.swarmNodes) {
    node._box.classList.toggle('is-selected', id === state.selected);
  }
}

/* -------------------------------------------------------------- stats */

const STAT_DEFS = [
  { key: 'agents', label: 'Agents', get: (t) => t.agents, fmt: (v) => String(Math.round(v)), sub: (t) => `${t.sessions} sessions · ${t.subagents} subagents` },
  { key: 'active', label: 'Active now', get: (t) => t.active, fmt: (v) => String(Math.round(v)), sub: () => 'written in the last 90s' },
  { key: 'tools', label: 'Tool calls', get: (t) => t.toolCalls, fmt: (v) => Math.round(v).toLocaleString(), sub: () => 'across every transcript' },
  { key: 'tin', label: 'Tokens in', get: (t) => t.tokens.input + t.tokens.cacheCreate + t.tokens.cacheRead, fmt: compact, sub: (t) => `${compact(t.tokens.cacheRead)} from cache` },
  { key: 'tout', label: 'Tokens out', get: (t) => t.tokens.output, fmt: compact, sub: () => 'billable output' },
  { key: 'cost', label: 'Est. cost', get: (t) => t.costUSD, fmt: money, sub: () => 'list prices, not a bill' },
];

function renderStats(totals) {
  if (el.stats.children.length === 0) {
    for (const def of STAT_DEFS) {
      const box = document.createElement('div');
      box.className = 'stat';
      box.innerHTML = `<span class="k"></span><span class="v"></span><span class="sub"></span>`;
      box.querySelector('.k').textContent = def.label;
      box._v = box.querySelector('.v');
      box._sub = box.querySelector('.sub');
      el.stats.appendChild(box);
    }
  }
  STAT_DEFS.forEach((def, i) => {
    const box = el.stats.children[i];
    setNum(box._v, def.get(totals), def.fmt);
    setText(box._sub, def.sub(totals));
  });
}

/* ------------------------------------------------------------- feed */

function renderFeed(items) {
  const visible = items.slice(0, FEED_DOM_CAP);
  setText(el.feedCount, String(items.length));

  const known = new Set(visible.map((i) => i.id));
  for (const child of [...el.feed.children]) {
    if (!known.has(child.dataset.id)) child.remove();
  }
  // Newest first: walk backwards so each new item is prepended in order.
  for (let i = visible.length - 1; i >= 0; i--) {
    const item = visible[i];
    if (state.feedSeen.has(item.id)) continue;
    state.feedSeen.add(item.id);
    const li = document.createElement('li');
    li.dataset.id = item.id;
    li.dataset.kind = item.kind;
    li.innerHTML = `<span class="tool"></span><span class="detail"></span><span class="who"></span>`;
    li.querySelector('.tool').textContent = item.name;
    li.querySelector('.detail').textContent = item.detail || '—';
    li.querySelector('.who').textContent = `${item.agentLabel} · ${clock(item.ts)}`;
    li.addEventListener('click', () => select(item.agentId));
    el.feed.insertBefore(li, el.feed.firstChild);
  }
  while (el.feed.children.length > FEED_DOM_CAP) el.feed.lastChild.remove();
  if (state.feedSeen.size > 800) state.feedSeen = new Set(visible.map((i) => i.id));
}

/* ------------------------------------------------------------ drawer */

function select(id) {
  state.selected = state.selected === id ? null : id;
  for (const [cardId, card] of state.cards) card.classList.toggle('is-selected', cardId === state.selected);
  syncSwarmSelection();
  if (state.selected) openDrawer();
  else closeDrawer();
}

function openDrawer() {
  el.drawer.classList.add('open');
  el.scrim.classList.add('open');
  el.drawer.setAttribute('aria-hidden', 'false');
  renderDrawer();
}

function closeDrawer() {
  state.selected = null;
  el.drawer.classList.remove('open');
  el.scrim.classList.remove('open');
  el.drawer.setAttribute('aria-hidden', 'true');
  for (const card of state.cards.values()) card.classList.remove('is-selected');
  syncSwarmSelection();
}

function renderDrawer() {
  if (!state.selected || !state.snapshot) return;
  const agent = state.snapshot.agents.find((a) => a.id === state.selected);
  if (!agent) {
    closeDrawer();
    return;
  }

  setText(el.drawerTitle, agentLabel(agent));
  setText(el.drawerSub, `${agent.projectPath}${agent.agentId ? ` · agent ${agent.agentId}` : ''}`);
  setAttr(el.drawerDot.parentElement, 'data-status', agent.status);

  const timeline = [...agent.timeline].reverse();
  const html = [];

  html.push('<h3>Summary</h3>');
  html.push('<dl class="kv">');
  html.push(row('Status', agent.status));
  html.push(row('Model', modelLabel(agent)));
  if (agent.agentType) html.push(row('Agent type', agent.agentType));
  html.push(row('Started', agent.startedAt ? `${new Date(agent.startedAt).toLocaleString()}` : '—'));
  html.push(row('Last activity', ago(agent.lastActivityAt)));
  const toolResults = Math.max(0, agent.messageCount - agent.userMessages - agent.assistantMessages);
  html.push(
    row(
      'Messages',
      `${agent.messageCount} · ${agent.assistantMessages} assistant, ${agent.userMessages} prompt, ${toolResults} tool results`,
    ),
  );
  html.push(row('Tool calls', String(agent.toolCalls)));
  if (agent.errorCount) html.push(row('Tool errors', String(agent.errorCount)));
  html.push(row('Tokens', `${compact(tokensIn(agent))} in · ${compact(agent.tokens.output)} out · ${compact(agent.tokens.cacheRead)} cached`));
  html.push(row('Est. cost', `${money(agent.costUSD)} (estimate)`));
  html.push('</dl>');

  if (agent.lastText) {
    html.push('<h3>Latest assistant message</h3>');
    html.push(`<p class="quote">${escapeHTML(agent.lastText)}</p>`);
  }

  html.push(`<h3>Tool timeline · ${timeline.length} most recent</h3>`);
  if (timeline.length === 0) {
    html.push('<p class="quote">No tool calls recorded yet.</p>');
  } else {
    html.push('<ul class="timeline">');
    timeline.forEach((ev, i) => {
      html.push(
        `<li style="--stagger:${Math.min(i, 18) * 22}ms"><span class="row"><span class="name">${escapeHTML(ev.name)}</span><span class="time">${escapeHTML(clock(ev.ts))}</span></span>` +
          `<span class="detail">${escapeHTML(ev.detail || '—')}</span></li>`,
      );
    });
    html.push('</ul>');
  }

  html.push(`<h3>Files touched · ${agent.files.length}</h3>`);
  if (agent.files.length === 0) {
    html.push('<p class="quote">No file paths seen in this transcript.</p>');
  } else {
    html.push('<ul class="filelist">');
    for (const f of agent.files) {
      html.push(`<li><span>${escapeHTML(f.path)}</span><span class="n">${f.count}</span></li>`);
    }
    html.push('</ul>');
  }

  el.drawerBody.innerHTML = html.join('');
}

function row(k, v) {
  return `<dt>${escapeHTML(k)}</dt><dd>${escapeHTML(v)}</dd>`;
}

/* ------------------------------------------------------------- render */

const RECENT_MS = 24 * 60 * 60 * 1000;

function applyFilters(agents) {
  const cutoff = Date.now() - RECENT_MS;
  return agents.filter((a) => {
    if (state.activeOnly && a.status !== 'active') return false;
    if (state.recentOnly) {
      const last = a.lastActivityAt ? Date.parse(a.lastActivityAt) : a.fileMtimeMs;
      if (!Number.isFinite(last) || last < cutoff) return false;
    }
    if (state.project && a.projectPath !== state.project) return false;
    return true;
  });
}

function render() {
  const snap = state.snapshot;
  if (!snap) return;

  setText(el.rootPath, snap.root);
  setAttr(el.rootPath, 'title', snap.root);
  el.demoBadge.hidden = !snap.label;

  const projects = [...new Set(snap.agents.map((a) => a.projectPath))].sort();
  const optSig = projects.join('|');
  if (optSig !== state.projectOptions) {
    state.projectOptions = optSig;
    const current = el.filterProject.value;
    el.filterProject.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All projects';
    el.filterProject.appendChild(all);
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p.split('/').pop() || p;
      opt.title = p;
      el.filterProject.appendChild(opt);
    }
    el.filterProject.value = projects.includes(current) ? current : '';
    state.project = el.filterProject.value;
  }

  const agents = applyFilters(snap.agents);
  const filtered = agents.length !== snap.agents.length;
  setText(
    el.agentsHint,
    filtered ? `${agents.length} of ${snap.agents.length} shown` : `${agents.length} total`,
  );

  renderStats(snap.totals);
  renderSwarm(agents);
  renderGrid(agents);
  renderFeed(
    snap.activity.filter((item) => agents.some((a) => a.id === item.agentId)),
  );
  if (state.selected) renderDrawer();
}

/* --------------------------------------------------------------- live */

function setLive(stateName, label) {
  setAttr(el.live, 'data-state', stateName);
  setText(el.liveLabel, label);
}

let source = null;
let retry = 1000;

function connect() {
  source = new EventSource('/api/stream');
  source.addEventListener('open', () => {
    retry = 1000;
    setLive('up', 'live');
  });
  source.addEventListener('snapshot', (event) => {
    try {
      state.snapshot = JSON.parse(event.data);
    } catch {
      return;
    }
    setLive('up', 'live');
    render();
  });
  source.addEventListener('error', () => {
    setLive('down', 'reconnecting');
    source.close();
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 15000);
  });
}

el.filterRecent.addEventListener('click', () => {
  state.recentOnly = !state.recentOnly;
  el.filterRecent.setAttribute('aria-pressed', String(state.recentOnly));
  state.swarmSignature = '';
  render();
});

el.filterActive.addEventListener('click', () => {
  state.activeOnly = !state.activeOnly;
  el.filterActive.setAttribute('aria-pressed', String(state.activeOnly));
  state.swarmSignature = '';
  render();
});

el.filterProject.addEventListener('change', () => {
  state.project = el.filterProject.value;
  state.swarmSignature = '';
  render();
});

el.drawerClose.addEventListener('click', closeDrawer);
el.scrim.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

// Relative timestamps ("4s ago") go stale on their own between pushes.
setInterval(() => {
  if (!state.snapshot) return;
  for (const [id, card] of state.cards) {
    const agent = state.snapshot.agents.find((a) => a.id === id);
    if (agent) setText(card._refs.when, ago(agent.lastActivityAt));
  }
}, 1000);

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    state.swarmSignature = '';
    render();
  }, 180);
});

connect();
