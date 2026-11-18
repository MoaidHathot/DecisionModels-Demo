import assert from 'node:assert/strict';
import test from 'node:test';
import { answerAgreement, entryMetrics, median } from '../shared/metrics.ts';
import type { RunSnapshot, TaskSnapshot } from '../shared/types.ts';

const task = (entryId: string, wallMs: number, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: `${entryId}-${wallMs}`, entryId, entryName: entryId, configuredMode: 'test', requestId: 'ticket', requestName: 'Ticket', repetition: 1,
  status: 'success', wallMs, startedAt: null, finishedAt: null, error: null, progress: null, finishOrder: null,
  result: { provider: 'Test', model: 'same-underlying-model', mode: null, device: null, execution: null, reportedMs: 10, reportedLabel: 'Test clock', warnings: [], decisions: [
    { question: 'team', type: 'choice', value: 'billing', label: 'billing', detail: null, probability: 0.9, probabilityLabel: 'P(choice)', distribution: null },
    { question: 'refund', type: 'predicate', value: false, label: 'No', detail: null, probability: 0.1, probabilityLabel: 'P(yes)', distribution: null },
  ] }, ...overrides,
});
const run = (tasks: TaskSnapshot[], overrides: Partial<RunSnapshot> = {}): RunSnapshot => ({ id: 'run', kind: 'comparison', status: 'completed', createdAt: '', finishedAt: '', concurrency: 1, execution: 'sequential', repetitions: 1, tasks, error: null, ...overrides });

test('latency aggregates invocations once, keeps same-model variants separate, and excludes failures', () => {
  const stats = entryMetrics(run([task('sidecar', 10), task('sidecar', 30), task('sidecar', 900, { status: 'error' }), task('local', 100)]));
  assert.equal(stats.length, 2);
  assert.equal(stats[0]?.medianWallMs, 20);
  assert.equal(stats[0]?.successes, 2);
  assert.equal(stats[0]?.failures, 1);
  assert.equal(stats[1]?.medianWallMs, 100);
  assert.equal(median([]), null);
  assert.equal(median([0, 0, 5]), 0);
  assert.deepEqual(entryMetrics(run([task('sidecar', 10)], { kind: 'warmup' })), []);
});

test('agreement only includes complete paired questions; repetitions never compare to each other', () => {
  const first = task('a', 100);
  const second = task('b', 200);
  second.result!.decisions[0]!.value = 'support';
  const comparison = run([first, second, task('a', 120, { repetition: 2 }), task('b', 220, { repetition: 2, status: 'error' })]);
  assert.deepEqual(answerAgreement(comparison), { agreeing: 1, comparable: 2, rate: 0.5 });
  assert.equal(answerAgreement(run([first])).rate, null);
  assert.equal(answerAgreement(run([first, second], { kind: 'warmup' })).rate, null);
});
