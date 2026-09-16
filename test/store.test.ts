import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SwarmStore, buildTree, decimate } from '../src/store.js';
import type { AgentNode } from '../src/types.js';

async function tmpRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'swarmboard-test-'));
}

const SESSION = '11111111-2222-3333-4444-555555555555';

function assistantLine(ts: string, blocks: unknown[], out = 100, agentId?: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: SESSION,
    cwd: '/repo/demo',
    ...(agentId ? { agentId, isSidechain: true } : {}),
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: blocks,
    },
  });
}

async function seed(root: string): Promise<{ projectDir: string; sessionFile: string; subDir: string }> {
  const projectDir = path.join(root, '-repo-demo');
  const subDir = path.join(projectDir, SESSION, 'subagents');
  await fsp.mkdir(subDir, { recursive: true });
  const sessionFile = path.join(projectDir, `${SESSION}.jsonl`);
  await fsp.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: 'custom-title', customTitle: 'Root session', sessionId: SESSION }),
      assistantLine('2026-09-16T10:00:00.000Z', [
        { type: 'tool_use', id: 'spawn-1', name: 'Agent', input: { description: 'Child work' } },
      ]),
    ].join('\n') + '\n',
  );
  return { projectDir, sessionFile, subDir };
}

test('the store finds root sessions and their subagents', async () => {
  const root = await tmpRoot();
  const { subDir } = await seed(root);
  await fsp.writeFile(
    path.join(subDir, 'agent-abc123.jsonl'),
    assistantLine('2026-09-16T10:00:30.000Z', [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'echo hi' } }], 40, 'abc123') + '\n',
  );
  await fsp.writeFile(
    path.join(subDir, 'agent-abc123.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Child work', toolUseId: 'spawn-1' }),
  );

  const store = new SwarmStore({ root });
  await store.refresh();
  const snap = store.snapshot();
  store.close();

  assert.equal(snap.totals.sessions, 1);
  assert.equal(snap.totals.subagents, 1);

  const parent = snap.agents.find((a) => a.id === SESSION);
  const child = snap.agents.find((a) => a.id === `${SESSION}/abc123`);
  assert.ok(parent && child);
  assert.equal(parent.title, 'Root session');
  assert.equal(parent.kind, 'session');
  assert.equal(child.kind, 'subagent');
  assert.equal(child.parentId, SESSION, 'the child points back at the session that spawned it');
  assert.equal(child.description, 'Child work', 'the sidecar supplies the label');
  assert.equal(child.projectPath, '/repo/demo', 'cwd wins over the encoded directory name');
  assert.equal(child.projectName, 'demo');

  await fsp.rm(root, { recursive: true, force: true });
});

