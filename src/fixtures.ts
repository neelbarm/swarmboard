import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates a synthetic `~/.claude/projects`-shaped tree so the dashboard can be
 * demoed and screenshotted without exposing a single real prompt.
 *
 * The shape mirrors what Claude Code actually writes: one planner session per
 * project directory, subagent transcripts under `<sessionId>/subagents/`, and a
 * `.meta.json` sidecar whose `toolUseId` points at the spawning `Agent` tool_use.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(here, '..', '..', 'fixtures');

let uuidCounter = 0;
function uuid(): string {
  uuidCounter++;
  const hex = uuidCounter.toString(16).padStart(12, '0');
  return `f1x7ure0-0000-4000-8000-${hex}`;
}

/** Elapsed millis since the start of a transcript. */
interface Clock {
  ms: number;
}

/**
 * Timestamps are emitted as `__TS_<elapsed>__` placeholders and resolved once the
 * transcript is complete, so a run can be pinned to end at a chosen wall-clock
 * moment without knowing its duration up front.
 */
function tick(clock: Clock, seconds: number): string {
  clock.ms += seconds * 1000;
  return stamp(clock);
}

function stamp(clock: Clock): string {
  return `__TS_${clock.ms}__`;
}

function materialize(lines: string[], clock: Clock, endMs: number): string[] {
  const start = endMs - clock.ms;
  return lines.map((line) =>
    line.replace(/__TS_(\d+)__/g, (_m, offset: string) =>
      new Date(start + Number(offset)).toISOString(),
    ),
  );
}

interface Base {
  sessionId: string;
  agentId?: string;
  cwd: string;
}

function assistantLine(
  base: Base,
  ts: string,
  model: string,
  content: unknown[],
  usage: { in: number; out: number; cw: number; cr: number },
): string {
  return JSON.stringify({
    parentUuid: uuid(),
    isSidechain: base.agentId !== undefined,
    ...(base.agentId ? { agentId: base.agentId } : {}),
    type: 'assistant',
    uuid: uuid(),
    timestamp: ts,
    sessionId: base.sessionId,
    cwd: base.cwd,
    gitBranch: 'main',
    version: '2.0.0',
    userType: 'external',
    message: {
      id: `msg_${uuid()}`,
      role: 'assistant',
      model,
      type: 'message',
      content,
      stop_reason: 'tool_use',
      usage: {
        input_tokens: usage.in,
        cache_creation_input_tokens: usage.cw,
        cache_read_input_tokens: usage.cr,
        output_tokens: usage.out,
        service_tier: 'standard',
      },
    },
  });
}

function toolResultLine(base: Base, ts: string, toolUseId: string, text: string): string {
  return JSON.stringify({
    parentUuid: uuid(),
    isSidechain: base.agentId !== undefined,
    ...(base.agentId ? { agentId: base.agentId } : {}),
    type: 'user',
    uuid: uuid(),
    timestamp: ts,
    sessionId: base.sessionId,
    cwd: base.cwd,
    userType: 'external',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content: text, is_error: false }],
    },
  });
}

function userTextLine(base: Base, ts: string, text: string): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: base.agentId !== undefined,
    ...(base.agentId ? { agentId: base.agentId } : {}),
    type: 'user',
    uuid: uuid(),
    timestamp: ts,
    sessionId: base.sessionId,
    cwd: base.cwd,
    userType: 'external',
    message: { role: 'user', content: text },
  });
}

/** A line type the parser has no special handling for, to prove tolerance. */
function noiseLines(base: Base, ts: string): string[] {
  return [
    JSON.stringify({ type: 'attachment', uuid: uuid(), timestamp: ts, sessionId: base.sessionId, attachment: { type: 'environment', snapshot: { workingDirectory: base.cwd } } }),
    JSON.stringify({ type: 'some-future-line-type', uuid: uuid(), timestamp: ts, sessionId: base.sessionId, payload: { unknown: true } }),
  ];
}

interface ToolStep {
  name: string;
  input: Record<string, unknown>;
  result: string;
  out: number;
}

