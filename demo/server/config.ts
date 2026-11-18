import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from '../shared/types.ts';
import type { AppConfig, Catalog, JsonObject, LlmSettings, ModelEntry, RequestInput, SampleRequest } from '../shared/types.ts';

export class AppError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

export const MAX_INPUT_BYTES = 1024 * 1024;

function text(value: unknown, name: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new AppError(`${name} must be a non-empty string.`);
  return value;
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new AppError(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AppError(`${name} must be true or false.`);
  return value;
}

export function validateTemplate(command: string, name: string, requireInput: boolean): void {
  if (requireInput && !command.includes('{input}')) throw new AppError(`${name} must contain the {input} placeholder.`);
  // The runner supplies the quotes. A standalone token also avoids interpolation inside a string.
  const withoutTokens = command.replace(/(^|\s)\{input\}(?=\s|$)/g, '$1');
  if (withoutTokens.includes('{input}')) {
    throw new AppError(`${name}: use {input} as a standalone, unquoted argument; the runner quotes the path.`);
  }
}

export function parseLlmSettings(value: unknown, name = 'llm'): LlmSettings {
  if (!isRecord(value)) throw new AppError(`${name} must configure model and systemPrompt.`);
  if (value.provider !== undefined && value.provider !== 'copilot') throw new AppError(`${name}.provider must be copilot.`);
  return {
    provider: 'copilot',
    model: text(value.model, `${name}.model`),
    systemPrompt: text(value.systemPrompt, `${name}.systemPrompt`),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: text(value.reasoningEffort, `${name}.reasoningEffort`) }),
    ...(value.cliPath === undefined ? {} : { cliPath: text(value.cliPath, `${name}.cliPath`) }),
  };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absolute = path.resolve(configPath);
  let raw: unknown;
  try {
    raw = JSON.parse((await readFile(absolute, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new AppError(`Cannot read config ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new AppError('Configuration must be a JSON object.');
  const directory = path.dirname(absolute);
  if (raw.shell !== undefined && !isRecord(raw.shell)) throw new AppError('shell must be an object.');
  const shell = isRecord(raw.shell) ? raw.shell : {};
  const config: AppConfig = {
    path: absolute,
    directory,
    requestsDirectory: path.resolve(directory, text(raw.requestsDirectory, 'requestsDirectory', './requests')),
    port: integer(raw.port, 'port', 4310, 1, 65535),
    shell: {
      executable: text(shell.executable, 'shell.executable', 'pwsh'),
      loadProfile: boolean(shell.loadProfile, 'shell.loadProfile', true),
    },
    timeoutMs: integer(raw.timeoutMs, 'timeoutMs', 120000, 100, 3600000),
    maxConcurrency: integer(raw.maxConcurrency, 'maxConcurrency', 4, 1, 32),
    entries: [],
  };
  if (!Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.length > 32) {
    throw new AppError('entries must contain between 1 and 32 named invocation presets.');
  }
  const ids = new Set<string>();
  for (const [index, item] of raw.entries.entries()) {
    const key = `entries[${index}]`;
    if (!isRecord(item)) throw new AppError(`${key} must be an object.`);
    const id = text(item.id, `${key}.id`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new AppError(`${key}.id must use letters, numbers, - or _ (max 64 characters).`);
    if (ids.has(id)) throw new AppError(`Duplicate entry id: ${id}. Every preset needs its own id.`);
    ids.add(id);
    const kind = item.kind ?? 'command';
    if (kind !== 'command' && kind !== 'llm') throw new AppError(`${key}.kind must be command or llm.`);
    const llm = kind === 'llm' ? parseLlmSettings(item.llm, `${key}.llm`) : null;
    if (kind === 'command' && item.llm !== undefined) throw new AppError(`${key}: set kind to llm to use LLM settings.`);
    if (kind === 'llm' && (item.command !== undefined || item.parser !== undefined || item.warmupCommand !== undefined)) {
      throw new AppError(`${key}: LLM entries use llm settings rather than command, parser or warmupCommand.`);
    }
    if (llm?.cliPath && /[\\/]/.test(llm.cliPath)) llm.cliPath = path.resolve(directory, llm.cliPath);
    const command = kind === 'llm' ? 'Copilot SDK · structured LLM request' : text(item.command, `${key}.command`);
    if (kind === 'command') validateTemplate(command, `${key}.command`, true);
    const warmupCommand = item.warmupCommand === undefined ? undefined : text(item.warmupCommand, `${key}.warmupCommand`);
    if (warmupCommand) validateTemplate(warmupCommand, `${key}.warmupCommand`, false);
    const parser = kind === 'llm' ? 'llm' : text(item.parser, `${key}.parser`, 'auto');
    if (parser !== 'auto' && parser !== 'copilot' && parser !== 'locallaya' && parser !== 'llm') throw new AppError(`${key}.parser must be auto, copilot, locallaya or llm.`);
    const env: Record<string, string> = {};
    if (item.env !== undefined) {
      if (!isRecord(item.env)) throw new AppError(`${key}.env must be an object of strings.`);
      for (const [envKey, envValue] of Object.entries(item.env)) {
        if (typeof envValue !== 'string' || !envKey || envKey.includes('=') || envKey.includes('\0') || envValue.includes('\0')) {
          throw new AppError(`${key}.env contains an invalid environment variable.`);
        }
        env[envKey] = envValue;
      }
    }
    config.entries.push({
      id,
      kind,
      name: text(item.name, `${key}.name`),
      description: text(item.description, `${key}.description`, kind === 'llm' ? 'Copilot SDK · fresh LLM session' : 'Custom invocation'),
      mode: text(item.mode, `${key}.mode`, kind === 'llm' ? 'llm' : 'custom'),
      command,
      parser,
      selected: boolean(item.selected, `${key}.selected`, true),
      warmupCommand,
      timeoutMs: integer(item.timeoutMs, `${key}.timeoutMs`, config.timeoutMs, 100, 3600000),
      workingDirectory: path.resolve(directory, text(item.workingDirectory, `${key}.workingDirectory`, '.')),
      loadProfile: boolean(item.loadProfile, `${key}.loadProfile`, config.shell.loadProfile),
      env,
      llm,
    });
  }
  return config;
}

export function parseRequest(source: string): JsonObject {
  if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) throw new AppError('A request can be at most 1 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new AppError(`Invalid request JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new AppError('A request must be a JSON object.');
  return value;
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function requestFiles(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const id = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await requestFiles(path.join(directory, entry.name), `${id}/`));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(id);
    if (files.length > 500) throw new AppError('The request directory contains more than 500 JSON files. Choose a smaller directory.');
  }
  return files;
}

export async function readRequest(config: AppConfig, id: string): Promise<RequestInput> {
  if (!id.toLowerCase().endsWith('.json') || id.includes('\\') || id.includes('\0')) throw new AppError('Invalid request id.');
  const root = await realpath(config.requestsDirectory);
  const candidate = path.resolve(root, id);
  if (!within(root, candidate)) throw new AppError('Request must be inside the configured requests directory.');
  let file: string;
  try {
    file = await realpath(candidate);
  } catch {
    throw new AppError(`Request not found: ${id}`, 404);
  }
  if (!within(root, file)) throw new AppError('Request must be inside the configured requests directory.');
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_INPUT_BYTES) throw new AppError(`Request ${id} must be a JSON file of at most 1 MiB.`);
  const payload = parseRequest(await readFile(file, 'utf8'));
  const name = path.posix.basename(id, path.posix.extname(id)).replace(/^\d+[-_]/, '').replace(/[-_]/g, ' ');
  return { id, name: name.charAt(0).toUpperCase() + name.slice(1), payload };
}

export async function loadCatalog(config: AppConfig): Promise<Catalog> {
  let files: string[];
  try {
    files = await requestFiles(config.requestsDirectory);
  } catch (error) {
    throw new AppError(`Cannot load requests from ${config.requestsDirectory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const requests: SampleRequest[] = await Promise.all(files.map(async (id) => {
    try {
      const { name, payload } = await readRequest(config, id);
      const questions = isRecord(payload.questions) ? Object.values(payload.questions) : [];
      const state = payload.state ?? payload.text ?? '';
      return {
        id, name,
        description: (typeof state === 'string' ? state : JSON.stringify(state)).slice(0, 220),
        questionCount: questions.length,
        types: [...new Set(questions.map((q) => isRecord(q) && typeof q.type === 'string' ? q.type : 'custom'))],
      };
    } catch (error) {
      return { id, name: path.posix.basename(id), description: '', questionCount: 0, types: [], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return {
    configPath: config.path,
    requestsDirectory: config.requestsDirectory,
    entries: config.entries.map(({ workingDirectory: _cwd, env: _env, loadProfile: _profile, ...entry }: ModelEntry) => entry),
    requests,
    maxConcurrency: config.maxConcurrency,
  };
}
