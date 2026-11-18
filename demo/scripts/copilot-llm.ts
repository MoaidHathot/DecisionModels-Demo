import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { isRecord } from '../shared/types.ts';
import { parseLlmSettings, parseRequest } from '../server/config.ts';
import { invokeLlm, listLlmModels } from '../server/llm.ts';

try {
  const { values } = parseArgs({ options: { input: { type: 'string' }, settings: { type: 'string' }, models: { type: 'boolean' }, 'cli-path': { type: 'string' } } });
  if (values.models) {
    console.log(JSON.stringify(await listLlmModels(values['cli-path']), null, 2));
  } else {
    if (!values.input || !values.settings) throw new Error('Usage: copilot-llm.ts --input <request.json> --settings <settings.json>, or --models.');
    const envelope: unknown = JSON.parse((await readFile(values.settings, 'utf8')).replace(/^\uFEFF/, ''));
    if (!isRecord(envelope) || typeof envelope.timeoutMs !== 'number' || !Number.isInteger(envelope.timeoutMs) || envelope.timeoutMs < 100) throw new Error('Invalid LLM settings file: llm and timeoutMs are required.');
    const settings = parseLlmSettings(envelope.llm);
    const request = parseRequest(await readFile(values.input, 'utf8'));
    console.log(JSON.stringify(await invokeLlm(settings, request, envelope.timeoutMs), null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