test('tailing appended lines gives the same result as reading the file whole', async () => {
  const rootA = await tmpRoot();
  const rootB = await tmpRoot();

  const lines = [
    JSON.stringify({ type: 'custom-title', customTitle: 'Incremental', sessionId: SESSION }),
    assistantLine('2026-09-16T10:00:00.000Z', [{ type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/repo/demo/one.ts' } }], 10),
    assistantLine('2026-09-16T10:01:00.000Z', [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'npm ci' } }], 20),
    assistantLine('2026-09-16T10:02:00.000Z', [{ type: 'text', text: 'done' }], 30),
  ];

  // A: written all at once.
  const dirA = path.join(rootA, '-repo-demo');
  await fsp.mkdir(dirA, { recursive: true });
  await fsp.writeFile(path.join(dirA, `${SESSION}.jsonl`), lines.join('\n') + '\n');
  const storeA = new SwarmStore({ root: rootA });
  await storeA.refresh();
  const whole = storeA.snapshot().agents[0];
  storeA.close();

  // B: written a line at a time, with a refresh in between, and one read landing
  // in the middle of a line.
  const dirB = path.join(rootB, '-repo-demo');
  await fsp.mkdir(dirB, { recursive: true });
  const fileB = path.join(dirB, `${SESSION}.jsonl`);
  await fsp.writeFile(fileB, '');
  const storeB = new SwarmStore({ root: rootB });
  await storeB.refresh();

  for (const line of lines) {
    const half = Math.floor(line.length / 2);
    await fsp.appendFile(fileB, line.slice(0, half));
    await storeB.refresh(); // a partial line must not be parsed or dropped
    await fsp.appendFile(fileB, `${line.slice(half)}\n`);
    await storeB.refresh();
  }
  const tailed = storeB.snapshot().agents[0];
  storeB.close();

  assert.ok(whole && tailed);
  assert.equal(tailed.toolCalls, whole.toolCalls);
  assert.equal(tailed.messageCount, whole.messageCount);
  assert.equal(tailed.tokens.output, whole.tokens.output);
  assert.deepEqual(tailed.toolCounts, whole.toolCounts);
  assert.equal(tailed.title, whole.title);
  assert.equal(tailed.lastText, whole.lastText);
  assert.deepEqual(tailed.files, whole.files);
  assert.equal(tailed.toolCalls, 2);

  await fsp.rm(rootA, { recursive: true, force: true });
  await fsp.rm(rootB, { recursive: true, force: true });
});

test('a truncated or rewritten file is re-read from the start rather than doubled', async () => {
  const root = await tmpRoot();
  const dir = path.join(root, '-repo-demo');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${SESSION}.jsonl`);
  await fsp.writeFile(
    file,
    [
      assistantLine('2026-09-16T10:00:00.000Z', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'one' } }]),
      assistantLine('2026-09-16T10:01:00.000Z', [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'two' } }]),
    ].join('\n') + '\n',
  );

  const store = new SwarmStore({ root });
  await store.refresh();
  assert.equal(store.snapshot().agents[0]?.toolCalls, 2);

  await fsp.writeFile(
    file,
    assistantLine('2026-09-16T10:02:00.000Z', [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'three' } }]) + '\n',
  );
  await store.refresh();
  assert.equal(store.snapshot().agents[0]?.toolCalls, 1, 'state was rebuilt, not appended to');
  store.close();

  await fsp.rm(root, { recursive: true, force: true });
});

test('malformed lines are skipped without losing the lines around them', async () => {
  const root = await tmpRoot();
  const dir = path.join(root, '-repo-demo');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, `${SESSION}.jsonl`),
    [
      assistantLine('2026-09-16T10:00:00.000Z', [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'one' } }]),
      '{"type":"assistant","message":{"content":[',
      'total garbage, not even json',
      '',
      assistantLine('2026-09-16T10:01:00.000Z', [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'two' } }]),
    ].join('\n') + '\n',
  );

  const store = new SwarmStore({ root });
  await store.refresh();
  const agent = store.snapshot().agents[0];
  store.close();
  assert.equal(agent?.toolCalls, 2);

  await fsp.rm(root, { recursive: true, force: true });
});

test('status is active while the file is fresh, finished once the parent has the result', async () => {
  const root = await tmpRoot();
  const { subDir, projectDir } = await seed(root);

  // The parent records a tool_result for the spawn, so the child has reported back.
  await fsp.appendFile(
    path.join(projectDir, `${SESSION}.jsonl`),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-09-16T10:05:00.000Z',
      sessionId: SESSION,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'spawn-1', content: 'done' }] },
    }) + '\n',
  );

  const doneFile = path.join(subDir, 'agent-done1.jsonl');
  await fsp.writeFile(doneFile, assistantLine('2026-09-16T10:04:00.000Z', [{ type: 'text', text: 'all set' }], 5, 'done1') + '\n');
  await fsp.writeFile(path.join(subDir, 'agent-done1.meta.json'), JSON.stringify({ toolUseId: 'spawn-1', description: 'Done child' }));

  const runningFile = path.join(subDir, 'agent-run01.jsonl');
  await fsp.writeFile(runningFile, assistantLine('2026-09-16T10:04:00.000Z', [{ type: 'text', text: 'still going' }], 5, 'run01') + '\n');
  await fsp.writeFile(path.join(subDir, 'agent-run01.meta.json'), JSON.stringify({ toolUseId: 'spawn-2', description: 'Busy child' }));

  // Age both children past the 90s activity window.
  const old = new Date(Date.now() - 10 * 60_000);
  await fsp.utimes(doneFile, old, old);
  await fsp.utimes(runningFile, old, old);

  const store = new SwarmStore({ root });
  await store.refresh();
  const snap = store.snapshot();
  store.close();

  const done = snap.agents.find((a) => a.id === `${SESSION}/done1`);
  const running = snap.agents.find((a) => a.id === `${SESSION}/run01`);
  const parent = snap.agents.find((a) => a.id === SESSION);

  assert.equal(done?.status, 'finished', 'its result came back to the parent');
  assert.equal(running?.status, 'idle', 'no result yet, and the file has gone quiet');
  assert.equal(parent?.status, 'active', 'the parent file was just written');

  await fsp.rm(root, { recursive: true, force: true });
});

test('the activity feed collects tool calls newest-first across agents', async () => {
  const root = await tmpRoot();
  const { subDir } = await seed(root);
  await fsp.writeFile(
    path.join(subDir, 'agent-feed01.jsonl'),
    [
      assistantLine('2026-09-16T10:01:00.000Z', [{ type: 'tool_use', id: 'f1', name: 'Read', input: { file_path: '/repo/demo/x.ts' } }], 5, 'feed01'),
      assistantLine('2026-09-16T10:02:00.000Z', [{ type: 'tool_use', id: 'f2', name: 'Bash', input: { command: 'make' } }], 5, 'feed01'),
    ].join('\n') + '\n',
  );

  const store = new SwarmStore({ root });
  await store.refresh();
  const snap = store.snapshot();
  store.close();

  assert.ok(snap.activity.length >= 3);
  const names = snap.activity.map((a) => a.name);
  assert.ok(names.includes('Bash') && names.includes('Read') && names.includes('Agent'));
  const spawn = snap.activity.find((a) => a.name === 'Agent');
  assert.equal(spawn?.kind, 'spawn', 'spawning an agent is its own kind of event');
  // Each item is stable and unique so the browser can key on it.
  assert.equal(new Set(snap.activity.map((a) => a.id)).size, snap.activity.length);

  await fsp.rm(root, { recursive: true, force: true });
});

function node(id: string, parentId: string | null, startedAt = '2026-09-16T10:00:00.000Z'): AgentNode {
  return { id, parentId, startedAt } as AgentNode;
}

test('buildTree nests children and promotes orphans to roots', () => {
  const tree = buildTree([
    node('root', null),
    node('root/b', 'root', '2026-09-16T10:02:00.000Z'),
    node('root/a', 'root', '2026-09-16T10:01:00.000Z'),
    node('lonely/x', 'missing-parent'),
  ]);

  const roots = tree.map((g) => g.node.id);
  assert.deepEqual(roots, ['root', 'lonely/x'], 'a child with no parent present becomes a root');

  const rootGroup = tree.find((g) => g.node.id === 'root');
  assert.deepEqual(rootGroup?.children.map((c) => c.id), ['root/a', 'root/b'], 'children sort by start time');
  assert.deepEqual(tree.find((g) => g.node.id === 'lonely/x')?.children, []);
});

test('decimate keeps the endpoints and the requested count', () => {
  const points = Array.from({ length: 500 }, (_, i) => ({ t: i, out: i * 2, in: i }));
  const small = decimate(points, 50);
  assert.equal(small.length, 50);
  assert.equal(small[0]?.t, 0);
  assert.equal(small[small.length - 1]?.t, 499);
  assert.equal(decimate(points.slice(0, 10), 50).length, 10, 'short series pass through untouched');
});

test('a directory with no transcripts yields an empty but valid snapshot', async () => {
  const root = await tmpRoot();
  const store = new SwarmStore({ root });
  await store.refresh();
  const snap = store.snapshot();
  store.close();
  assert.deepEqual(snap.agents, []);
  assert.equal(snap.totals.agents, 0);
  assert.equal(snap.totals.costUSD, 0);
  await fsp.rm(root, { recursive: true, force: true });
});

test('a missing root directory does not throw', async () => {
  const store = new SwarmStore({ root: '/definitely/not/a/real/path/swarmboard' });
  await assert.doesNotReject(() => store.refresh());
  assert.equal(store.snapshot().agents.length, 0);
  store.close();
});