function toolSequence(base: Base, clock: Clock, model: string, steps: ToolStep[], text: string[]): string[] {
  const lines: string[] = [];
  let cacheRead = 0;
  steps.forEach((step, i) => {
    const id = `toolu_fixture${uuid().slice(-10)}${i}`;
    const ts = tick(clock, 9 + (i % 5) * 4);
    const blocks: unknown[] = [];
    const note = text[i];
    if (note) blocks.push({ type: 'text', text: note });
    blocks.push({ type: 'tool_use', id, name: step.name, input: step.input });
    lines.push(
      assistantLine(base, ts, model, blocks, {
        in: 3,
        out: step.out,
        cw: i === 0 ? 24_000 : 900,
        cr: cacheRead,
      }),
    );
    cacheRead += i === 0 ? 24_000 : 900;
    lines.push(toolResultLine(base, tick(clock, 3), id, step.result));
    if (i === 1) lines.push(...noiseLines(base, ts));
  });
  return lines;
}

interface SubagentSpec {
  agentId: string;
  description: string;
  agentType: string;
  toolUseId: string;
  model: string;
  /** Seconds of transcript time before this agent's first tool call. */
  leadInS: number;
  steps: ToolStep[];
  notes: string[];
  closing: string;
  /** Seconds before "now" that this agent last wrote. 0 means it is still going. */
  staleSeconds: number;
}

const PROJECT_PATH = '/Users/demo/code/orbit-api';
const PROJECT_DIR = '-Users-demo-code-orbit-api';
const SESSION_ID = '9f2c1d40-7b55-4e8a-9d31-0c6a5b1e77aa';
const MODEL_PLANNER = 'claude-opus-5';
const MODEL_WORKER = 'claude-sonnet-5';

