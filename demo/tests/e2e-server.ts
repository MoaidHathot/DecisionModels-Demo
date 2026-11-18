import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, staticFrontend } from '../server/app.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.artifacts', 'e2e');
await mkdir(directory, { recursive: true });
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const command = (args = '') => `& ${quote(process.execPath)} ${quote(path.join(root, 'tests', 'fixtures', 'fake-model.mjs'))} --file {input} ${args}`;
const configPath = path.join(directory, 'config.json');
await writeFile(configPath, JSON.stringify({
  requestsDirectory: path.join(root, 'requests'),
  shell: { executable: 'pwsh', loadProfile: false },
  timeoutMs: 30000,
  maxConcurrency: 4,
  entries: [
    { id: 'copilot', name: 'GitHub Copilot', description: 'Deterministic Copilot-format test command.', mode: 'cloud', command: command('--delay 1100'), parser: 'copilot', selected: true },
    { id: 'laya-sidecar', name: 'LocalLaya · sidecar', description: 'Deterministic LocalLaya-format test command.', mode: 'sidecar', command: command('--style laya --delay 80'), warmupCommand: command('--style laya --delay 350'), parser: 'locallaya', selected: true },
    { id: 'llm', name: 'Copilot LLM', description: 'Deterministic LLM-format test command.', mode: 'llm', command: command('--style llm --delay 650'), parser: 'llm', selected: true },
    { id: 'broken', name: 'Broken fixture', description: 'Exercises a failing native command.', mode: 'test', command: command('--fail'), selected: false },
    { id: 'slow', name: 'Slow fixture', description: 'Exercises in-flight cancellation.', mode: 'test', command: command('--delay 20000'), selected: false },
  ],
}, null, 2));
const app = await createApp({ configPath, runtimeDirectory: path.join(directory, 'runtime'), frontend: staticFrontend(path.join(root, 'dist')) });
app.server.listen(4311, '127.0.0.1', () => console.log('Browser test server: http://127.0.0.1:4311'));
process.on('SIGINT', () => { void app.close(); });
process.on('SIGTERM', () => { void app.close(); });
