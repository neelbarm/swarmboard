import test from 'node:test';
import assert from 'node:assert/strict';
import { rateFor, estimateCost, formatUSD, FALLBACK_RATE } from '../src/pricing.js';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseSince, compactTokens, renderTable, runStats } from '../src/stats.js';
import { parseArgs, DEFAULT_PORT } from '../src/cli.js';

test('rateFor matches a model family and falls back for anything unknown', () => {
  assert.deepEqual(rateFor('claude-opus-5'), { input: 15, output: 75 });
  assert.deepEqual(rateFor('claude-sonnet-5'), { input: 3, output: 15 });
  assert.deepEqual(rateFor('claude-haiku-4-5-20251001'), { input: 0.8, output: 4 });
  assert.deepEqual(rateFor('CLAUDE-OPUS-4-8'), { input: 15, output: 75 }, 'case insensitive');
  assert.deepEqual(rateFor('some-other-model'), FALLBACK_RATE);
  assert.deepEqual(rateFor(null), FALLBACK_RATE);
  assert.deepEqual(rateFor(undefined), FALLBACK_RATE);
});

test('estimateCost bills cache writes at 1.25x input and cache reads at 0.1x', () => {
  const cost = estimateCost('claude-sonnet-5', {
    input: 1_000_000,
    output: 1_000_000,
    cacheCreate: 1_000_000,
    cacheRead: 1_000_000,
  });
  // 3 (input) + 15 (output) + 3.75 (cache write) + 0.3 (cache read)
  assert.ok(Math.abs(cost - 22.05) < 1e-9, `expected 22.05, got ${cost}`);
});

test('estimateCost scales linearly and is zero for no usage', () => {
  const zero = estimateCost('claude-opus-5', { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 });
  assert.equal(zero, 0);

  const one = estimateCost('claude-opus-5', { input: 1000, output: 500, cacheCreate: 0, cacheRead: 0 });
  const two = estimateCost('claude-opus-5', { input: 2000, output: 1000, cacheCreate: 0, cacheRead: 0 });
  assert.ok(Math.abs(two - one * 2) < 1e-12);
});

test('estimateCost separates the expensive model from the cheap one', () => {
  const usage = { input: 100_000, output: 100_000, cacheCreate: 0, cacheRead: 0 };
  assert.ok(estimateCost('claude-opus-5', usage) > estimateCost('claude-sonnet-5', usage));
  assert.ok(estimateCost('claude-sonnet-5', usage) > estimateCost('claude-haiku-4-5', usage));
});

test('formatUSD keeps small numbers legible', () => {
  assert.equal(formatUSD(12.3456), '$12.35');
  assert.equal(formatUSD(0.0456), '$0.046');
  assert.equal(formatUSD(0.00012), '$0.0001');
});

test('compactTokens shortens big counts', () => {
  assert.equal(compactTokens(999), '999');
  assert.equal(compactTokens(1500), '1.5k');
  assert.equal(compactTokens(2_400_000), '2.4M');
});

test('parseSince understands the durations the CLI advertises', () => {
  assert.equal(parseSince('24h'), 24 * 3_600_000);
  assert.equal(parseSince('90m'), 90 * 60_000);
  assert.equal(parseSince('7d'), 7 * 86_400_000);
  assert.equal(parseSince('45s'), 45_000);
  assert.equal(parseSince('2'), 2 * 3_600_000, 'a bare number means hours');
  assert.equal(parseSince('1.5h'), 1.5 * 3_600_000);
  assert.equal(parseSince('yesterday'), null);
  assert.equal(parseSince('10y'), null);
  assert.equal(parseSince(''), null);
});

test('renderTable aligns columns and ignores ANSI colour when measuring', () => {
  const out = renderTable(
    [
      ['[32ma[0m', '1'],
      ['bbbb', '22'],
    ],
    ['NAME', 'N'],
    ['l', 'r'],
    false,
  );
  const lines = out.split('\n');
  assert.equal(lines.length, 4, 'header, rule, two rows');
  // The colour codes must not widen the first column.
  assert.ok(lines[2]?.startsWith('[32ma[0m   '));
  assert.ok(lines[3]?.startsWith('bbbb'));
});

test('parseArgs reads commands, flags and their values', () => {
  const plain = parseArgs([]);
  assert.equal(plain.command, 'serve');
  assert.equal(plain.port, DEFAULT_PORT);
  assert.equal(plain.error, null);

  const stats = parseArgs(['stats', '--since', '24h', '--project', 'orbit', '--active', '--limit', '5']);
  assert.equal(stats.command, 'stats');
  assert.equal(stats.since, '24h');
  assert.equal(stats.project, 'orbit');
  assert.equal(stats.activeOnly, true);
  assert.equal(stats.limit, 5);

  assert.equal(parseArgs(['--dir', '/tmp/x']).root, '/tmp/x');
  assert.equal(parseArgs(['--port', '8080']).port, 8080);
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['-v']).command, 'version');
  assert.equal(parseArgs(['--demo']).demo, true);
});

test('parseArgs reports bad input instead of guessing', () => {
  assert.match(parseArgs(['--port', 'abc']).error ?? '', /port/);
  assert.match(parseArgs(['--port']).error ?? '', /port/);
  assert.match(parseArgs(['--dir']).error ?? '', /dir/);
  assert.match(parseArgs(['--since', 'soon']).error ?? '', /duration/);
  assert.match(parseArgs(['--limit', '0']).error ?? '', /limit/);
  assert.match(parseArgs(['--nope']).error ?? '', /unknown option/);
  assert.match(parseArgs(['frobnicate']).error ?? '', /unknown command/);
});

test('the stats table strips control bytes that arrive in transcript text', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'swarmboard-ansi-'));
  const dir = path.join(root, '-repo-demo');
  await fsp.mkdir(dir, { recursive: true });
  const session = 'cccccccc-dddd-eeee-ffff-000000000000';
  // A transcript can hold any bytes at all. Echoing an escape sequence straight to
  // the terminal would let one repaint or relabel the table around it.
  const esc = String.fromCharCode(27);
  await fsp.writeFile(
    path.join(dir, `${session}.jsonl`),
    [
      JSON.stringify({ type: 'custom-title', customTitle: `${esc}[2J${esc}[31mPWNED`, sessionId: session }),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date().toISOString(),
        sessionId: session,
        cwd: '/repo/demo',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-5',
          usage: { output_tokens: 3 },
          content: [{ type: 'tool_use', id: 'k1', name: `Bash${esc}[1;44m`, input: { command: 'echo hi' } }],
        },
      }),
    ].join('\n') + '\n',
  );

  let out = '';
  await runStats(
    { root, sinceMs: null, project: null, activeOnly: false, limit: 50 },
    (s) => {
      out += s;
    },
  );
  await fsp.rm(root, { recursive: true, force: true });

  assert.ok(out.includes('PWNED'), 'the text itself still shows');
  assert.ok(!out.includes(esc), 'but no escape byte reaches the terminal');
});
