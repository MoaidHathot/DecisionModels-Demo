import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { runCommand, renderCommand } from '../server/process.ts';
import { normalizeResponse } from '../server/parsers.ts';
import { fixtureCommand, quote, workspace } from './helpers.ts';

test('real PowerShell transports Unicode and safely quotes input paths with spaces and apostrophes', async (t) => {
  const { config, inputPath } = await workspace(t);
  const output = await runCommand({ config, entry: config.entries[0]!, command: renderCommand(config.entries[0]!.command, inputPath), signal: new AbortController().signal });
  assert.equal(output.exitCode, 0, output.stderr);
  assert.ok(output.wallMs > 0);
  assert.match(output.stderr, /مرحبا/);
  assert.equal(normalizeResponse(output.stdout).decisions[0]?.label, 'billing');
  assert.match(output.stdout, /Original request/);
});

test('native exit codes propagate even when stdout contains valid decisions', async (t) => {
  const { config, inputPath } = await workspace(t);
  const output = await runCommand({ config, entry: config.entries[0]!, command: renderCommand(fixtureCommand('--fail'), inputPath), signal: new AbortController().signal });
  assert.equal(output.exitCode, 7);
  assert.match(output.stderr, /Simulated CLI failure/);
});

test('timeouts and excessive output terminate the command', async (t) => {
  const { config, inputPath } = await workspace(t);
  const timeout = await runCommand({ config, entry: { ...config.entries[0]!, timeoutMs: 700 }, command: renderCommand(fixtureCommand('--hang'), inputPath), signal: new AbortController().signal });
  assert.equal(timeout.timedOut, true);
  assert.match(timeout.error!, /Timed out/);
  const overflow = await runCommand({ config, entry: config.entries[0]!, command: renderCommand(fixtureCommand('--overflow'), inputPath), signal: new AbortController().signal });
  assert.match(overflow.error!, /1 MiB/);
  assert.ok(Buffer.byteLength(overflow.stdout) <= 1024 * 1024);
});

test('cancellation kills a running native child tree, not only its PowerShell parent', async (t) => {
  const { config, inputPath, directory } = await workspace(t);
  const pidFile = path.join(directory, 'child.pid');
  const controller = new AbortController();
  const output = await runCommand({
    config, entry: config.entries[0]!, command: renderCommand(fixtureCommand(`--spawn-child --pid-file ${quote(pidFile)} --hang`), inputPath), signal: controller.signal,
    onProgress: (line) => { if (line.includes('Fixture ready')) controller.abort(); },
  });
  assert.equal(output.cancelled, true);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), 'The native grandchild must no longer be running.');
});

test('an unavailable shell is reported as a launch error', async (t) => {
  const { config } = await workspace(t);
  config.shell.executable = 'decision-lab-shell-that-does-not-exist';
  const output = await runCommand({ config, entry: config.entries[0]!, command: 'Write-Output ok', signal: new AbortController().signal });
  assert.match(output.error!, /Could not launch/);
});
