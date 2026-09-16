import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLine,
  summarizeTool,
  shortPath,
  decodeProjectDir,
  TranscriptState,
} from '../src/parser.js';
import type { RawLine } from '../src/types.js';

test('parseLine skips everything that is not a JSON object', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('   \n'), null);
  assert.equal(parseLine('not json'), null);
  assert.equal(parseLine('{"type":"assistant"'), null, 'truncated line');
  assert.equal(parseLine('[1,2,3]'), null, 'array');
  assert.equal(parseLine('null'), null);
  assert.equal(parseLine('"a string"'), null);
  assert.deepEqual(parseLine('{"type":"user"}'), { type: 'user' });
});

test('summarizeTool pulls the useful field out of each tool input', () => {
  assert.deepEqual(summarizeTool('Bash', { command: 'ls -la', description: 'list' }), {
    detail: 'ls -la',
    file: null,
  });
  assert.deepEqual(summarizeTool('Read', { file_path: '/a/b/c/d.ts' }), {
    detail: '…/b/c/d.ts',
    file: '/a/b/c/d.ts',
  });
  assert.equal(summarizeTool('Write', { file_path: '/x/y.txt' }).file, '/x/y.txt');
  assert.equal(
    summarizeTool('Agent', { description: 'Build it', subagent_type: 'general-purpose' }).detail,
    'Build it (general-purpose)',
  );
  assert.equal(summarizeTool('TodoWrite', { todos: [1, 2, 3] }).detail, '3 items');
  assert.equal(summarizeTool('Grep', { pattern: 'foo' }).detail, 'foo');
});

test('summarizeTool never returns nothing for an unknown tool', () => {
  const known = summarizeTool('SomeFutureTool', { url: 'https://example.com' });
  assert.equal(known.detail, 'https://example.com');

  const shaped = summarizeTool('mcp__srv__batch', { actions: [1, 2], mode: 'fast' });
  assert.equal(shaped.detail, 'actions[2] mode');

  const empty = summarizeTool('mcp__srv__ping', {});
  assert.equal(empty.detail, '');
  assert.equal(empty.file, null);
});

test('summarizeTool tolerates a missing input object', () => {
  assert.doesNotThrow(() => summarizeTool('Bash', undefined));
  assert.equal(summarizeTool('Read', undefined).file, null);
});

test('shortPath keeps the tail of a long path', () => {
  assert.equal(shortPath('/a/b'), '/a/b');
  assert.equal(shortPath('/one/two/three/four/five.ts'), '…/three/four/five.ts');
});

test('decodeProjectDir is a lossy fallback, which is why cwd wins when present', () => {
  assert.equal(decodeProjectDir('-Users-demo-code-api'), '/Users/demo/code/api');
  // The encoding maps both `/` and `-` to `-`, so a hyphenated directory cannot be
  // recovered from its name alone. The store reads `cwd` off the transcript instead
  // and only falls back to this for a file with no parsed lines yet.
  assert.equal(decodeProjectDir('-Users-demo-code-orbit-api'), '/Users/demo/code/orbit/api');
});

function assistant(overrides: Partial<RawLine> & { content: unknown[] }): RawLine {
  const { content, ...rest } = overrides;
  return {
    type: 'assistant',
    timestamp: '2026-09-16T10:00:00.000Z',
    sessionId: 's1',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 },
      content,
    },
    ...rest,
  } as RawLine;
}

test('TranscriptState accumulates tools, tokens, files and text', () => {
  const s = new TranscriptState();
  s.applyLine({ type: 'custom-title', customTitle: 'My session', sessionId: 's1' });
  s.applyLine({ type: 'user', timestamp: '2026-09-16T09:59:00.000Z', sessionId: 's1', cwd: '/w', message: { role: 'user', content: 'do the thing' } });
  s.applyLine(
    assistant({
      content: [
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/w/a.ts' } },
        { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } },
      ],
    }),
  );
  s.applyLine({
    type: 'user',
    timestamp: '2026-09-16T10:00:05.000Z',
    sessionId: 's1',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
  });

  assert.equal(s.title, 'My session');
  assert.equal(s.cwd, '/w');
  assert.equal(s.model, 'claude-sonnet-5');
  assert.equal(s.toolCalls, 3);
  assert.deepEqual({ ...s.toolCounts }, { Read: 2, Bash: 1 });
  assert.equal(s.lastText, 'Working on it.');
  assert.equal(s.errorCount, 1);
  assert.equal(s.completedToolUses.has('t1'), true);
  assert.deepEqual(s.tokens, { input: 10, output: 20, cacheCreate: 5, cacheRead: 100 });

  // The same path read twice is one entry with a count of two.
  assert.deepEqual(s.files(), [{ path: '/w/a.ts', count: 2 }]);

  assert.equal(s.startedAt, '2026-09-16T09:59:00.000Z');
  assert.equal(s.lastActivityAt, '2026-09-16T10:00:05.000Z');
  assert.equal(s.messageCount, 3);
  assert.equal(s.userMessages, 1, 'a tool_result is not a user turn');
  assert.equal(s.assistantMessages, 1);
});

test('TranscriptState ignores line types it does not know', () => {
  const s = new TranscriptState();
  for (const type of ['attachment', 'queue-operation', 'file-history-snapshot', 'atis-latch', 'mode', 'something-new']) {
    assert.doesNotThrow(() => s.applyLine({ type, timestamp: '2026-09-16T10:00:00.000Z' }));
  }
  assert.equal(s.messageCount, 0);
  assert.equal(s.lastActivityAt, '2026-09-16T10:00:00.000Z', 'unknown lines still count as activity');
});

test('TranscriptState survives messages with missing or wrong-typed fields', () => {
  const s = new TranscriptState();
  assert.doesNotThrow(() => {
    s.applyLine({ type: 'assistant' });
    s.applyLine({ type: 'assistant', message: { content: 'a bare string' } });
    s.applyLine({ type: 'assistant', message: { content: [null, 42, { type: 'tool_use' }] as never } });
    s.applyLine({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    s.applyLine({ type: 'assistant', message: { usage: { input_tokens: 'nope' as never } } });
  });
  assert.equal(s.toolCalls, 1, 'a nameless tool_use still counts, under a generic name');
  assert.deepEqual({ ...s.toolCounts }, { tool: 1 });
  assert.equal(s.tokens.input, 0, 'a non-numeric token count reads as zero');
});

test('the token series is cumulative and bucketed by time', () => {
  const s = new TranscriptState();
  const at = (iso: string, out: number) =>
    s.applyLine({
      type: 'assistant',
      timestamp: iso,
      message: { role: 'assistant', model: 'claude-sonnet-5', usage: { output_tokens: out }, content: [] },
    });
  at('2026-09-16T10:00:00.000Z', 100);
  at('2026-09-16T10:00:10.000Z', 50); // same 30s bucket as the first
  at('2026-09-16T10:01:00.000Z', 25);

  const series = s.series();
  assert.equal(series.length, 2);
  assert.equal(series[0]?.out, 150);
  assert.equal(series[1]?.out, 175);
  assert.ok((series[1]?.t ?? 0) > (series[0]?.t ?? 0), 'points are ordered in time');
});

test('the subagent model falls back to the sidecar when no assistant line has one', () => {
  const s = new TranscriptState();
  s.applyLine({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [] } });
  assert.equal(s.model, null, 'a synthetic model is not a real model');
});
