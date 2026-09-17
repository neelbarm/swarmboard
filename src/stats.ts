import { SwarmStore, buildTree } from './store.js';
import { formatUSD } from './pricing.js';
import type { AgentNode } from './types.js';

/** Parse `24h`, `90m`, `7d`, `45s` or a plain number of hours. */
export function parseSince(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([smhdw]?)$/i.exec(input.trim());
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (m[2] || 'h').toLowerCase();
  const mult: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const factor = mult[unit];
  return factor === undefined ? null : value * factor;
}

export interface StatsOptions {
  root: string;
  sinceMs: number | null;
  project: string | null;
  activeOnly: boolean;
  limit: number;
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function topTools(agent: AgentNode, max = 3): string {
  const entries = Object.entries(agent.toolCounts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '—';
  return entries
    .slice(0, max)
    .map(([name, count]) => `${truncate(name, 22)}:${count}`)
    .join(' ');
}

function ago(iso: string | null): string {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const DIM = '[2m';
const BOLD = '[1m';
const RESET = '[0m';
const GREEN = '[32m';
const YELLOW = '[33m';
const BLUE = '[34m';

function color(text: string, code: string, enabled: boolean): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

function visibleWidth(s: string): number {
  return s.replace(/\[[0-9;]*m/g, '').length;
}

function pad(s: string, width: number, align: 'l' | 'r'): string {
  const gap = Math.max(0, width - visibleWidth(s));
  return align === 'r' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

export function renderTable(
  rows: string[][],
  headers: string[],
  align: Array<'l' | 'r'>,
  useColor: boolean,
): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ''))),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => pad(c, widths[i] ?? 0, align[i] ?? 'l'))
      .join('  ')
      .trimEnd();
  const out = [color(line(headers), BOLD, useColor)];
  out.push(color(widths.map((w) => '─'.repeat(w)).join('  '), DIM, useColor));
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

export async function runStats(opts: StatsOptions, write: (s: string) => void): Promise<void> {
  const useColor = process.stdout.isTTY === true && !process.env['NO_COLOR'];
  const store = new SwarmStore({ root: opts.root });
  await store.refresh();
  const snap = store.snapshot();
  store.close();

  const cutoff = opts.sinceMs === null ? null : Date.now() - opts.sinceMs;
  let agents = snap.agents.filter((a) => {
    if (cutoff !== null) {
      const last = a.lastActivityAt ? Date.parse(a.lastActivityAt) : a.fileMtimeMs;
      if (!Number.isFinite(last) || last < cutoff) return false;
    }
    if (opts.activeOnly && a.status !== 'active') return false;
    if (opts.project) {
      const needle = opts.project.toLowerCase();
      const hay = `${a.projectName} ${a.projectPath}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  if (agents.length === 0) {
    write(`No sessions matched under ${snap.root}\n`);
    return;
  }

  // Keep children next to their parent so the swarm shape survives the flattening.
  const tree = buildTree(agents);
  const ordered: Array<{ agent: AgentNode; depth: number }> = [];
  for (const { node, children } of tree) {
    ordered.push({ agent: node, depth: 0 });
    for (const child of children) ordered.push({ agent: child, depth: 1 });
  }
  agents = ordered.map((o) => o.agent);
  const trimmed = ordered.slice(0, opts.limit);

  const rows = trimmed.map(({ agent, depth }) => {
    const dot =
      agent.status === 'active'
        ? color('●', GREEN, useColor)
        : agent.status === 'finished'
          ? color('●', BLUE, useColor)
          : color('○', YELLOW, useColor);
    // An unlabelled subagent is identified by its own agentId; `agent.id` is
    // `<sessionId>/<agentId>`, whose first 8 characters are the parent's.
    const fallbackName =
      agent.kind === 'subagent'
        ? `agent ${(agent.agentId ?? '').slice(0, 8)}`
        : `session ${agent.sessionId.slice(0, 8)}`;
    const label = (depth ? '└─ ' : '') + (agent.description || agent.title || fallbackName);
    return [
      `${dot} ${truncate(label, 42)}`,
      agent.status,
      truncate(agent.projectName, 22),
      truncate((agent.model ?? '—').replace(/^claude-/, ''), 24),
      String(agent.toolCalls),
      topTools(agent),
      compactTokens(agent.tokens.input + agent.tokens.cacheCreate + agent.tokens.cacheRead),
      compactTokens(agent.tokens.output),
      formatUSD(agent.costUSD),
      ago(agent.lastActivityAt),
    ];
  });

  const totals = trimmed.reduce(
    (acc, { agent }) => {
      acc.tools += agent.toolCalls;
      acc.in += agent.tokens.input + agent.tokens.cacheCreate + agent.tokens.cacheRead;
      acc.out += agent.tokens.output;
      acc.cost += agent.costUSD;
      return acc;
    },
    { tools: 0, in: 0, out: 0, cost: 0 },
  );

  write(
    `${color('swarmboard', BOLD, useColor)} ${color(snap.root, DIM, useColor)}\n` +
      color(
        `${trimmed.length} shown · ${snap.totals.active} active · ${snap.totals.sessions} sessions · ${snap.totals.subagents} subagents\n\n`,
        DIM,
        useColor,
      ),
  );
  write(
    renderTable(
      rows,
      ['AGENT', 'STATUS', 'PROJECT', 'MODEL', 'TOOLS', 'TOP TOOLS', 'TOK IN', 'TOK OUT', 'COST~', 'LAST'],
      ['l', 'l', 'l', 'l', 'r', 'l', 'r', 'r', 'r', 'r'],
      useColor,
    ),
  );
  write(
    '\n\n' +
      color(
        `total  ${totals.tools} tool calls · ${compactTokens(totals.in)} in · ${compactTokens(totals.out)} out · ${formatUSD(totals.cost)} estimated (list prices, not a bill)\n`,
        DIM,
        useColor,
      ),
  );
}

function truncate(s: string, n: number): string {
  // Titles, tool names and project paths all come from transcript content, which is
  // arbitrary text. Strip C0/C1 control bytes before they reach the terminal so a
  // stray escape sequence in a transcript cannot repaint or relabel the table.
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}
