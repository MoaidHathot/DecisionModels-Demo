import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.ts';
import { RunManager } from '../server/runs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.resolve(process.env.DECISION_DEMO_CONFIG ?? path.join(root, 'config.json'));
const config = await loadConfig(configPath);
const manager = new RunManager(() => loadConfig(configPath), path.join(root, '.runtime'));
const requestIds = ['02-refund-triage.json'];
const artifactDirectory = path.join(root, '.artifacts');

try {
  const warmable = config.entries.filter((entry) => entry.warmupCommand).map((entry) => entry.id);
  if (warmable.length) {
    console.log(`Warming ${warmable.length} real invocation preset(s)…`);
    const warmup = await manager.start({ kind: 'warmup', entryIds: warmable, requestIds, concurrency: 1 });
    const done = await manager.wait(warmup.id);
    for (const task of done.tasks) {
      console.log(`${task.entryName}: ${task.status} · ${task.wallMs?.toFixed(1)} ms`);
      assert.equal(task.status, 'success', JSON.stringify(manager.detail(done.id, task.id), null, 2));
    }
  }
  console.log('Racing the real configured entries in parallel…');
  const run = await manager.start({ entryIds: config.entries.map((entry) => entry.id), requestIds, execution: 'race', repetitions: 1 });
  const done = await manager.wait(run.id);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path.join(artifactDirectory, 'live-smoke.json'), `${JSON.stringify(manager.export(run.id), null, 2)}\n`);
  for (const task of done.tasks) {
    console.log(`#${task.finishOrder} ${task.entryName}: ${task.status} · ${task.result?.model ?? 'no model'} · wall ${task.wallMs?.toFixed(1)} ms · reported ${task.result?.reportedMs?.toFixed(1)} ms`);
    assert.equal(task.status, 'success', JSON.stringify(manager.detail(done.id, task.id), null, 2));
    assert.equal(task.result?.decisions.length, 3);
    assert.ok(task.result?.model);
    assert.ok(task.wallMs! > 0);
    assert.equal(task.result?.decisions.find((decision) => decision.question === 'team')?.probabilityLabel, task.result?.probabilitySource === 'llm-estimate' ? 'Est. P(choice)' : 'P(choice)');
    assert.ok(task.finishOrder! > 0);
  }
  console.log(`Evidence saved to ${path.join(artifactDirectory, 'live-smoke.json')}`);
} finally {
  await manager.close();
}