const SUBAGENTS: SubagentSpec[] = [
  {
    agentId: 'a91c4de20f7b31a5',
    description: 'Port auth middleware to fastify',
    agentType: 'general-purpose',
    toolUseId: 'toolu_fixture_auth_01',
    model: MODEL_WORKER,
    leadInS: 30,
    staleSeconds: 0,
    steps: [
      { name: 'Read', input: { file_path: `${PROJECT_PATH}/src/middleware/auth.ts` }, result: 'export async function requireSession(req, res) { … }', out: 420 },
      { name: 'Grep', input: { pattern: 'express\\.Router', path: `${PROJECT_PATH}/src` }, result: 'src/routes/index.ts:4\nsrc/routes/billing.ts:9', out: 180 },
      { name: 'Edit', input: { file_path: `${PROJECT_PATH}/src/middleware/auth.ts`, old_string: 'import type { Request }', new_string: 'import type { FastifyRequest }' }, result: 'Applied 1 edit', out: 610 },
      { name: 'Write', input: { file_path: `${PROJECT_PATH}/src/middleware/auth.fastify.ts` }, result: 'wrote 84 lines', out: 1340 },
      { name: 'Bash', input: { command: 'npx vitest run src/middleware --reporter dot', description: 'Run middleware tests' }, result: '14 passed (14)', out: 260 },
      { name: 'Edit', input: { file_path: `${PROJECT_PATH}/src/routes/index.ts`, old_string: 'app.use(requireSession)', new_string: 'app.addHook("preHandler", requireSession)' }, result: 'Applied 1 edit', out: 300 },
    ],
    notes: [
      'Reading the existing middleware before touching anything.',
      'Finding every router that mounts it.',
      'Swapping the Express types for Fastify equivalents.',
      'Writing the Fastify-native plugin.',
      'Running the middleware suite.',
      'Rewiring the route registration.',
    ],
    closing: 'Auth middleware now registers as a Fastify preHandler hook. 14 tests green.',
  },
  {
    agentId: 'b47e88c1d2a06934',
    description: 'Rewrite the rate limiter with a token bucket',
    agentType: 'general-purpose',
    toolUseId: 'toolu_fixture_rate_02',
    model: MODEL_WORKER,
    leadInS: 55,
    staleSeconds: 0,
    steps: [
      { name: 'Read', input: { file_path: `${PROJECT_PATH}/src/limit/fixed-window.ts` }, result: 'const WINDOW_MS = 60_000 …', out: 380 },
      { name: 'Write', input: { file_path: `${PROJECT_PATH}/src/limit/token-bucket.ts` }, result: 'wrote 112 lines', out: 1720 },
      { name: 'Write', input: { file_path: `${PROJECT_PATH}/test/token-bucket.test.ts` }, result: 'wrote 96 lines', out: 1180 },
      { name: 'Bash', input: { command: 'node --test test/token-bucket.test.js', description: 'Run the new limiter tests' }, result: '# pass 9\n# fail 0', out: 210 },
      { name: 'Bash', input: { command: 'node scripts/bench-limiter.mjs --rps 5000', description: 'Benchmark the limiter' }, result: 'p99 0.34ms  allocs/op 1', out: 240 },
    ],
    notes: [
      'Starting from the fixed-window implementation it replaces.',
      'Writing the bucket: refill on read, no timers.',
      'Covering burst, drain and refill.',
      'Running the suite.',
      'Benchmarking against the old limiter.',
    ],
    closing: 'Token bucket lands at p99 0.34ms with one allocation per call, down from 0.9ms.',
  },
  {
    agentId: 'c03fa7b95e18d266',
    description: 'Document the public REST surface',
    agentType: 'general-purpose',
    toolUseId: 'toolu_fixture_docs_03',
    model: MODEL_WORKER,
    leadInS: 20,
    staleSeconds: 640,
    steps: [
      { name: 'Glob', input: { pattern: 'src/routes/**/*.ts' }, result: '11 files', out: 150 },
      { name: 'Read', input: { file_path: `${PROJECT_PATH}/src/routes/billing.ts` }, result: 'router.post("/v1/invoices", …)', out: 340 },
      { name: 'Write', input: { file_path: `${PROJECT_PATH}/docs/rest-api.md` }, result: 'wrote 240 lines', out: 2600 },
      { name: 'Bash', input: { command: 'npx markdownlint docs/rest-api.md', description: 'Lint the generated docs' }, result: 'no issues found', out: 120 },
    ],
    notes: [
      'Listing every route module.',
      'Reading the billing routes, which have the most parameters.',
      'Writing the reference.',
      'Linting it.',
    ],
    closing: 'docs/rest-api.md covers all 27 endpoints with request and response examples.',
  },
];

