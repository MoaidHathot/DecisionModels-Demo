import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { loadConfig } from '../server/config.ts';
import { RunManager } from '../server/runs.ts';
import { fixtureCommand, workspace } from './helpers.ts';

test('batch streams progress, snapshots inputs, and counts each invocation once', async (t) => {
  const { configPath, inputPath, runtime } = await workspace(t, [{}, { command: fixtureCommand('--style laya') }]);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  const run = await manager.start({ entryIds: ['entry-0', 'entry-1'], requestIds: ['ticket.json'], repetitions: 2, concurrency: 1 });
  let updates = 0;
  let maxRunning = 0;
  manager.subscribe(run.id, ({ run: snapshot }) => {
    updates++;
    maxRunning = Math.max(maxRunning, snapshot.tasks.filter((task) => task.status === 'running').length);
  });
  await writeFile(inputPath, '{"state":"Changed after launch","questions":{}}');
  const done = await manager.wait(run.id);
  assert.equal(done.tasks.length, 4);
  assert.ok(done.tasks.every((task) => task.status === 'success'), JSON.stringify(done.tasks));
  assert.equal(maxRunning, 1);
  assert.ok(updates >= 4);
  assert.match(String(manager.detail(run.id, done.tasks[0]!.id).request.state), /Original request/);
  assert.match(manager.detail(run.id, done.tasks[0]!.id).output!.stdout, /Original request/);
  assert.deepEqual(await readdir(runtime), []);
  assert.equal(manager.state().active, null);
  assert.equal(manager.export(run.id).results.length, 4);
});

test('one entry failing does not prevent other entries from completing', async (t) => {
  const { configPath, runtime } = await workspace(t, [{ command: fixtureCommand('--fail') }, { command: fixtureCommand('--bad-json') }, {}]);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  const run = await manager.start({ entryIds: ['entry-0', 'entry-1', 'entry-2'], requestIds: ['ticket.json'], concurrency: 2 });
  const done = await manager.wait(run.id);
  assert.deepEqual(done.tasks.map((task) => task.status), ['error', 'error', 'success']);
  assert.match(done.tasks[0]!.error!, /code 7/);
  assert.match(done.tasks[1]!.error!, /No JSON/);
  assert.ok(manager.detail(run.id, done.tasks[1]!.id).output!.stdout);
});

test('warm-up uses one request and stays out of comparison results', async (t) => {
  const { configPath, runtime, raw } = await workspace(t);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  const run = await manager.start({ kind: 'warmup', entryIds: ['entry-0'], requestIds: ['ticket.json'], repetitions: 5 });
  const done = await manager.wait(run.id);
  assert.equal(done.tasks.length, 1);
  assert.equal(done.tasks[0]?.status, 'success');
  assert.equal(manager.state().latestComparison, null);
  assert.equal(manager.state().warmups['entry-0']?.status, 'success');
  raw.entries[0]!.command = fixtureCommand('--style laya');
  await writeFile(configPath, JSON.stringify(raw));
  assert.equal(manager.state(await loadConfig(configPath)).warmups['entry-0'], undefined, 'Changing an invocation must invalidate its old warm-up badge.');
});

test('simultaneous launches are rejected and cancellation clears queued work and temporary inputs', async (t) => {
  const { configPath, runtime } = await workspace(t, [{ command: fixtureCommand('--hang') }, {}]);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  const input = { entryIds: ['entry-0', 'entry-1'], requestIds: ['ticket.json'], repetitions: 3 };
  const first = manager.start(input);
  await assert.rejects(manager.start(input), /already active/);
  const run = await first;
  manager.cancel(run.id);
  const done = await manager.wait(run.id);
  assert.equal(done.status, 'cancelled');
  assert.ok(done.tasks.every((task) => task.status === 'cancelled'));
  assert.deepEqual(await readdir(runtime), []);
});

test('unknown selections, malformed pasted JSON and oversized batches fail before starting a command', async (t) => {
  const { configPath, runtime } = await workspace(t);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  await assert.rejects(manager.start({ entryIds: ['unknown'], requestIds: ['ticket.json'] }), /Unknown entry/);
  await assert.rejects(manager.start({ entryIds: ['entry-0'], customJson: '{' }), /Invalid request JSON/);
  await assert.rejects(manager.start({ entryIds: ['entry-0'], requestIds: ['../config.json'] }), /Unknown request/);
  await assert.rejects(manager.start({ entryIds: ['entry-0'], requestIds: ['ticket.json'], customJson: '{}' }), /not both/);
  await assert.rejects(manager.start({ entryIds: ['entry-0'], requestIds: ['ticket.json'], concurrency: 99 }), /concurrency/);
  assert.equal(manager.state().active, null);
});

test('race launches a whole request together, streams finish positions, and waits before the next repetition', async (t) => {
  const { configPath, runtime } = await workspace(t, [
    { command: fixtureCommand('--delay 1500') },
    { command: fixtureCommand('--delay 30') },
    { command: fixtureCommand('--delay 50 --fail') },
  ]);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  const started = await manager.start({ execution: 'race', entryIds: ['entry-0', 'entry-1', 'entry-2'], requestIds: ['ticket.json'], repetitions: 2 });
  assert.equal(started.concurrency, 3);
  assert.deepEqual(started.tasks.map((task) => task.status), ['running', 'running', 'running', 'queued', 'queued', 'queued']);
  let firstPlaceArrivedWhileOthersRan = false;
  manager.subscribe(started.id, ({ run }) => {
    if (run.tasks[1]?.finishOrder === 1 && run.tasks[0]?.status === 'running') firstPlaceArrivedWhileOthersRan = true;
  });
  const done = await manager.wait(started.id);
  assert.equal(firstPlaceArrivedWhileOthersRan, true);
  assert.deepEqual(done.tasks.map((task) => task.finishOrder), [2, 1, null, 2, 1, null]);
  assert.deepEqual(done.tasks.map((task) => task.status), ['success', 'success', 'error', 'success', 'success', 'error']);
  const firstFinished = Math.max(...done.tasks.slice(0, 3).map((task) => Date.parse(task.finishedAt!)));
  assert.ok(done.tasks.slice(3).every((task) => Date.parse(task.startedAt!) >= firstFinished));
  assert.deepEqual(await readdir(runtime), []);
});

test('race cancellation stops every active contender and clears later requests', async (t) => {
  const { configPath, runtime } = await workspace(t, [{ command: fixtureCommand('--hang') }, { command: fixtureCommand('--hang') }]);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  const started = await manager.start({ execution: 'race', entryIds: ['entry-0', 'entry-1'], requestIds: ['ticket.json'], repetitions: 3 });
  assert.equal(started.tasks.filter((task) => task.status === 'running').length, 2);
  manager.cancel(started.id);
  const done = await manager.wait(started.id);
  assert.equal(done.status, 'cancelled');
  assert.ok(done.tasks.every((task) => task.status === 'cancelled' && task.finishOrder === null));
  assert.deepEqual(await readdir(runtime), []);
});

test('a race rejects insufficient concurrency instead of silently staggering contenders', async (t) => {
  const { configPath, runtime, raw } = await workspace(t, [{}, {}]);
  raw.maxConcurrency = 1;
  await writeFile(configPath, JSON.stringify(raw));
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  await assert.rejects(manager.start({ execution: 'race', entryIds: ['entry-0', 'entry-1'], requestIds: ['ticket.json'] }), /starts all selected entries together/);
  assert.equal(manager.state().active, null);
});
