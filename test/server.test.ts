import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { writeFixtures } from '../src/fixtures.js';

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/* eslint-disable @typescript-eslint/no-explicit-any */
async function getJSON(url: string): Promise<any> {
  const res = await fetch(url);
  return res.json();
}

async function fixtureRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'swarmboard-server-'));
  const dir = path.join(root, '-repo-demo');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, `${SESSION}.jsonl`),
    [
      JSON.stringify({ type: 'custom-title', customTitle: 'Served session', sessionId: SESSION }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        sessionId: SESSION,
        cwd: '/repo/demo',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 5, output_tokens: 50 },
          content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'echo served' } }],
        },
      }),
    ].join('\n') + '\n',
  );
  return root;
}

test('the HTTP API serves a snapshot, health and the dashboard itself', async () => {
  const root = await fixtureRoot();
  const server = await startServer({ root, port: 0 });
  try {
    const snap = await getJSON(`${server.url}/api/snapshot`);
    assert.equal(snap.agents.length, 1);
    assert.equal(snap.agents[0].title, 'Served session');
    assert.equal(snap.agents[0].toolCalls, 1);
    assert.equal(snap.totals.toolCalls, 1);
    assert.equal(snap.root, path.resolve(root));

    const health = await getJSON(`${server.url}/api/health`);
    assert.equal(health.ok, true);

    const agent = await getJSON(`${server.url}/api/agent?id=${encodeURIComponent(SESSION)}`);
    assert.equal(agent.id, SESSION);

    const missing = await fetch(`${server.url}/api/agent?id=nope`);
    assert.equal(missing.status, 404);

    const page = await fetch(`${server.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>swarmboard<\/title>/);
    assert.match(html, /\/app\.js/);

    for (const asset of ['/app.js', '/styles.css']) {
      const res = await fetch(`${server.url}${asset}`);
      assert.equal(res.status, 200, `${asset} should be served`);
      assert.ok((await res.text()).length > 500);
    }
  } finally {
    await server.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the static handler refuses to walk out of the public directory', async () => {
  const root = await fixtureRoot();
  const server = await startServer({ root, port: 0 });
  try {
    const res = await fetch(`${server.url}/../package.json`, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `expected a refusal, got ${res.status}`);
    const missing = await fetch(`${server.url}/nope.css`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the SSE stream sends a snapshot on connect and again when a file grows', async () => {
  const root = await fixtureRoot();
  const server = await startServer({ root, port: 0 });
  const controller = new AbortController();

  try {
    const res = await fetch(`${server.url}/api/stream`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    /** Read until `n` complete `snapshot` events have arrived, or time runs out. */
    const readSnapshots = async (n: number, timeoutMs: number): Promise<unknown[]> => {
      const found: unknown[] = [];
      const deadline = Date.now() + timeoutMs;
      while (found.length < n && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!frame.startsWith('event: snapshot')) continue;
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) found.push(JSON.parse(dataLine.slice(6)));
        }
      }
      return found;
    };

    const first = await readSnapshots(1, 5000);
    assert.equal(first.length, 1, 'a snapshot arrives immediately on connect');
    assert.equal((first[0] as { agents: unknown[] }).agents.length, 1);

    // Append a second tool call; the watcher should push an updated snapshot.
    await fsp.appendFile(
      path.join(root, '-repo-demo', `${SESSION}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        sessionId: SESSION,
        cwd: '/repo/demo',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 1, output_tokens: 10 },
          content: [{ type: 'tool_use', id: 'x2', name: 'Read', input: { file_path: '/repo/demo/new.ts' } }],
        },
      }) + '\n',
    );

    const next = await readSnapshots(1, 8000);
    assert.equal(next.length, 1, 'an append pushes a new snapshot');
    const agent = (next[0] as { agents: Array<{ toolCalls: number }> }).agents[0];
    assert.equal(agent?.toolCalls, 2, 'the pushed snapshot reflects the appended line');
  } finally {
    controller.abort();
    await server.close();
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the generated demo fixtures parse into one planner and three subagents', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'swarmboard-fixtures-'));
  try {
    await writeFixtures(dir);
    const server = await startServer({ root: dir, port: 0, label: 'demo fixtures' });
    try {
      const snap = await getJSON(`${server.url}/api/snapshot`);
      assert.equal(snap.label, 'demo fixtures');
      assert.equal(snap.totals.sessions, 1);
      assert.equal(snap.totals.subagents, 3);

      const statuses = snap.agents
        .filter((a: { kind: string }) => a.kind === 'subagent')
        .map((a: { status: string }) => a.status)
        .sort();
      assert.deepEqual(statuses, ['active', 'active', 'finished'], 'two still running, one reported back');

      const planner = snap.agents.find((a: { kind: string }) => a.kind === 'session');
      assert.equal(planner.title, 'Fastify migration swarm');
      assert.equal(planner.toolCounts.Agent, 3, 'the planner spawned three agents');
      assert.ok(planner.costUSD > 0);

      for (const a of snap.agents) {
        assert.ok(a.tokenSeries.length > 1, `${a.id} should have a drawable sparkline`);
        assert.ok(a.projectPath === '/Users/demo/code/orbit-api');
      }
    } finally {
      await server.close();
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
