import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  TranscriptState,
  parseLine,
  decodeProjectDir,
  projectNameFrom,
} from './parser.js';
import { emptyTokens, addTokens } from './pricing.js';
import type {
  AgentMeta,
  AgentNode,
  AgentStatus,
  ActivityItem,
  Snapshot,
  TokenPoint,
} from './types.js';

/** A session whose file was written within this window counts as active. */
export const ACTIVE_WINDOW_MS = 90_000;
/** Activity feed length held in memory and shipped to the browser. */
export const ACTIVITY_CAP = 200;
/** Points sent per sparkline; buckets beyond this are decimated. */
const SERIES_TRANSPORT_CAP = 60;

interface TrackedFile {
  /** Stable agent id. */
  id: string;
  file: string;
  kind: 'session' | 'subagent';
  sessionId: string;
  agentId: string | null;
  projectDir: string;
  state: TranscriptState;
  meta: AgentMeta | null;
  offset: number;
  /** Bytes left over from the last read that did not end in a newline. */
  pending: string;
  mtimeMs: number;
  size: number;
  /** How many timeline entries have already been published to the activity feed. */
  publishedSeq: number;
}

export interface StoreOptions {
  root: string;
  /** Polling interval for the fs.watch fallback. */
  pollMs?: number;
}

/**
 * Watches a `~/.claude/projects`-shaped directory and keeps an in-memory model of
 * every session and subagent found under it.
 *
 * Files are only ever read forward from a byte offset, so a 400KB transcript that
 * grows by one line costs one short read.
 */
export class SwarmStore extends EventEmitter {
  readonly root: string;
  private readonly pollMs: number;
  private tracked = new Map<string, TrackedFile>();
  private activity: ActivityItem[] = [];
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshing = false;
  private queued = false;
  private closed = false;

  constructor(opts: StoreOptions) {
    super();
    this.root = path.resolve(opts.root);
    this.pollMs = opts.pollMs ?? 2000;
  }

