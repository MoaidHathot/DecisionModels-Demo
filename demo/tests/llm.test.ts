import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../server/config.ts';
import { copilotRuntimePath, llmResponseSchema, llmSessionConfig } from '../server/llm.ts';
import { normalizeResponse } from '../server/parsers.ts';
import { RunManager } from '../server/runs.ts';
import type { LlmSettings } from '../shared/types.ts';
import { workspace } from './helpers.ts';

const request = JSON.parse(await readFile(new URL('../requests/02-refund-triage.json', import.meta.url), 'utf8'));
const captured = await readFile(new URL('./fixtures/llm-response.json', import.meta.url), 'utf8');
const settings: LlmSettings = { provider: 'copilot', model: 'gpt-6-luna', reasoningEffort: 'low', systemPrompt: 'Use only the supplied evidence. Return the requested schema.' };

test('captured LLM output preserves actual model/effort and labels estimates honestly', () => {
  const result = normalizeResponse(captured, 'auto', request);
  assert.equal(result.provider, 'Copilot LLM');
  assert.equal(result.model, 'gpt-6-luna');
  assert.equal(result.reasoningEffort, 'low');
  assert.equal(result.reportedMs, 5858.2209);
  assert.equal(result.probabilitySource, 'llm-estimate');
  assert.equal(result.decisions[0]?.probabilityLabel, 'Est. P(yes)');
  assert.equal(result.decisions[1]?.probability, 0.98);
  assert.equal(result.decisions[2]?.label, 'Medium');
  // The actual probe's score disagreed with its own distribution. Preserve it,
  // and make the discrepancy visible rather than silently correcting the LLM.
  assert.equal(result.decisions[2]?.value, 1.4);
  assert.match(result.warnings[0]!, /1\.40.*1\.00/);
});

test('LLM normalization rejects unknown choices, partial distributions and extra questions', () => {
  const wrongChoice = JSON.parse(captured);
  wrongChoice.answers.team.choice = 'sales';
  assert.throws(() => normalizeResponse(JSON.stringify(wrongChoice), 'llm', request), /unknown choice/);
  const partial = JSON.parse(captured);
  delete partial.answers.team.probabilities.support;
  assert.throws(() => normalizeResponse(JSON.stringify(partial), 'llm', request), /incomplete choice/);
  const badSum = JSON.parse(captured);
  badSum.answers.team.probabilities.billing = 0.8;
  assert.throws(() => normalizeResponse(JSON.stringify(badSum), 'llm', request), /sum to 1/);
  const extra = JSON.parse(captured);
  extra.answers.extra = { type: 'predicate', probability: 0.8 };
  assert.throws(() => normalizeResponse(JSON.stringify(extra), 'llm', request), /not requested/);
});

test('LLM requests retain named questions and support common aliases without changing evidence', () => {
  const input = {
    state: 'Original evidence',
    questions: {
      yes: { type: 'noul', instructions: 'Is this true?' },
      route: { type: 'choice', instructions: 'Choose.', criteria: ['one', 'two'] },
      rating: { type: 'score', instructions: 'Rate.', criteria: ['low', 'high'] },
    },
  };
  const before = JSON.stringify(input);
  const schema = llmResponseSchema(input);
  const text = JSON.stringify(schema);
  assert.match(text, /"required":\["yes","route","rating"\]/);
  assert.match(text, /"enum":\["one","two"\]/);
  assert.match(text, /"minItems":2,"maxItems":2/);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => llmResponseSchema({ text: 'test', preset: 'triage' }), /explicit named questions/);
  assert.throws(() => llmResponseSchema({ state: '', questions: { x: { type: 'choice', instructions: 'Pick', choices: ['same', 'same'] } } }), /unique choices/);
});

