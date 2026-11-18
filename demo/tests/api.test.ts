import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../server/app.ts';
import { fixtureCommand, workspace } from './helpers.ts';
import type { RunSnapshot } from '../shared/types.ts';

function send(port: number, method: string, url: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: url, method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('HTTP API validates inputs, restricts origins, streams a complete run, and exposes raw diagnostics', async (t) => {
  const { configPath, runtime } = await workspace(t, [{ command: fixtureCommand('--delay 200') }]);
  const app = await createApp({ configPath, runtimeDirectory: runtime });
  t.after(() => app.close());
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  assert.equal((await send(port, 'GET', '/api/catalog')).status, 200);
  assert.equal((await send(port, 'GET', '/api/request?id=..%2Fconfig.json')).status, 404);
  assert.equal((await send(port, 'POST', '/api/runs', '{}', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await send(port, 'GET', '/api/catalog', undefined, { Host: 'untrusted.example' })).status, 403);
  assert.equal((await send(port, 'POST', '/api/runs', '{')).status, 400);
  assert.equal((await send(port, 'POST', '/api/runs', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send(port, 'POST', '/api/runs', JSON.stringify({ customJson: 'x'.repeat(2 * 1024 * 1024) }))).status, 413);

  const started = await send(port, 'POST', '/api/runs', JSON.stringify({ entryIds: ['entry-0'], requestIds: ['ticket.json'], repetitions: 2 }));
  assert.equal(started.status, 202);
  const run = JSON.parse(started.text) as RunSnapshot;
  assert.equal((await send(port, 'POST', '/api/runs', JSON.stringify({ entryIds: ['entry-0'], requestIds: ['ticket.json'] }))).status, 409);
  const stream = await send(port, 'GET', `/api/runs/${run.id}/events`);
  assert.equal(stream.status, 200);
  const snapshots = stream.text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)) as { run: RunSnapshot });
  assert.ok(snapshots.some((event) => event.run.tasks.some((task) => task.status === 'running')));
  assert.equal(snapshots.at(-1)?.run.status, 'completed');
  assert.ok(snapshots.at(-1)?.run.tasks.every((task) => task.status === 'success'));
  const detail = await send(port, 'GET', `/api/runs/${run.id}/tasks/${run.tasks[0]!.id}`);
  assert.match(detail.text, /Fixture ready/);
  assert.match(detail.text, /Original request/);
  assert.equal(JSON.parse((await send(port, 'GET', `/api/runs/${run.id}/export`)).text).results.length, 2);
  assert.equal((await send(port, 'GET', '/api/runs/missing')).status, 404);
});