  async start(): Promise<void> {
    await this.refresh();
    this.attachWatcher();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollMs);
    this.pollTimer.unref?.();
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private attachWatcher(): void {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, () => {
        this.scheduleRefresh();
      });
      this.watcher.on('error', () => {
        // Recursive watch is unsupported on some platforms/filesystems; the poll
        // interval below is the fallback and keeps working on its own.
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  /** Debounce bursty fs.watch events into one refresh. */
  private scheduleRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, 150);
    this.refreshTimer.unref?.();
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.refreshing) {
      this.queued = true;
      return;
    }
    this.refreshing = true;
    try {
      let changed = await this.discover();
      for (const t of this.tracked.values()) {
        if (await this.tail(t)) changed = true;
      }
      if (changed) this.emit('change', this.snapshot());
    } catch (err) {
      this.emit('warn', err);
    } finally {
      this.refreshing = false;
      if (this.queued) {
        this.queued = false;
        void this.refresh();
      }
    }
  }

  /** Find transcripts that appeared since the last pass. */
  private async discover(): Promise<boolean> {
    let changed = false;
    let projectDirs: string[];
    try {
      const entries = await fsp.readdir(this.root, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return false;
    }

    for (const dirName of projectDirs) {
      const dir = path.join(this.root, dirName);
      let files: fs.Dirent[];
      try {
        files = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of files) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const sessionId = entry.name.slice(0, -'.jsonl'.length);
          if (this.track(sessionId, path.join(dir, entry.name), 'session', dirName, sessionId, null, null)) {
            changed = true;
          }
        } else if (entry.isDirectory()) {
          // Subagent transcripts live in `<sessionId>/subagents/agent-<agentId>.jsonl`
          // with an `agent-<agentId>.meta.json` sidecar naming the spawning tool_use.
          const subDir = path.join(dir, entry.name, 'subagents');
          let subs: string[];
          try {
            subs = await fsp.readdir(subDir);
          } catch {
            continue;
          }
          for (const name of subs) {
            if (!name.endsWith('.jsonl')) continue;
            const agentId = name.replace(/^agent-/, '').slice(0, -'.jsonl'.length);
            const id = `${entry.name}/${agentId}`;
            if (this.tracked.has(id)) continue;
            const meta = await readMeta(path.join(subDir, `${name.slice(0, -'.jsonl'.length)}.meta.json`));
            if (this.track(id, path.join(subDir, name), 'subagent', dirName, entry.name, agentId, meta)) {
              changed = true;
            }
          }
        }
      }
    }
    return changed;
  }

  private track(
    id: string,
    file: string,
    kind: 'session' | 'subagent',
    projectDir: string,
    sessionId: string,
    agentId: string | null,
    meta: AgentMeta | null,
  ): boolean {
    if (this.tracked.has(id)) return false;
    this.tracked.set(id, {
      id,
      file,
      kind,
      sessionId,
      agentId,
      projectDir,
      state: new TranscriptState(),
      meta,
      offset: 0,
      pending: '',
      mtimeMs: 0,
      size: 0,
      publishedSeq: -1,
    });
    return true;
  }

  /** Read whatever has been appended since the last read. */
  private async tail(t: TrackedFile): Promise<boolean> {
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(t.file);
    } catch {
      return false;
    }
    const mtimeChanged = stat.mtimeMs !== t.mtimeMs;
    t.mtimeMs = stat.mtimeMs;

    if (stat.size < t.offset) {
      // Truncated or rewritten: start over rather than emit garbage.
      t.offset = 0;
      t.pending = '';
      t.state = new TranscriptState();
      t.publishedSeq = -1;
    }
    if (stat.size === t.offset) return mtimeChanged;

    let handle: fsp.FileHandle | null = null;
    let text: string;
    try {
      handle = await fsp.open(t.file, 'r');
      const length = stat.size - t.offset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, t.offset);
      text = buf.subarray(0, bytesRead).toString('utf8');
      t.offset += bytesRead;
    } catch {
      return mtimeChanged;
    } finally {
      await handle?.close();
    }

    t.size = stat.size;
    const combined = t.pending + text;
    const lines = combined.split('\n');
    // A trailing fragment means the writer is mid-line; hold it for the next read.
    t.pending = lines.pop() ?? '';

    for (const raw of lines) {
      const line = parseLine(raw);
      if (line) t.state.applyLine(line);
    }
    this.publishActivity(t);
    return true;
  }

  private publishActivity(t: TrackedFile): void {
    const label = this.labelFor(t);
    const projectName = projectNameFrom(this.projectPathFor(t));
    let added = false;
    for (const ev of t.state.timeline) {
      if (ev.seq <= t.publishedSeq) continue;
      t.publishedSeq = ev.seq;
      this.activity.push({
        id: `${t.id}#${ev.seq}`,
        agentId: t.id,
        agentLabel: label,
        projectName,
        ts: ev.ts,
        kind: ev.name === 'Agent' || ev.name === 'Task' ? 'spawn' : 'tool',
        name: ev.name,
        detail: ev.detail,
      });
      added = true;
    }
    if (added && this.activity.length > ACTIVITY_CAP) {
      this.activity.splice(0, this.activity.length - ACTIVITY_CAP);
    }
  }

  private projectPathFor(t: TrackedFile): string {
    return t.state.cwd ?? decodeProjectDir(t.projectDir);
  }

  private labelFor(t: TrackedFile): string {
    if (t.kind === 'subagent') {
      return t.meta?.description || t.meta?.agentType || `agent ${t.agentId?.slice(0, 8) ?? ''}`;
    }
    return t.state.title || `session ${t.sessionId.slice(0, 8)}`;
  }

  private statusFor(t: TrackedFile, now: number): AgentStatus {
    if (now - t.mtimeMs < ACTIVE_WINDOW_MS) return 'active';
    if (t.kind === 'subagent' && t.meta?.toolUseId) {
      const parent = this.tracked.get(t.sessionId);
      if (parent?.state.completedToolUses.has(t.meta.toolUseId)) return 'finished';
      return 'idle';
    }
    return 'idle';
  }

  snapshot(): Snapshot {
    const now = Date.now();
    const agents: AgentNode[] = [];
    const totals = {
      agents: 0,
      active: 0,
      sessions: 0,
      subagents: 0,
      toolCalls: 0,
      tokens: emptyTokens(),
      costUSD: 0,
    };

    for (const t of this.tracked.values()) {
      const s = t.state;
      if (s.messageCount === 0 && s.toolCalls === 0 && !s.lastActivityAt) continue;
      const projectPath = this.projectPathFor(t);
      const status = this.statusFor(t, now);
      const node: AgentNode = {
        id: t.id,
        parentId: t.kind === 'subagent' ? t.sessionId : null,
        kind: t.kind,
        sessionId: t.sessionId,
        agentId: t.agentId,
        projectDir: t.projectDir,
        projectPath,
        projectName: projectNameFrom(projectPath),
        title: s.title,
        agentType: t.meta?.agentType ?? null,
        description: t.meta?.description ?? null,
        model: s.model ?? (t.meta?.model ? `claude-${t.meta.model}` : null),
        gitBranch: s.gitBranch,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        fileMtimeMs: t.mtimeMs,
        status,
        messageCount: s.messageCount,
        userMessages: s.userMessages,
        assistantMessages: s.assistantMessages,
        toolCalls: s.toolCalls,
        errorCount: s.errorCount,
        tokens: { ...s.tokens },
        costUSD: s.costUSD,
        costIsEstimate: true,
        toolCounts: { ...s.toolCounts },
        files: s.files().slice(0, 40),
        timeline: s.timeline.slice(-60),
        tokenSeries: decimate(s.series(), SERIES_TRANSPORT_CAP),
        lastText: s.lastText,
      };
      agents.push(node);

      totals.agents++;
      if (status === 'active') totals.active++;
      if (t.kind === 'session') totals.sessions++;
      else totals.subagents++;
      totals.toolCalls += s.toolCalls;
      addTokens(totals.tokens, s.tokens);
      totals.costUSD += s.costUSD;
    }

    agents.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
    const activity = [...this.activity].reverse();

    return {
      generatedAt: new Date().toISOString(),
      root: this.root,
      agents,
      activity,
      totals,
    };
  }
}