test('LLM configuration becomes a real replacement system message and explicit model/effort', async (t) => {
  const { config, configPath, raw } = await workspace(t, [
    { kind: 'llm', llm: settings },
    { kind: 'llm', llm: { ...settings, reasoningEffort: 'high', systemPrompt: 'An independent prompt.' } },
  ]);
  assert.equal(config.entries[0]?.kind, 'llm');
  assert.equal(config.entries[0]?.parser, 'llm');
  assert.notDeepEqual(config.entries[0]?.llm, config.entries[1]?.llm);
  const session = llmSessionConfig(config.entries[0]!.llm!);
  assert.deepEqual(session.systemMessage, { mode: 'replace', content: settings.systemPrompt });
  assert.equal(session.model, settings.model);
  assert.equal(session.reasoningEffort, 'low');
  assert.deepEqual(session.availableTools, []);
  assert.equal(session.skipCustomInstructions, true);
  raw.entries[0]!.command = 'tool --file {input}';
  await writeFile(configPath, JSON.stringify(raw));
  await assert.rejects(loadConfig(configPath), /LLM entries use llm settings/);
  delete raw.entries[0]!.command;
  raw.entries[0]!.llm = { ...settings, systemPrompt: '' };
  await writeFile(configPath, JSON.stringify(raw));
  await assert.rejects(loadConfig(configPath), /systemPrompt/);
});

test('native LLM entry snapshots settings in files and fails invalid questions before contacting a model', async (t) => {
  const prompt = "Literal prompt with an apostrophe ' and $(throw 'must stay data').";
  const { configPath, runtime, raw } = await workspace(t, [{ kind: 'llm', llm: { ...settings, systemPrompt: prompt } }]);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  const run = await manager.start({ execution: 'race', entryIds: ['entry-0'], customJson: JSON.stringify({ state: 'test', questions: { unsupported: { type: 'unknown', instructions: 'test' } } }) });
  raw.entries[0]!.llm = { ...settings, model: 'changed-after-start' };
  await writeFile(configPath, JSON.stringify(raw));
  const done = await manager.wait(run.id);
  assert.equal(done.tasks[0]?.status, 'error');
  const detail = manager.detail(run.id, done.tasks[0]!.id);
  assert.match(detail.output!.stderr, /Unsupported LLM question type/);
  assert.equal(detail.llm?.systemPrompt, prompt);
  assert.equal(detail.llm?.model, settings.model);
  assert.ok(!detail.command.includes(prompt));
  assert.match(detail.command, /copilot-llm\.ts.*--input.*--settings/);
  assert.deepEqual(await readdir(runtime), []);
});

test('runtime resolution accepts a readable JS entry and rejects unsupported shell shims', async (t) => {
  const { directory } = await workspace(t);
  const file = path.join(directory, 'copilot entry.js');
  await writeFile(file, '// not executed');
  assert.equal(await copilotRuntimePath(file), file);
  await assert.rejects(copilotRuntimePath(path.join(directory, 'missing.exe')), /not found/);
  await assert.rejects(copilotRuntimePath('copilot.cmd'), /shell shim/);
});

test('LLM presets whose IDs differ only by case keep separate settings on Windows', async (t) => {
  const { configPath, runtime } = await workspace(t, [
    { id: 'variant', kind: 'llm', llm: { ...settings, systemPrompt: 'First independent prompt' } },
    { id: 'Variant', kind: 'llm', llm: { ...settings, systemPrompt: 'Second independent prompt' } },
  ]);
  const manager = new RunManager(() => loadConfig(configPath), runtime);
  t.after(() => manager.close());
  const run = await manager.start({ execution: 'race', entryIds: ['variant', 'Variant'], customJson: '{"state":"test","questions":{"bad":{"type":"unsupported","instructions":"test"}}}' });
  const directory = path.join(runtime, (await readdir(runtime))[0]!);
  const files = (await readdir(directory)).filter((file) => file.startsWith('llm-'));
  assert.equal(files.length, 2);
  const prompts = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), 'utf8')).llm.systemPrompt));
  assert.deepEqual(prompts.sort(), ['First independent prompt', 'Second independent prompt']);
  const done = await manager.wait(run.id);
  assert.ok(done.tasks.every((task) => task.status === 'error')); // Invalid question: no model calls.
  assert.deepEqual(await readdir(runtime), []);
});
