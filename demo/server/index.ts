import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, readIndex, staticFrontend } from './app.ts';
import { loadConfig } from './config.ts';
import type { ViteDevServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.resolve(process.env.DECISION_DEMO_CONFIG ?? path.join(root, 'config.json'));
const config = await loadConfig(configPath);
const port = Number(process.env.PORT ?? config.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535.');
const dev = process.argv.includes('--dev');
let vite: ViteDevServer | undefined;
const production = staticFrontend(path.join(root, 'dist'));
if (!dev) {
  try { await access(path.join(root, 'dist', 'index.html')); }
  catch { throw new Error('Build the UI first with npm run build, or use npm run dev.'); }
}
const app = await createApp({
  configPath,
  runtimeDirectory: path.join(root, '.runtime'),
  frontend: (request, response) => {
    if (!vite) return production(request, response);
    vite.middlewares(request, response, () => {
      void (async () => {
        const html = await vite!.transformIndexHtml(request.url ?? '/', await readIndex(root));
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
      })().catch((error: unknown) => {
        console.error(error);
        if (!response.headersSent) response.writeHead(500);
        response.end('Could not render the development UI. See the server console.');
      });
    });
  },
});

if (dev) {
  const { createServer } = await import('vite');
  vite = await createServer({
    root,
    // Node's native TS loader avoids Vite's generated/deleted config bundle being
    // watched as an imported module by `node --watch` (an endless restart loop).
    configLoader: 'native',
    server: { middlewareMode: true, hmr: { server: app.server } },
    appType: 'custom',
  });
}

app.server.on('error', (error) => { console.error(error); process.exitCode = 1; void shutdown(); });
app.server.listen(port, '127.0.0.1', () => {
  console.log(`\n  Decision Lab → http://127.0.0.1:${port}\n  Config: ${configPath}\n  ${dev ? 'Development' : 'Production'} mode · Ctrl+C to stop\n`);
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // Close HMR WebSockets while the HTTP server drains its connections.
  await Promise.all([app.close(), vite?.close()]);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
