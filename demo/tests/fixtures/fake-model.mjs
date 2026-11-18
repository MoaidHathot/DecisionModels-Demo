// Deterministic CLI for transport/lifecycle tests only. Never used by demo/config.json.
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const request = JSON.parse(await readFile(option('--file'), 'utf8'));
if (args.includes('--spawn-child')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await writeFile(option('--pid-file'), String(child.pid));
}
console.error('Fixture ready · مرحبا');
if (args.includes('--overflow')) {
  process.stdout.write('x'.repeat(2 * 1024 * 1024));
  await setTimeout(10000);
}
if (args.includes('--hang')) await setTimeout(60000);
await setTimeout(Number(option('--delay', '30')));
if (args.includes('--bad-json')) {
  console.log('The model said something that is not JSON.');
  process.exit(0);
}
const local = option('--style', 'copilot') === 'laya';
const llm = option('--style', 'copilot') === 'llm';
const answers = Object.fromEntries(Object.entries(request.questions ?? { team: { type: 'choice', choices: { billing: 'Billing', support: 'Support' } } }).map(([id, q]) => {
  if (q.type === 'predicate' || q.type === 'noul' || q.type === 'boolean') return [id, local ? { type: 'noul', noul: 0.12 } : { type: 'predicate', probability: 0.12 }];
  if (q.type === 'score') {
    const levels = q.levels ?? q.criteria;
    const probabilities = levels.map((_, index) => index === 0 ? 0.2 : index === 1 ? levels.length === 2 ? 0.8 : 0.7 : 0.1 / (levels.length - 2));
    const score = probabilities.reduce((sum, p, index) => sum + p * index, 0);
    return [id, { type: 'score', score, levels, probabilities }];
  }
  const choices = q.choices ?? q.criteria ?? { billing: 'Billing', support: 'Support' };
  const labels = Array.isArray(choices) ? choices : Object.keys(choices);
  return [id, { type: 'choice', choice: labels[0], probabilities: Object.fromEntries(labels.map((label, index) => [label, index === 0 ? 0.96 : 0.04 / (labels.length - 1)])), confidence: 0.68 }];
}));
console.log('fixture {not JSON} · transport banner');
console.log(JSON.stringify({
  state: request.state,
  answers,
  ...(llm ? { provider: 'copilot-llm', model: 'fixture-llm', reasoningEffort: 'low', elapsedMilliseconds: 70.5 }
    : local ? { routing: { model: 'fixture-multilingual', device: 'cpu', ms: 14.2, exec: { mode: 'torch-eager' } }, backend: 'remote' }
    : { provider: 'copilot', model: 'fixture-decision-1', elapsedMilliseconds: 54.8, transport: 'sdk' }),
}));
if (args.includes('--fail')) {
  console.error('Simulated CLI failure after output');
  process.exit(7);
}
