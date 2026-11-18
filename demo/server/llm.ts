import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CopilotSession, SessionConfig } from '@github/copilot-sdk';
import { isRecord } from '../shared/types.ts';
import type { JsonObject, LlmSettings } from '../shared/types.ts';
import { extractResponse } from './parsers.ts';
import { quotePowerShell } from './process.ts';

const probabilitySchema = { type: 'number', minimum: 0, maximum: 1 };
const objectSchema = (properties: JsonObject): JsonObject => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const literalSchema = (value: string) => ({ type: 'string', const: value });

export function llmResponseSchema(request: JsonObject): JsonObject {
  if (!Object.hasOwn(request, 'state') && typeof request.text !== 'string') throw new Error('LLM requests need state or text as evidence.');
  if (!isRecord(request.questions) || !Object.keys(request.questions).length) throw new Error('LLM entries need explicit named questions. Expand any tool-specific preset into a questions object.');
  const questions = Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
    if (!isRecord(value) || typeof value.instructions !== 'string' || !value.instructions.trim()) throw new Error(`Question "${id}" needs instructions.`);
    let answer: JsonObject;
    if (['predicate', 'noul', 'boolean'].includes(String(value.type))) {
      answer = objectSchema({ type: literalSchema('predicate'), probability: probabilitySchema });
    } else if (value.type === 'choice') {
      const options = value.choices ?? value.criteria;
      const labels = Array.isArray(options) ? options : isRecord(options) ? Object.keys(options) : [];
      if (labels.length < 2 || labels.some((label) => typeof label !== 'string' || !label.trim()) || new Set(labels).size !== labels.length) {
        throw new Error(`Choice question "${id}" needs at least two unique choices.`);
      }
      answer = objectSchema({
        type: literalSchema('choice'),
        choice: { type: 'string', enum: labels },
        probabilities: objectSchema(Object.fromEntries(labels.map((label) => [label, probabilitySchema]))),
      });
    } else if (value.type === 'score') {
      const levels = value.levels ?? value.criteria;
      if (!Array.isArray(levels) || levels.length < 2 || levels.some((level) => typeof level !== 'string' || !level.trim())) throw new Error(`Score question "${id}" needs at least two level labels.`);
      answer = objectSchema({
        type: literalSchema('score'), score: { type: 'number', minimum: 0, maximum: levels.length - 1 },
        probabilities: { type: 'array', items: probabilitySchema, minItems: levels.length, maxItems: levels.length },
      });
    } else throw new Error(`Unsupported LLM question type for "${id}": ${String(value.type)}.`);
    const refusal = objectSchema({ type: literalSchema('refused'), reason: { type: 'string' } });
    return [id, { anyOf: [answer, refusal] }];
  }));
  return objectSchema({ answers: objectSchema(questions) });
}

export function llmSessionConfig(settings: LlmSettings): SessionConfig {
  return {
    clientName: 'decision-lab',
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    reasoningSummary: 'none',
    systemMessage: { mode: 'replace', content: settings.systemPrompt },
    availableTools: [],
    includedBuiltinAgents: [],
    skipCustomInstructions: true,
    enableConfigDiscovery: false,
    enableOnDemandInstructionDiscovery: false,
    enableSkills: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    memory: { enabled: false },
    infiniteSessions: { enabled: false },
  };
}

export function llmCommand(inputPath: string, settingsPath: string): string {
  const script = fileURLToPath(new URL('../scripts/copilot-llm.ts', import.meta.url));
  return `& ${quotePowerShell(process.execPath)} ${quotePowerShell(script)} --input ${quotePowerShell(inputPath)} --settings ${quotePowerShell(settingsPath)}`;
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, file.endsWith('.js') ? constants.R_OK : constants.X_OK);
    return (await stat(file)).isFile();
  } catch { return false; }
}