async function readMeta(file: string): Promise<AgentMeta | null> {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as AgentMeta;
  } catch {
    /* sidecar is optional */
  }
  return null;
}

/** Keep the first and last points, sample evenly in between. */
export function decimate(points: TokenPoint[], cap: number): TokenPoint[] {
  if (points.length <= cap) return points;
  const out: TokenPoint[] = [];
  const step = (points.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) {
    const p = points[Math.round(i * step)];
    if (p) out.push(p);
  }
  return out;
}

/**
 * Build the parent -> children tree from a flat agent list. Subagents whose parent
 * session was filtered out (or never written) are promoted to roots so nothing is
 * silently dropped from the view.
 */
export function buildTree(agents: AgentNode[]): Array<{ node: AgentNode; children: AgentNode[] }> {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const children = new Map<string, AgentNode[]>();
  const roots: AgentNode[] = [];

  for (const a of agents) {
    if (a.parentId && byId.has(a.parentId)) {
      const list = children.get(a.parentId);
      if (list) list.push(a);
      else children.set(a.parentId, [a]);
    } else {
      roots.push(a);
    }
  }
  return roots.map((node) => ({
    node,
    children: (children.get(node.id) ?? []).sort((a, b) =>
      (a.startedAt ?? '').localeCompare(b.startedAt ?? ''),
    ),
  }));
}
