import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { loadConfig } from '../server/config.ts';

export const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureScript = path.join(demoRoot, 'tests', 'fixtures', 'fake-model.mjs');
export const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const fixtureCommand = (extra = '') => `& ${quote(process.execPath)} ${quote(fixtureScript)} --file {input} ${extra}`.trim();
export const sample = {
  state: 'Original request: a refund, with a quote " and braces { here } and Arabic مرحبا.',
  questions: {
    team: { type: 'choice', instructions: 'Which team?', choices: { billing: 'Payments', support: 'Other' } },
    refund: { type: 'predicate', instructions: 'A refund?' },
  },
};

export async function workspace(t: TestContext, entryOverrides: Record<string, unknown>[] = [{}]) {
  const artifacts = path.join(demoRoot, '.artifacts');
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(path.join(artifacts, "test O'Brien space-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  await mkdir(path.join(directory, 'requests'));
  await writeFile(path.join(directory, 'requests', 'ticket.json'), JSON.stringify(sample));
  const configPath = path.join(directory, 'config.json');
  const raw = {
    requestsDirectory: './requests',
    shell: { executable: 'pwsh', loadProfile: false },
    timeoutMs: 10000,
    maxConcurrency: 4,
    entries: entryOverrides.map((overrides, i): Record<string, unknown> => ({ id: `entry-${i}`, name: `Fixture ${i}`, ...(overrides.kind === 'llm' ? {} : { command: fixtureCommand(), warmupCommand: fixtureCommand() }), ...overrides })),
  };
  await writeFile(configPath, JSON.stringify(raw));
  const config = await loadConfig(configPath);
  return { directory, configPath, config, raw, inputPath: path.join(directory, 'requests', 'ticket.json'), runtime: path.join(directory, 'runtime') };
}
