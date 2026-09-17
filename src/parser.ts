import path from 'node:path';
import type {
  RawLine,
  RawContentBlock,
  ToolEvent,
  TokenPoint,
  TokenTotals,
} from './types.js';
import { emptyTokens, estimateCost } from './pricing.js';

/** Most recent tool events kept per agent. The full history stays on disk. */
export const TIMELINE_CAP = 300;
/** Distinct file paths tracked per agent. */
export const FILES_CAP = 400;
/** Sparkline resolution: one point per bucket, then downsampled for transport. */
export const SERIES_BUCKET_MS = 30_000;
export const SERIES_CAP = 240;

/** Parse one JSONL line. Returns null for blank lines, bad JSON, or non-objects. */
export function parseLine(text: string): RawLine | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed[0] !== '{') return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as RawLine;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Turn a tool_use input into a one-line summary plus the file it touched.
 * Falls back to the first stringy field so unknown tools still render usefully.
 */
export function summarizeTool(
  name: string,
  input: Record<string, unknown> | undefined,
): { detail: string; file: string | null } {
  const inp = input ?? {};
  const str = (k: string): string | null => asString(inp[k]);

  switch (name) {
    case 'Bash': {
      return { detail: clip(str('command') ?? str('description') ?? '', 220), file: null };
    }
    case 'Read':
    case 'Write':
    case 'NotebookEdit': {
      const file = str('file_path') ?? str('notebook_path');
      return { detail: file ? clip(shortPath(file), 180) : '', file };
    }
    case 'Edit': {
      const file = str('file_path');
      const old = str('old_string');
      const detail = file
        ? clip(`${shortPath(file)}${old ? ` — ${clip(old, 60)}` : ''}`, 180)
        : clip(old ?? '', 100);
      return { detail, file };
    }
    case 'Glob':
    case 'Grep': {
      const pattern = str('pattern') ?? '';
      const where = str('path') ?? str('glob');
      return { detail: clip(where ? `${pattern}  in ${shortPath(where)}` : pattern, 180), file: null };
    }
    case 'Agent':
    case 'Task': {
      const desc = str('description') ?? str('subagent_type') ?? '';
      const kind = str('subagent_type');
      return { detail: clip(kind && desc ? `${desc} (${kind})` : desc || kind || '', 180), file: null };
    }
    case 'WebFetch':
    case 'WebSearch': {
      return { detail: clip(str('url') ?? str('query') ?? '', 180), file: null };
    }
    case 'TodoWrite': {
      const todos = inp['todos'];
      const n = Array.isArray(todos) ? todos.length : 0;
      return { detail: n ? `${n} item${n === 1 ? '' : 's'}` : '', file: null };
    }
    case 'Skill': {
      return { detail: clip(str('skill') ?? '', 120), file: null };
    }
    default: {
      const file = str('file_path') ?? str('path') ?? null;
      if (file) return { detail: clip(shortPath(file), 180), file };
      for (const key of ['command', 'query', 'description', 'prompt', 'url', 'pattern', 'text', 'skill']) {
        const v = str(key);
        if (v) return { detail: clip(v, 180), file: null };
      }
      // Unknown tool with no obvious label: describe the argument shape instead of
      // showing nothing, so MCP and future tools still read as something.
      const shape = Object.entries(inp)
        .slice(0, 4)
        .map(([k, v]) => (Array.isArray(v) ? `${k}[${v.length}]` : k))
        .join(' ');
      return { detail: clip(shape, 120), file: null };
    }
  }
}

/** Trim a long absolute path down to something readable in a card. */
export function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  return `…/${parts.slice(-3).join('/')}`;
}

/**
 * Claude Code encodes a project's cwd into a directory name by replacing every
 * `/` and every non-word character with `-`, which is lossy. We recover the real
 * path from `cwd` on the transcript lines when we have it; this is the fallback
 * used for the directory label before any line has been read.
 */
export function decodeProjectDir(dirName: string): string {
  const body = dirName.startsWith('-') ? dirName.slice(1) : dirName;
  return `/${body.split('-').filter(Boolean).join('/')}`;
}

export function projectNameFrom(projectPath: string): string {
  const base = path.basename(projectPath);
  return base || projectPath;
}

/**
 * Incremental accumulator for one transcript file.
 *
 * `applyLine` is called once per JSONL line in file order and is the only way
 * state advances, so tailing a growing file and parsing it cold produce the
 * same result.
 */
export class TranscriptState {
  sessionId: string | null = null;
  agentId: string | null = null;
  isSidechain = false;
  cwd: string | null = null;
  gitBranch: string | null = null;
  title: string | null = null;
  model: string | null = null;

  startedAt: string | null = null;
  lastActivityAt: string | null = null;

  messageCount = 0;
  userMessages = 0;
  assistantMessages = 0;
  toolCalls = 0;
  errorCount = 0;

  tokens: TokenTotals = emptyTokens();
  costUSD = 0;

  toolCounts: Record<string, number> = Object.create(null);
  timeline: ToolEvent[] = [];
  lastText: string | null = null;

  /** tool_use id -> Agent-tool description, used to label spawned children. */
  spawns = new Map<string, string>();

  /** tool_use ids that have come back with a result, used for finished-detection. */
  completedToolUses = new Set<string>();

