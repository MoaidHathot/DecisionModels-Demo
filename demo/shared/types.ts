export type JsonObject = Record<string, unknown>;
export type ParserKind = 'auto' | 'copilot' | 'locallaya' | 'llm';
export type TaskStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';
export type RunStatus = 'queued' | 'running' | 'completed' | 'cancelled';
export type RunKind = 'comparison' | 'warmup';
export type ExecutionMode = 'sequential' | 'parallel' | 'race';

export interface LlmSettings {
  provider: 'copilot';
  model: string;
  systemPrompt: string;
  reasoningEffort?: string;
  cliPath?: string;
}

export interface ModelEntry {
  id: string;
  name: string;
  kind: 'command' | 'llm';
  description: string;
  mode: string;
  command: string;
  parser: ParserKind;
  selected: boolean;
  warmupCommand?: string;
  timeoutMs: number;
  workingDirectory: string;
  loadProfile: boolean;
  env: Record<string, string>;
  llm: LlmSettings | null;
}

export type PublicEntry = Omit<ModelEntry, 'workingDirectory' | 'env' | 'loadProfile'>;

export interface AppConfig {
  path: string;
  directory: string;
  requestsDirectory: string;
  port: number;
  shell: { executable: string; loadProfile: boolean };
  timeoutMs: number;
  maxConcurrency: number;
  entries: ModelEntry[];
}

export interface SampleRequest {
  id: string;
  name: string;
  description: string;
  questionCount: number;
  types: string[];
  error?: string;
}

export interface RequestInput {
  id: string;
  name: string;
  payload: JsonObject;
}

export interface Catalog {
  configPath: string;
  requestsDirectory: string;
  entries: PublicEntry[];
  requests: SampleRequest[];
  maxConcurrency: number;
}

export interface Decision {
  question: string;
  type: 'predicate' | 'choice' | 'score' | 'refused';
  value: string | number | boolean | null;
  label: string;
  detail: string | null;
  probability: number | null;
  probabilityLabel: string;
  distribution: Record<string, number> | null;
}

export interface NormalizedResult {
  provider: string;
  model: string | null;
  mode: string | null;
  device: string | null;
  execution: string | null;
  reportedMs: number | null;
  reportedLabel: string;
  reasoningEffort?: string | null;
  probabilitySource?: 'model' | 'llm-estimate';
  decisions: Decision[];
  warnings: string[];
}

export interface TaskSnapshot {
  id: string;
  entryId: string;
  entryName: string;
  configuredMode: string;
  requestId: string;
  requestName: string;
  repetition: number;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  wallMs: number | null;
  result: NormalizedResult | null;
  error: string | null;
  progress: string | null;
  finishOrder: number | null;
}

export interface RunSnapshot {
  id: string;
  kind: RunKind;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  concurrency: number;
  execution: ExecutionMode;
  repetitions: number;
  tasks: TaskSnapshot[];
  error: string | null;
}

export interface WarmupState {
  entryId: string;
  status: TaskStatus;
  finishedAt: string | null;
  wallMs: number | null;
  error: string | null;
  runId: string;
  taskId: string;
}

export interface RunsState {
  active: RunSnapshot | null;
  latestComparison: RunSnapshot | null;
  warmups: Record<string, WarmupState>;
}

export interface RunEvent {
  run: RunSnapshot;
  warmups: Record<string, WarmupState>;
}

export interface StartRunInput {
  kind: RunKind;
  entryIds: string[];
  requestIds?: string[];
  customJson?: string;
  repetitions: number;
  concurrency: number;
  execution?: ExecutionMode;
}

export interface ExecutionOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  wallMs: number;
  error: string | null;
  cancelled: boolean;
  timedOut: boolean;
}

export interface TaskDetail {
  task: TaskSnapshot;
  command: string;
  request: JsonObject;
  output: ExecutionOutput | null;
  llm: LlmSettings | null;
}

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isRunActive(run: RunSnapshot | null): boolean {
  return run?.status === 'queued' || run?.status === 'running';
}
