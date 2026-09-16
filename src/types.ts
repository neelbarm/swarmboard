/**
 * Shapes derived by inspecting real Claude Code transcripts in ~/.claude/projects.
 *
 * Every field is optional on purpose: transcripts are written by a moving target
 * and the parser must never assume a key exists.
 */

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [k: string]: unknown;
}

export interface RawContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
  [k: string]: unknown;
}

export interface RawMessage {
  role?: string;
  model?: string;
  usage?: RawUsage;
  content?: string | RawContentBlock[];
  [k: string]: unknown;
}

/** One parsed JSONL line. */
export interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  agentId?: string;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  message?: RawMessage;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  [k: string]: unknown;
}

/** Sidecar written next to a subagent transcript. */
export interface AgentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  model?: string;
  requestShape?: string;
  [k: string]: unknown;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface ToolEvent {
  /** Monotonic index within the transcript, used for stable ordering. */
  seq: number;
  ts: string | null;
  name: string;
  /** Short human summary of the tool input: a command, a file path, an agent description. */
  detail: string;
  /** Primary file path this call touched, when there is one. */
  file: string | null;
  id: string | null;
}

export interface TokenPoint {
  /** Epoch millis, bucketed. */
  t: number;
  /** Cumulative billable output tokens at this point. */
  out: number;
  /** Cumulative billable input tokens (incl. cache) at this point. */
  in: number;
}

export type AgentStatus = 'active' | 'idle' | 'finished';

export interface AgentNode {
  /** Stable id: `<sessionId>` for a root session, `<sessionId>/<agentId>` for a subagent. */
  id: string;
  parentId: string | null;
  kind: 'session' | 'subagent';
  sessionId: string;
  agentId: string | null;

  projectDir: string;
  projectPath: string;
  projectName: string;

  title: string | null;
  agentType: string | null;
  description: string | null;
  model: string | null;
  gitBranch: string | null;

  startedAt: string | null;
  lastActivityAt: string | null;
  fileMtimeMs: number;
  status: AgentStatus;

  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  errorCount: number;

  tokens: TokenTotals;
  costUSD: number;
  costIsEstimate: true;

  toolCounts: Record<string, number>;
  files: Array<{ path: string; count: number }>;
  timeline: ToolEvent[];
  tokenSeries: TokenPoint[];
  lastText: string | null;
}

export interface ActivityItem {
  id: string;
  agentId: string;
  agentLabel: string;
  projectName: string;
  ts: string | null;
  kind: 'tool' | 'text' | 'spawn' | 'error';
  name: string;
  detail: string;
}

export interface Snapshot {
  generatedAt: string;
  root: string;
  agents: AgentNode[];
  activity: ActivityItem[];
  totals: {
    agents: number;
    active: number;
    sessions: number;
    subagents: number;
    toolCalls: number;
    tokens: TokenTotals;
    costUSD: number;
  };
}