export async function writeFixtures(dir = FIXTURES_DIR): Promise<{ dir: string; files: number }> {
  uuidCounter = 0;
  const now = Date.now();
  const projectDir = path.join(dir, PROJECT_DIR);
  const subagentDir = path.join(projectDir, SESSION_ID, 'subagents');
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(subagentDir, { recursive: true });

  const base: Base = { sessionId: SESSION_ID, cwd: PROJECT_PATH };
  /** When the planner finished fanning out. Everything before it is scaled back from here. */
  const spawnAtMs = now - 15 * 60_000;
  const clock: Clock = { ms: 0 };
  const planner: string[] = [];

  planner.push(
    JSON.stringify({ type: 'custom-title', customTitle: 'Fastify migration swarm', sessionId: SESSION_ID }),
  );
  planner.push(
    userTextLine(
      base,
      tick(clock, 0),
      'Migrate orbit-api off Express. Split the work across agents: auth middleware, rate limiter, and the REST docs.',
    ),
  );
  planner.push(...noiseLines(base, stamp(clock)));

  const plannerSteps: ToolStep[] = [
    { name: 'Read', input: { file_path: `${PROJECT_PATH}/package.json` }, result: '"express": "^4.19.2"', out: 260 },
    { name: 'Bash', input: { command: 'rg -c "from \'express\'" src | sort -t: -k2 -rn | head', description: 'Count Express imports' }, result: 'src/routes/index.ts:6\nsrc/middleware/auth.ts:4', out: 300 },
  ];
  planner.push(...toolSequence(base, clock, MODEL_PLANNER, plannerSteps, [
    'Checking what we depend on today.',
    'Finding where Express is actually reached for.',
  ]));

  // The three Agent spawns, in one assistant turn, exactly as a fan-out looks.
  const spawnTs = tick(clock, 12);
  planner.push(
    assistantLine(
      base,
      spawnTs,
      MODEL_PLANNER,
      [
        { type: 'text', text: 'Three independent seams. Fanning out one agent each.' },
        ...SUBAGENTS.map((s) => ({
          type: 'tool_use',
          id: s.toolUseId,
          name: 'Agent',
          input: { description: s.description, subagent_type: s.agentType, prompt: `${s.description}. Report back with what changed.` },
        })),
      ],
      { in: 5, out: 890, cw: 1200, cr: 48_000 },
    ),
  );

  // Resolve the planner's prelude so it lands just before the fan-out.
  const plannerResolved = materialize(planner, clock, spawnAtMs);

  const files: Array<{ file: string; lines: string[]; mtime: number }> = [];

  for (const spec of SUBAGENTS) {
    const subBase: Base = { sessionId: SESSION_ID, agentId: spec.agentId, cwd: PROJECT_PATH };
    const subClock: Clock = { ms: 0 };
    const lines: string[] = [
      userTextLine(subBase, tick(subClock, spec.leadInS), `${spec.description}. Report back with what changed.`),
    ];
    lines.push(...toolSequence(subBase, subClock, spec.model, spec.steps, spec.notes));
    lines.push(
      assistantLine(subBase, tick(subClock, 8), spec.model, [{ type: 'text', text: spec.closing }], {
        in: 4,
        out: 520,
        cw: 700,
        cr: 30_000,
      }),
    );

    const mtime = spec.staleSeconds > 0 ? now - spec.staleSeconds * 1000 : now - 4000;
    files.push({
      file: path.join(subagentDir, `agent-${spec.agentId}.jsonl`),
      lines: materialize(lines, subClock, mtime),
      mtime,
    });
    await fsp.writeFile(
      path.join(subagentDir, `agent-${spec.agentId}.meta.json`),
      JSON.stringify({
        agentType: spec.agentType,
        description: spec.description,
        toolUseId: spec.toolUseId,
        spawnDepth: 1,
        requestShape: 'background',
        model: 'sonnet',
      }),
    );

    // The finished agent's result came back to the planner; the two live ones have not.
    if (spec.staleSeconds > 0) {
      plannerResolved.push(
        toolResultLine(base, new Date(mtime + 1000).toISOString(), spec.toolUseId, spec.closing),
      );
    }
  }

  plannerResolved.push(
    assistantLine(base, new Date(now - 6000).toISOString(), MODEL_PLANNER, [
      { type: 'text', text: 'Docs agent is done. Waiting on auth and the rate limiter before I run the full suite.' },
    ], { in: 6, out: 410, cw: 900, cr: 72_000 }),
  );
  // One deliberately corrupt line: the parser must skip it and keep going.
  plannerResolved.push('{"type":"assistant","message":{"content":[{"type":"text"');

  files.push({ file: path.join(projectDir, `${SESSION_ID}.jsonl`), lines: plannerResolved, mtime: now - 2000 });

  for (const f of files) {
    await fsp.writeFile(f.file, `${f.lines.join('\n')}\n`);
    const when = new Date(f.mtime);
    await fsp.utimes(f.file, when, when);
  }

  return { dir, files: files.length };
}

/** Rewrite the fixtures when they are old enough that everything would read as idle. */
export async function ensureFreshFixtures(dir = FIXTURES_DIR): Promise<void> {
  try {
    const session = path.join(dir, PROJECT_DIR, `${SESSION_ID}.jsonl`);
    const stat = await fsp.stat(session);
    if (Date.now() - stat.mtimeMs < 60_000) return;
  } catch {
    /* missing or unreadable: regenerate */
  }
  await writeFixtures(dir);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  writeFixtures().then(
    (r) => process.stdout.write(`wrote ${r.files} synthetic transcripts to ${r.dir}\n`),
    (err: unknown) => {
      process.stderr.write(`fixtures: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
