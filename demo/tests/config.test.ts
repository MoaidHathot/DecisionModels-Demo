import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadCatalog, loadConfig, parseRequest, readRequest, validateTemplate } from '../server/config.ts';
import { workspace } from './helpers.ts';

test('configuration allows independent named variants of the same model', async (t) => {
  const { config } = await workspace(t, [{ name: 'Same model · one' }, { name: 'Same model · two' }]);
  assert.equal(config.entries.length, 2);
  assert.equal(config.entries[0]?.parser, 'auto');
  assert.equal(config.entries[0]?.loadProfile, false);
  assert.notEqual(config.entries[0]?.id, config.entries[1]?.id);
});

test('configuration rejects duplicate ids and invalid limits or placeholders', async (t) => {
  const { raw, configPath } = await workspace(t);
  raw.entries.push({ ...raw.entries[0]!, id: raw.entries[0]!.id });
  await writeFile(configPath, JSON.stringify(raw));
  await assert.rejects(loadConfig(configPath), /Duplicate entry id/);
  for (const command of ['tool --file "{input}"', "tool --file '{input}'", 'tool --file prefix{input}', 'tool --file missing']) {
    assert.throws(() => validateTemplate(command, 'command', true));
  }
  validateTemplate('tool --file {input}', 'command', true);
  validateTemplate('tool --start', 'warmupCommand', false);
  await writeFile(configPath, JSON.stringify({ ...raw, entries: [raw.entries[0]], timeoutMs: -1 }));
  await assert.rejects(loadConfig(configPath), /timeoutMs/);
});

test('directory catalog discovers nested requests and reports malformed files individually', async (t) => {
  const { config } = await workspace(t);
  await mkdir(path.join(config.requestsDirectory, 'nested'));
  await writeFile(path.join(config.requestsDirectory, 'nested', 'bom.json'), '\uFEFF{"state":"hello","questions":{}}');
  await writeFile(path.join(config.requestsDirectory, 'broken.json'), '{ broken');
  await writeFile(path.join(config.requestsDirectory, 'ignored.txt'), 'not JSON');
  const catalog = await loadCatalog(config);
  assert.equal(catalog.requests.length, 3);
  assert.ok(catalog.requests.find((item) => item.id === 'broken.json')?.error);
  assert.equal(catalog.requests.find((item) => item.id === 'ticket.json')?.questionCount, 2);
  assert.equal((await readRequest(config, 'nested/bom.json')).payload.state, 'hello');
  assert.ok(!('env' in catalog.entries[0]!));
});

test('request selection cannot escape the configured directory', async (t) => {
  const { config } = await workspace(t);
  await assert.rejects(readRequest(config, '../config.json'), /inside/);
  await assert.rejects(readRequest(config, '..\\config.json'), /Invalid/);
  assert.throws(() => parseRequest('[]'), /JSON object/);
  assert.throws(() => parseRequest('{'), /Invalid request JSON/);
});
