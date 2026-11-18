import { stripVTControlCharacters } from 'node:util';
import { isRecord } from '../shared/types.ts';
import type { Decision, JsonObject, NormalizedResult, ParserKind } from '../shared/types.ts';

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const probability = (value: unknown): number | null => {
  const number = finite(value);
  return number !== null && number >= 0 && number <= 1 ? number : null;
};
const string = (value: unknown): string | null => typeof value === 'string' ? value : null;
const object = (value: unknown): JsonObject => isRecord(value) ? value : {};

export function extractResponse(stdout: string): JsonObject {
  const clean = stripVTControlCharacters(stdout).replace(/^\uFEFF/, '').trim();
  try {
    const value: unknown = JSON.parse(clean);
    if (isRecord(value) && isRecord(value.answers)) return value;
  } catch { /* CLI/profile banners can surround the response. */ }

  let response: JsonObject | null = null;
  const stack: { start: number; hasAnswers: boolean }[] = [];
  let quoteStart = -1;
  let escaped = false;
  // A single scan handles even unmatched log braces without repeatedly scanning the output.
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (quoteStart !== -1) {
      if (char === '\n' || char === '\r') { quoteStart = -1; escaped = false; }
      else if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') {
        if (index - quoteStart === 8 && clean.slice(quoteStart + 1, index) === 'answers') {
          let next = index + 1;
          while (/\s/.test(clean[next] ?? '') && next < clean.length) next++;
          if (clean[next] === ':' && stack.length) stack[stack.length - 1]!.hasAnswers = true;
        }
        quoteStart = -1;
      }
      continue;
    }
    if (char === '"') quoteStart = index;
    else if (char === '{') stack.push({ start: index, hasAnswers: false });
    else if (char === '}') {
      const candidate = stack.pop();
      if (!candidate?.hasAnswers) continue;
      try {
        const value: unknown = JSON.parse(clean.slice(candidate.start, index + 1));
        if (isRecord(value) && isRecord(value.answers)) response = value;
      } catch { /* A log message with braces is not necessarily JSON. */ }
    }
  }
  if (!response) throw new Error('No JSON decision response with an "answers" object was found on stdout. Open the raw output for details.');
  return response;
}

function distribution(value: unknown): Record<string, number> | null {
  if (!isRecord(value) && !Array.isArray(value)) return null;
  const entries = Object.entries(value).flatMap(([key, item]) => {
    const number = probability(item);
    return number === null ? [] : [[key, number] as const];
  });
  return entries.length ? Object.fromEntries(entries) : null;
}

function normalizeAnswer(question: string, raw: unknown, request: JsonObject): Decision {
  if (!isRecord(raw)) throw new Error(`Answer "${question}" is not a typed decision object.`);
  const base = { question, detail: null, distribution: null };
  const type = raw.type;
  if (type === 'predicate' || type === 'noul' || type === 'boolean') {
    const p = probability(raw.probability ?? raw.noul);
    if (p === null) throw new Error(`Answer "${question}" has no valid yes/no probability.`);
    return { ...base, type: 'predicate', value: p >= 0.5, label: p >= 0.5 ? 'Yes' : 'No', probability: p, probabilityLabel: 'P(yes)', distribution: { No: 1 - p, Yes: p } };
  }
  if (type === 'choice') {
    const choice = string(raw.choice ?? raw.value);
    if (choice === null) throw new Error(`Answer "${question}" has no selected choice.`);
    const probabilities = distribution(raw.probabilities);
    return { ...base, type, value: choice, label: choice, probability: probabilities?.[choice] ?? null, probabilityLabel: 'P(choice)', distribution: probabilities };
  }
  if (type === 'score') {
    const score = finite(raw.score);
    if (score === null) throw new Error(`Answer "${question}" has no numeric score.`);
    const definition = object(object(request.questions)[question]);
    const levels = raw.levels ?? raw.legend ?? definition.levels ?? definition.criteria;
    const labels = Array.isArray(levels) || isRecord(levels) ? Object.fromEntries(Object.entries(levels).map(([key, label]) => [key, typeof label === 'string' ? label : key])) : {};
    const probabilities = distribution(raw.probabilities);
    const ranked = Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const max = Object.keys(labels).length - 1;
    return {
      ...base, type, value: score,
      label: top ? (labels[top[0]] ?? top[0]) : string(raw.level) ?? `Score ${score.toFixed(2)}`,
      detail: `Score ${score.toFixed(2)}${max > 0 ? ` / ${max}` : ''}${top ? ' · top level shown' : ''}`,
      probability: top?.[1] ?? null,
      probabilityLabel: 'P(top level)',
      distribution: probabilities ? Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [labels[key] ?? key, value])) : null,
    };
  }
  if (type === 'refused' || raw.refused === true) {
    return { ...base, type: 'refused', value: null, label: 'Refused', detail: string(raw.reason), probability: null, probabilityLabel: 'Not returned' };
  }
  throw new Error(`Unsupported answer type for "${question}": ${String(type)}. Raw output is available in the result details.`);
}

