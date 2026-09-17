import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';
import { runStats, parseSince } from './stats.js';
import { ensureFreshFixtures, FIXTURES_DIR } from './fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, '..', '..');

export const DEFAULT_PORT = 4141;
export const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');

export interface ParsedArgs {
  command: 'serve' | 'stats' | 'help' | 'version';
  root: string;
  port: number;
  since: string | null;
  project: string | null;
  activeOnly: boolean;
  limit: number;
  demo: boolean;
  error: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: 'serve',
    root: DEFAULT_ROOT,
    port: DEFAULT_PORT,
    since: null,
    project: null,
    activeOnly: false,
    limit: 50,
    demo: false,
    error: null,
  };

  let i = 0;
  if (argv[0] && !argv[0].startsWith('-')) {
    const cmd = argv[0];
    if (cmd === 'stats') out.command = 'stats';
    else if (cmd === 'serve') out.command = 'serve';
    else if (cmd === 'help') out.command = 'help';
    else {
      out.error = `unknown command: ${cmd}`;
      return out;
    }
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    const next = () => argv[++i];
    switch (arg) {
      case '--dir':
      case '-d': {
        const v = next();
        if (!v) return fail(out, '--dir needs a path');
        out.root = path.resolve(v);
        break;
      }
      case '--port':
      case '-p': {
        const v = next();
        const n = Number(v);
        if (!v || !Number.isInteger(n) || n < 0 || n > 65535) return fail(out, '--port needs a valid port');
        out.port = n;
        break;
      }
      case '--since': {
        const v = next();
        if (!v) return fail(out, '--since needs a duration like 24h');
        if (parseSince(v) === null) return fail(out, `could not read duration: ${v}`);
        out.since = v;
        break;
      }
      case '--project': {
        const v = next();
        if (!v) return fail(out, '--project needs a substring');
        out.project = v;
        break;
      }
      case '--limit': {
        const v = next();
        const n = Number(v);
        if (!v || !Number.isInteger(n) || n < 1) return fail(out, '--limit needs a positive integer');
        out.limit = n;
        break;
      }
      case '--active':
        out.activeOnly = true;
        break;
      case '--demo':
        out.demo = true;
        out.root = path.join(PACKAGE_ROOT, 'fixtures');
        break;
      case '--all':
        out.since = null;
        break;
      case '--help':
      case '-h':
        out.command = 'help';
        return out;
      case '--version':
      case '-v':
        out.command = 'version';
        return out;
      default:
        return fail(out, `unknown option: ${arg}`);
    }
  }
  return out;
}

function fail(out: ParsedArgs, message: string): ParsedArgs {
  out.error = message;
  return out;
}

const HELP = `swarmboard — live dashboard for Claude Code agent swarms

usage
  swarmboard [--dir <path>] [--port <n>]      start the dashboard (default http://localhost:${DEFAULT_PORT})
  swarmboard stats [options]                  print a session table and exit
  swarmboard --demo                           serve the bundled synthetic fixtures

options
  -d, --dir <path>      projects directory to read (default ~/.claude/projects)
  -p, --port <n>        port for the dashboard (default ${DEFAULT_PORT})
      --demo            read the bundled fixtures instead of your real sessions
      --since <dur>     stats: only sessions active within 24h / 90m / 7d
      --all             stats: no time cutoff
      --project <sub>   stats: filter by project name substring
      --active          stats: only sessions written in the last 90s
      --limit <n>       stats: max rows (default 50)
  -h, --help            this text
  -v, --version         print the version

Everything is read from disk and stays on this machine. No network calls.
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`swarmboard: ${args.error}\n\nRun swarmboard --help\n`);
    return 2;
  }
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write('swarmboard 0.1.0\n');
    return 0;
  }
  if (args.command === 'stats') {
    await runStats(
      {
        root: args.root,
        sinceMs: args.since === null ? null : parseSince(args.since),
        project: args.project,
        activeOnly: args.activeOnly,
        limit: args.limit,
      },
      (s) => process.stdout.write(s),
    );
    return 0;
  }

  // Only the bundled fixtures get the demo badge: a user directory that happens to
  // be called `fixtures` holds real transcripts and must not be labelled synthetic.
  const isFixtures = args.demo || args.root === FIXTURES_DIR;
  if (isFixtures) {
    // Demo transcripts carry timestamps relative to now, so a stale checkout would
    // render as a board of idle agents. Regenerate when they have gone cold.
    await ensureFreshFixtures(args.root);
  } else if (!existsSync(args.root)) {
    process.stderr.write(
      `swarmboard: ${args.root} does not exist — the board will stay empty.\n` +
        `            Pass --dir <path> to point at your projects directory.\n\n`,
    );
  }
  const server = await startServer({
    root: args.root,
    port: args.port,
    label: isFixtures ? 'demo fixtures' : null,
  });
  const snap = server.store.snapshot();
  process.stdout.write(
    `\n  swarmboard  ${server.url}\n` +
      `  reading     ${args.root}${isFixtures ? '  (synthetic demo data)' : ''}\n` +
      `  found       ${snap.totals.sessions} sessions · ${snap.totals.subagents} subagents · ${snap.totals.active} active\n\n` +
      `  Live updates stream over SSE. Ctrl-C to stop.\n\n`,
  );

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.stdout.write('\nstopping swarmboard\n');
      void server.close().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`swarmboard: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
