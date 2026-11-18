import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { isRunActive } from '../shared/types.ts';
import { AppError, loadCatalog, loadConfig, readRequest } from './config.ts';
import { RunManager } from './runs.ts';

type Frontend = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

async function bodyJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new AppError('Use Content-Type: application/json.', 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let tooLarge = false;
  // JSON text is itself encoded in the API body, so allow room for escaped characters.
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 2 * 1024 * 1024) { tooLarge = true; continue; }
    chunks.push(Buffer.from(chunk));
  }
  if (tooLarge) throw new AppError('Request body is too large (maximum 2 MiB).', 413);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AppError('Invalid JSON request body.'); }
}

function sameOrigin(request: IncomingMessage) {
  const host = request.headers.host;
  if (!host) throw new AppError('Host header required.', 403);
  let hostname: string;
  try { hostname = new URL(`http://${host}`).hostname; }
  catch { throw new AppError('Invalid Host header.', 403); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new AppError('This app only accepts loopback requests.', 403);
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) throw new AppError('Cross-origin requests are not allowed.', 403);
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Cross-site requests are not allowed.', 403);
}

export async function createApp(options: { configPath: string; runtimeDirectory: string; frontend?: Frontend }) {
  const getConfig = () => loadConfig(options.configPath);
  await getConfig();
  const manager = new RunManager(getConfig, options.runtimeDirectory);
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof AppError ? error.status : 500;
      json(response, status, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    sameOrigin(request);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;
    const method = request.method;
    if (method === 'GET' && route === '/api/catalog') {
      json(response, 200, await loadCatalog(await getConfig()));
    } else if (method === 'GET' && route === '/api/request') {
      const id = url.searchParams.get('id');
      if (!id) throw new AppError('A request id is required.');
      const config = await getConfig();
      const catalog = await loadCatalog(config);
      if (!catalog.requests.some((sample) => sample.id === id)) throw new AppError('Request not found.', 404);
      json(response, 200, await readRequest(config, id));
    } else if (method === 'GET' && route === '/api/runs') {
      json(response, 200, manager.state(await getConfig()));
    } else if (method === 'POST' && route === '/api/runs') {
      json(response, 202, await manager.start(await bodyJson(request)));
    } else if (route.startsWith('/api/runs/')) {
      const [, , , id, action, taskId] = route.split('/');
      if (!id) throw new AppError('Run not found.', 404);
      if (method === 'GET' && action === 'events') {
        const run = manager.get(id);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write('retry: 1500\n\n');
        const send = (data: unknown) => response.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
        send({ run, warmups: manager.state().warmups });
        if (!isRunActive(run)) { response.end(); return; }
        const unsubscribe = manager.subscribe(id, (event) => {
          send(event);
          if (!isRunActive(event.run)) response.end();
        });
        const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
        heartbeat.unref();
        response.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
      } else if (method === 'POST' && action === 'cancel') {
        await bodyJson(request);
        json(response, 200, manager.cancel(id));
      } else if (method === 'GET' && action === 'export') {
        response.setHeader('Content-Disposition', `attachment; filename="decision-lab-${manager.get(id).id}.json"`);
        json(response, 200, manager.export(id));
      } else if (method === 'GET' && action === 'tasks' && taskId) {
        json(response, 200, manager.detail(id, taskId));
      } else if (method === 'GET' && !action) {
        json(response, 200, manager.get(id));
      } else throw new AppError('Endpoint not found.', 404);
    } else if (route.startsWith('/api/')) {
      throw new AppError('Endpoint not found.', 404);
    } else if (options.frontend && (method === 'GET' || method === 'HEAD')) {
      await options.frontend(request, response);
    } else throw new AppError('Not found.', 404);
  }

  return {
    server, manager,
    async close() {
      await manager.close();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export function staticFrontend(directory: string): Frontend {
  const root = path.resolve(directory);
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };
  return async (request, response) => {
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname); }
    catch { throw new AppError('Invalid URL.', 400); }
    let file = path.resolve(root, `.${pathname}`);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || pathname.includes('\0')) throw new AppError('Not found.', 404);
    try {
      if (!(await stat(file)).isFile()) file = path.join(root, 'index.html');
    } catch {
      if (path.extname(pathname)) throw new AppError('Not found.', 404);
      file = path.join(root, 'index.html');
    }
    const info = await stat(file);
    response.writeHead(200, {
      'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': path.basename(file) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  };
}

export async function readIndex(directory: string): Promise<string> {
  return readFile(path.join(directory, 'index.html'), 'utf8');
}