// The SDK requires an actual path; unlike child_process.spawn it does not search PATH.
export async function copilotRuntimePath(configured?: string): Promise<string | undefined> {
  const explicit = configured ?? process.env.COPILOT_CLI_PATH;
  const name = explicit ?? 'copilot';
  if (/\.(cmd|bat|ps1)$/i.test(name)) throw new Error('llm.cliPath must point to a native Copilot executable or its .js entry point, not a shell shim.');
  if (path.isAbsolute(name) || /[\\/]/.test(name)) {
    const file = path.resolve(name);
    if (!await executable(file)) throw new Error(`Copilot runtime not found: ${file}`);
    return file;
  }
  const names = process.platform === 'win32' && !path.extname(name) ? [`${name}.exe`, name] : [name];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const candidate of names) {
      const file = path.resolve(directory.replace(/^"|"$/g, ''), candidate);
      if (await executable(file)) return file;
    }
  }
  if (explicit) throw new Error(`Copilot runtime "${explicit}" was not found. Use an executable/JS path in llm.cliPath.`);
  // SDK distributions include a compatible stdio runtime when no native CLI is on PATH.
  return undefined;
}

export async function listLlmModels(cliPath?: string) {
  const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
  const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: await copilotRuntimePath(cliPath) }), logLevel: 'error' });
  try {
    await client.start();
    return (await client.listModels()).map((model) => ({ id: model.id, name: model.name, reasoningEfforts: model.supportedReasoningEfforts ?? [] }));
  } finally { await client.stop(); }
}

export async function invokeLlm(settings: LlmSettings, request: JsonObject, timeoutMs: number): Promise<JsonObject> {
  const responseSchema = llmResponseSchema(request);
  const { CopilotClient, RuntimeConnection } = await import('@github/copilot-sdk');
  const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: await copilotRuntimePath(settings.cliPath) }), logLevel: 'error' });
  let session: CopilotSession | undefined;
  const usage: { model: string; reasoningEffort?: string; duration?: number; inputTokens?: number; outputTokens?: number }[] = [];
  try {
    console.error('Starting Copilot LLM runtime…');
    await client.start();
    const models = await client.listModels();
    const model = models.find((candidate) => candidate.id === settings.model);
    if (!model) throw new Error(`LLM model "${settings.model}" is unavailable. Run npm run models:llm to list available models.`);
    if (settings.reasoningEffort && !model.supportedReasoningEfforts?.includes(settings.reasoningEffort)) {
      throw new Error(`Model "${settings.model}" does not support reasoning effort "${settings.reasoningEffort}". Supported: ${model.supportedReasoningEfforts?.join(', ') || 'model default only'}.`);
    }
    session = await client.createSession(llmSessionConfig(settings));
    session.on('assistant.usage', (event) => {
      if (!event.agentId) usage.push({ model: event.data.model, reasoningEffort: event.data.reasoningEffort, duration: event.data.duration, inputTokens: event.data.inputTokens, outputTokens: event.data.outputTokens });
    });
    console.error(`Requesting ${settings.model} · ${settings.reasoningEffort ?? 'default'} reasoning…`);
    const start = performance.now();
    const reply = await session.sendAndWait({ prompt: JSON.stringify(request), responseSchema }, timeoutMs);
    const elapsedMilliseconds = performance.now() - start;
    const rawResponse = reply?.data.content ?? '';
    const current = await session.rpc.model.getCurrent();
    // Keep an invalid/refused provider response inspectable rather than losing it to a parser error.
    let answers: unknown = null;
    try { answers = extractResponse(rawResponse).answers; } catch { /* Normalization reports the failure and retains this envelope. */ }
    return {
      provider: 'copilot-llm', model: usage.at(-1)?.model ?? current.modelId ?? null,
      requestedModel: settings.model, reasoningEffort: usage.at(-1)?.reasoningEffort ?? current.reasoningEffort ?? null,
      requestedReasoningEffort: settings.reasoningEffort ?? null,
      elapsedMilliseconds, answers, rawResponse, usage,
    };
  } finally {
    try {
      if (session) {
        await session.disconnect();
        await client.deleteSession(session.sessionId);
      }
    } catch (error) {
      console.error(`Session cleanup: ${error instanceof Error ? error.message : String(error)}`);
    } finally { await client.stop(); }
  }
}