export function normalizeResponse(stdout: string, parser: ParserKind = 'auto', request: JsonObject = {}): NormalizedResult {
  const raw = extractResponse(stdout);
  const routing = object(raw.routing);
  const kind = parser === 'auto' ? (raw.provider === 'copilot-llm' ? 'llm' : isRecord(raw.routing) ? 'locallaya' : 'copilot') : parser;
  const answers = Object.entries(object(raw.answers));
  if (!answers.length) throw new Error('The model returned an empty answers object.');
  const decisions = answers.map(([question, answer]) => normalizeAnswer(question, answer, request));
  const missing = Object.keys(object(request.questions)).filter((question) => !Object.hasOwn(object(raw.answers), question));
  if (missing.length) throw new Error(`The response is missing answers for: ${missing.join(', ')}.`);
  const warnings: string[] = [];
  if (kind === 'llm') {
    const definitions = object(request.questions);
    if (Object.keys(definitions).length && decisions.some((decision) => !Object.hasOwn(definitions, decision.question))) throw new Error('LLM returned answers for questions that were not requested.');
    for (const decision of decisions) {
      const definition = object(object(request.questions)[decision.question]);
      const answer = object(object(raw.answers)[decision.question]);
      if (decision.type === 'refused') continue;
      const expected = definition.type === 'noul' || definition.type === 'boolean' ? 'predicate' : definition.type;
      if (expected && decision.type !== expected) throw new Error(`LLM returned the wrong answer type for "${decision.question}".`);
      if (decision.type === 'choice') {
        const options = definition.choices ?? definition.criteria;
        const labels = Array.isArray(options) ? options.map(String) : Object.keys(object(options));
        if (labels.length && !labels.includes(String(decision.value))) throw new Error(`LLM returned an unknown choice for "${decision.question}".`);
        if (labels.some((label) => probability(object(answer.probabilities)[label]) === null)) throw new Error(`LLM returned an incomplete choice distribution for "${decision.question}".`);
        if (labels.length && Object.keys(object(answer.probabilities)).some((label) => !labels.includes(label))) throw new Error(`LLM returned probabilities for unknown choices in "${decision.question}".`);
      }
      if (decision.type === 'score') {
        const levels = definition.levels ?? definition.criteria;
        if (Array.isArray(levels) && (!Array.isArray(answer.probabilities) || answer.probabilities.length !== levels.length || answer.probabilities.some((p) => probability(p) === null) || Number(decision.value) < 0 || Number(decision.value) > levels.length - 1)) {
          throw new Error(`LLM returned an invalid score or level distribution for "${decision.question}".`);
        }
        const probabilities = Array.isArray(answer.probabilities) ? answer.probabilities : [];
        const expectedScore = probabilities.reduce<number>((sum, p: unknown, index) => sum + (probability(p) ?? 0) * index, 0);
        if (probabilities.length && Math.abs(Number(decision.value) - expectedScore) > 0.02) warnings.push(`LLM score for "${decision.question}" (${Number(decision.value).toFixed(2)}) differs from its distribution's expected index (${expectedScore.toFixed(2)}).`);
      }
      if (decision.type === 'choice' || decision.type === 'score') {
        const values = Object.values(distribution(answer.probabilities) ?? {});
        if (!values.length || Math.abs(values.reduce((sum, p) => sum + p, 0) - 1) > 0.01) throw new Error(`LLM probabilities for "${decision.question}" must sum to 1.`);
      }
      decision.probabilityLabel = `Est. ${decision.probabilityLabel}`;
    }
  }
  if (object(raw.usage).truncated === true) warnings.push('The model truncated the input to fit its context window.');
  if (decisions.some((d) => d.type === 'refused')) warnings.push('The model refused at least one question.');
  const elapsed = finite(kind === 'locallaya' ? routing.ms : raw.elapsedMilliseconds);
  return {
    provider: kind === 'llm' ? 'Copilot LLM' : kind === 'locallaya' ? 'LocalLaya' : string(raw.provider) ?? 'Copilot',
    model: string(raw.model) ?? string(raw.upstreamModel) ?? string(routing.model),
    mode: kind === 'llm' ? 'llm' : kind === 'locallaya' ? (raw.backend === 'remote' ? 'sidecar' : raw.backend === 'local' ? 'local' : null) : string(raw.transport) ?? null,
    device: string(routing.device) ?? string(routing.lane),
    execution: string(object(routing.exec).mode),
    reportedMs: elapsed !== null && elapsed >= 0 ? elapsed : null,
    reportedLabel: kind === 'llm' ? 'LLM request · sendAndWait' : kind === 'locallaya' ? 'Inference · routing.ms' : 'CLI-reported · elapsedMilliseconds',
    reasoningEffort: kind === 'llm' ? string(raw.reasoningEffort) : null,
    probabilitySource: kind === 'llm' ? 'llm-estimate' : 'model',
    decisions,
    warnings,
  };
}
