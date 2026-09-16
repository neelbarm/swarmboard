import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SwarmStore } from './store.js';
import type { Snapshot } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/src/server.js -> package root -> public/ */
const PUBLIC_DIR = path.resolve(here, '..', '..', 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  root: string;
  port: number;
  host?: string;
  /** Shown in the header so the demo is never mistaken for live data. */
  label?: string | null;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
  store: SwarmStore;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  const store = new SwarmStore({ root: opts.root });
  await store.start();

  const clients = new Set<http.ServerResponse>();
  let latest: Snapshot = store.snapshot();

  store.on('change', (snap: Snapshot) => {
    latest = snap;
    broadcast(clients, 'snapshot', snap);
  });
  store.on('warn', () => {
    /* transient fs errors are expected while agents write; the next pass recovers */
  });

  // Status flips to idle purely from the passage of time, so push on a slow tick too.
  const heartbeat = setInterval(() => {
    latest = store.snapshot();
    broadcast(clients, 'snapshot', latest);
  }, 15_000);
  heartbeat.unref?.();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/api/snapshot') {
      latest = store.snapshot();
      return sendJSON(res, 200, { ...latest, label: opts.label ?? null });
    }
    if (pathname === '/api/health') {
      return sendJSON(res, 200, {
        ok: true,
        root: store.root,
        agents: latest.agents.length,
        clients: clients.size,
      });
    }
    if (pathname === '/api/agent') {
      const id = url.searchParams.get('id');
      latest = store.snapshot();
      const agent = latest.agents.find((a) => a.id === id);
      if (!agent) return sendJSON(res, 404, { error: 'no such agent' });
      return sendJSON(res, 200, agent);
    }
    if (pathname === '/api/stream') {
      return openStream(req, res, clients, store, opts.label ?? null);
    }
    return serveStatic(pathname, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;

  return {
    url: `http://localhost:${port}`,
    port,
    store,
    async close() {
      clearInterval(heartbeat);
      for (const c of clients) c.end();
      clients.clear();
      store.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function openStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clients: Set<http.ServerResponse>,
  store: SwarmStore,
  label: string | null,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': swarmboard stream open\n\n');
  clients.add(res);
  writeEvent(res, 'snapshot', { ...store.snapshot(), label });

  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20_000);
  ping.unref?.();

  const cleanup = () => {
    clearInterval(ping);
    clients.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

function broadcast(clients: Set<http.ServerResponse>, event: string, data: unknown): void {
  if (clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (res.writableEnded) {
      clients.delete(res);
      continue;
    }
    res.write(payload);
  }
}

function writeEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fsp
    .stat(target)
    .then((stat) => {
      if (!stat.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(target).pipe(res);
    })
    .catch(() => {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
    });
}