  private fileCounts = new Map<string, number>();
  private seriesBuckets = new Map<number, TokenPoint>();
  private cumOut = 0;
  private cumIn = 0;
  private seq = 0;

  applyLine(line: RawLine): void {
    const ts = asString(line.timestamp);
    if (ts) {
      if (!this.startedAt) this.startedAt = ts;
      this.lastActivityAt = ts;
    }
    if (!this.sessionId) this.sessionId = asString(line.sessionId);
    if (!this.agentId) this.agentId = asString(line.agentId);
    if (line.isSidechain === true) this.isSidechain = true;
    const cwd = asString(line.cwd);
    if (cwd) this.cwd = cwd;
    const branch = asString(line.gitBranch);
    if (branch) this.gitBranch = branch;

    switch (line.type) {
      case 'custom-title': {
        const t = asString(line.customTitle);
        if (t) this.title = t;
        return;
      }
      case 'ai-title': {
        const t = asString(line.aiTitle);
        if (t && !this.title) this.title = t;
        return;
      }
      case 'last-prompt': {
        const t = asString(line.lastPrompt);
        if (t && !this.title) this.title = clip(t, 90);
        return;
      }
      case 'assistant':
        this.applyAssistant(line, ts);
        return;
      case 'user':
        this.applyUser(line);
        return;
      default:
        // attachment, system, mode, queue-operation, file-history-*, and anything
        // a future Claude Code release invents: timestamps already recorded, ignore.
        return;
    }
  }

  private applyAssistant(line: RawLine, ts: string | null): void {
    const msg = line.message;
    if (!msg || typeof msg !== 'object') return;
    this.messageCount++;
    this.assistantMessages++;

    const model = asString(msg.model);
    if (model && model !== '<synthetic>') this.model = model;

    const usage = msg.usage;
    if (usage && typeof usage === 'object') {
      const delta: TokenTotals = {
        input: asNumber(usage.input_tokens),
        output: asNumber(usage.output_tokens),
        cacheCreate: asNumber(usage.cache_creation_input_tokens),
        cacheRead: asNumber(usage.cache_read_input_tokens),
      };
      this.tokens.input += delta.input;
      this.tokens.output += delta.output;
      this.tokens.cacheCreate += delta.cacheCreate;
      this.tokens.cacheRead += delta.cacheRead;
      this.costUSD += estimateCost(this.model, delta);

      this.cumOut += delta.output;
      this.cumIn += delta.input + delta.cacheCreate + delta.cacheRead;
      this.pushSeries(ts);
    }

    const content = msg.content;
    if (!Array.isArray(content)) return;
    for (const block of content as RawContentBlock[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        const text = asString(block.text);
        if (text) this.lastText = clip(text, 600);
      } else if (block.type === 'tool_use') {
        const name = asString(block.name) ?? 'tool';
        this.toolCalls++;
        this.toolCounts[name] = (this.toolCounts[name] ?? 0) + 1;
        const { detail, file } = summarizeTool(name, block.input);
        if (file) this.touchFile(file);
        if ((name === 'Agent' || name === 'Task') && asString(block.id)) {
          this.spawns.set(block.id as string, detail);
        }
        this.timeline.push({
          seq: this.seq++,
          ts,
          name,
          detail,
          file,
          id: asString(block.id),
        });
        if (this.timeline.length > TIMELINE_CAP) {
          this.timeline.splice(0, this.timeline.length - TIMELINE_CAP);
        }
      }
    }
  }

  private applyUser(line: RawLine): void {
    const msg = line.message;
    if (!msg || typeof msg !== 'object') return;
    const content = msg.content;
    if (typeof content === 'string') {
      this.messageCount++;
      this.userMessages++;
      return;
    }
    if (!Array.isArray(content)) return;
    let sawToolResult = false;
    for (const block of content as RawContentBlock[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        sawToolResult = true;
        const id = asString(block.tool_use_id);
        if (id) this.completedToolUses.add(id);
        if (block.is_error === true) this.errorCount++;
      }
    }
    this.messageCount++;
    if (!sawToolResult) this.userMessages++;
  }

  private touchFile(file: string): void {
    const prev = this.fileCounts.get(file);
    if (prev === undefined && this.fileCounts.size >= FILES_CAP) return;
    this.fileCounts.set(file, (prev ?? 0) + 1);
  }

  private pushSeries(ts: string | null): void {
    const millis = ts ? Date.parse(ts) : NaN;
    const t = Number.isFinite(millis)
      ? Math.floor(millis / SERIES_BUCKET_MS) * SERIES_BUCKET_MS
      : this.seriesBuckets.size;
    this.seriesBuckets.set(t, { t, out: this.cumOut, in: this.cumIn });
    if (this.seriesBuckets.size > SERIES_CAP * 2) {
      // Drop every other old bucket rather than the oldest, so the curve keeps its shape.
      const keys = [...this.seriesBuckets.keys()].sort((a, b) => a - b);
      for (let i = 0; i < keys.length - SERIES_CAP; i += 2) {
        this.seriesBuckets.delete(keys[i] as number);
      }
    }
  }

  files(): Array<{ path: string; count: number }> {
    return [...this.fileCounts.entries()]
      .map(([p, count]) => ({ path: p, count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  }

  series(): TokenPoint[] {
    return [...this.seriesBuckets.values()].sort((a, b) => a.t - b.t);
  }
}
