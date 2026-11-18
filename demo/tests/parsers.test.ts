import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { extractResponse, normalizeResponse } from '../server/parsers.ts';

const copilot = await readFile(new URL('./fixtures/copilot-response.json', import.meta.url), 'utf8');
const laya = await readFile(new URL('./fixtures/locallaya-response.json', import.meta.url), 'utf8');

test('captured Copilot response uses selected-option probabilities, not entropy confidence', () => {
  const result = normalizeResponse(copilot);
  assert.equal(result.model, 'microsoft-decision-1.1');
  assert.equal(result.reportedMs, 5397.0772);
  assert.equal(result.decisions[0]?.probabilityLabel, 'P(yes)');
  assert.equal(result.decisions[1]?.label, 'billing');
  assert.equal(result.decisions[1]?.probability, 0.999336853733245);
  assert.equal(result.decisions[2]?.label, 'Medium');
  assert.equal(result.decisions[2]?.value, 1.3242391218983576);
  assert.equal(result.decisions[2]?.probability, 0.5415369461629319);
});

test('captured LocalLaya response normalizes noul, legends, actual backend and inference time', () => {
  const result = normalizeResponse(laya);
  assert.equal(result.model, 'multilingual');
  assert.equal(result.mode, 'sidecar');
  assert.equal(result.execution, 'torch-accelerated');
  assert.equal(result.reportedMs, 552.4377000000004);
  assert.equal(result.decisions[0]?.probability, 0.9908);
  assert.equal(result.decisions[1]?.probability, 1);
  assert.equal(result.decisions[2]?.label, 'High');
  assert.equal(result.decisions[2]?.probability, 0.7863);
  assert.equal(result.decisions[2]?.distribution?.High, 0.7863);
});

test('JSON extraction tolerates profile chatter, ANSI, BOM, braces in strings and a later response', () => {
  const raw = `\uFEFF\u001b[33mprofile {not JSON}\u001b[0m\n${copilot}\n${laya}\nfinished`;
  assert.equal(extractResponse(raw).backend, 'remote');
  const request = '{"answers":{"x":{"type":"predicate","probability":0.4}},"state":"{ \\\"quoted\\\" }"}';
  assert.equal(extractResponse(`profile { broken\n${request}`).state, '{ "quoted" }');
  assert.equal(extractResponse(`${'{'.repeat(20000)}\n${laya}`).backend, 'remote');
});

test('negative predicates display P(yes), retaining zero rather than turning it into missing data', () => {
  for (const p of [0, 0.1, 0.5, 1]) {
    const result = normalizeResponse(JSON.stringify({ answers: { x: { type: 'noul', noul: p } }, routing: { ms: 0 }, backend: 'local' }));
    assert.equal(result.decisions[0]?.probability, p);
    assert.equal(result.decisions[0]?.label, p >= 0.5 ? 'Yes' : 'No');
    assert.equal(result.decisions[0]?.probabilityLabel, 'P(yes)');
    assert.equal(result.reportedMs, 0);
    assert.equal(result.mode, 'local');
    assert.equal(result.model, null);
  }
});

test('score top level is selected by probability, not by rounding the expected score', () => {
  const result = normalizeResponse(JSON.stringify({ answers: { severity: { type: 'score', score: 0.9, probabilities: [0.5, 0.1, 0.4] } } }), 'copilot', {
    questions: { severity: { levels: ['Low', 'Medium', 'High'] } },
  });
  assert.equal(result.decisions[0]?.label, 'Low');
  assert.equal(result.decisions[0]?.value, 0.9);
  assert.equal(result.decisions[0]?.probability, 0.5);
});

test('missing distributions never masquerade as confidence-derived probabilities', () => {
  const result = normalizeResponse(JSON.stringify({ answers: { team: { type: 'choice', choice: 'billing', confidence: 0.99 } } }));
  assert.equal(result.decisions[0]?.probability, null);
});

test('refusals and truncated inputs remain visible', () => {
  const result = normalizeResponse(JSON.stringify({ answers: { x: { type: 'refused', reason: 'Unsupported question' } }, usage: { truncated: true } }));
  assert.equal(result.decisions[0]?.label, 'Refused');
  assert.equal(result.decisions[0]?.probability, null);
  assert.equal(result.warnings.length, 2);
});

test('malformed, incomplete and unsupported responses fail explicitly', () => {
  for (const output of ['not json', '{"answers":{}}', '{"answers":{"x":{"type":"predicate","probability":2}}}', '{"answers":{"x":{"type":"magic"}}}']) {
    assert.throws(() => normalizeResponse(output));
  }
  assert.throws(() => normalizeResponse(copilot, 'copilot', { questions: { missing: {} } }), /missing answers/);
});
