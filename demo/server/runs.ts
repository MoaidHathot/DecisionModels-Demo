import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isRecord, isRunActive } from '../shared/types.ts';
import type { AppConfig, ExecutionMode, ExecutionOutput, ModelEntry, RequestInput, RunEvent, RunSnapshot, RunsState, TaskDetail, TaskSnapshot, WarmupState } from '../shared/types.ts';
import { AppError, loadCatalog, parseRequest, readRequest } from './config.ts';
import { normalizeResponse } from './parsers.ts';
import { renderCommand, runCommand } from './process.ts';
import { llmCommand } from './llm.ts';

interface InternalTask {
  snapshot: TaskSnapshot;
  entry: ModelEntry;
  request: RequestInput;
  inputPath: string;
  command: string;
  output: ExecutionOutput | null;
}

interface InternalRun {
  snapshot: RunSnapshot;
  config: AppConfig;
  tasks: InternalTask[];
  directory: string;
  controller: AbortController;
  done: Promise<void>;
}

function uniqueIds(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some((id) => typeof id !== 'string')) throw new AppError(`Select at least one ${name}.`);
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) throw new AppError(`Duplicate ${name} ids are not allowed.`);
  return ids;
}

export class RunManager {
  #getConfig: () => Promise<AppConfig>;
  #runtimeDirectory: string;
  #runs = new Map<string, InternalRun>();
  #activeId: string | null = null;
  #latestComparisonId: string | null = null;
  #starting = false;
  #closing = false;
  #warmups: Record<string, WarmupState> = {};
  #events = new EventEmitter();

  constructor(getConfig: () => Promise<AppConfig>, runtimeDirectory: string) {
    this.#getConfig = getConfig;
    this.#runtimeDirectory = runtimeDirectory;
    this.#events.setMaxListeners(50);
  }

  state(config?: AppConfig): RunsState {
    if (config) this.#reconcileWarmups(config);
    return {
      active: this.#activeId ? this.get(this.#activeId) : null,
      latestComparison: this.#latestComparisonId ? this.get(this.#latestComparisonId) : null,
      warmups: structuredClone(this.#warmups),
    };
  }

  get(id: string): RunSnapshot {
    return structuredClone(this.#require(id).snapshot);
  }

  detail(runId: string, taskId: string): TaskDetail {
    const task = this.#require(runId).tasks.find((candidate) => candidate.snapshot.id === taskId);
    if (!task) throw new AppError('Result not found.', 404);
    return structuredClone({ task: task.snapshot, command: task.command, request: task.request.payload, output: task.output, llm: task.entry.llm });
  }

  export(id: string) {
    const run = this.#require(id);
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      timing: 'wallMs includes PowerShell/profile startup and the complete command. reportedMs is tool-specific. Warm-ups are separate runs.',
      run: this.get(id),
      results: run.tasks.map((task) => this.detail(id, task.snapshot.id)),
    };
  }

  subscribe(id: string, listener: (event: RunEvent) => void): () => void {
    this.#require(id);
    this.#events.on(id, listener);
    return () => this.#events.off(id, listener);
  }

  async start(body: unknown): Promise<RunSnapshot> {
    if (this.#closing) throw new AppError('The server is shutting down.', 503);
    if (this.#starting || this.#activeId) throw new AppError('A run is already active. Stop it or wait for it to finish.', 409);
    if (!isRecord(body)) throw new AppError('Run options must be a JSON object.');
    this.#starting = true;
    let directory: string | null = null;
    try {
      const config = await this.#getConfig();
      this.#reconcileWarmups(config);
      const kind = body.kind ?? 'comparison';
      if (kind !== 'comparison' && kind !== 'warmup') throw new AppError('kind must be comparison or warmup.');
      const entryIds = uniqueIds(body.entryIds, 'entry');
      const entries = entryIds.map((id) => {
        const entry = config.entries.find((candidate) => candidate.id === id);
        if (!entry) throw new AppError(`Unknown entry: ${id}. Reload the configuration.`);
        if (kind === 'warmup' && !entry.warmupCommand) throw new AppError(`${entry.name} has no warmupCommand configured.`);
        return entry;
      });
      const requestedConcurrency = body.concurrency ?? 1;
      if (typeof requestedConcurrency !== 'number' || !Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > config.maxConcurrency) {
        throw new AppError(`concurrency must be between 1 and ${config.maxConcurrency}.`);
      }
      let concurrency: number = requestedConcurrency;
      const requestedExecution = body.execution ?? (concurrency > 1 ? 'parallel' : 'sequential');
      if (requestedExecution !== 'race' && requestedExecution !== 'parallel' && requestedExecution !== 'sequential') throw new AppError('execution must be race, parallel or sequential.');
      let execution: ExecutionMode = requestedExecution;
      if (kind === 'warmup') execution = 'sequential';
      if (execution === 'sequential') concurrency = 1;
      if (execution === 'race') {
        if (entries.length > config.maxConcurrency) throw new AppError(`A race starts all selected entries together. Select at most ${config.maxConcurrency} entries or increase maxConcurrency.`);
        concurrency = entries.length;
      }
      const repetitions = kind === 'warmup' ? 1 : (body.repetitions ?? 1);
      if (typeof repetitions !== 'number' || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
        throw new AppError('repetitions must be between 1 and 10.');
      }
      let requests: RequestInput[];
      if (body.customJson !== undefined) {
        if (typeof body.customJson !== 'string') throw new AppError('customJson must be JSON text.');
        if (body.requestIds !== undefined) throw new AppError('Choose sample requests or pasted JSON, not both.');
        requests = [{ id: 'custom', name: 'Pasted request', payload: parseRequest(body.customJson) }];
      } else {
        const ids = uniqueIds(body.requestIds, 'request');
        const catalog = await loadCatalog(config);
        for (const id of ids) {
          const sample = catalog.requests.find((item) => item.id === id);
          if (!sample) throw new AppError(`Unknown request: ${id}. Reload the request directory.`);
          if (sample.error) throw new AppError(sample.error);
        }
        requests = await Promise.all(ids.map((id) => readRequest(config, id)));
      }
      if (kind === 'warmup') requests = requests.slice(0, 1);
      if (entries.length * requests.length * repetitions > 200) throw new AppError('A batch can contain at most 200 calls. Select fewer requests or repetitions.');
      if (this.#closing) throw new AppError('The server is shutting down.', 503);

      await mkdir(this.#runtimeDirectory, { recursive: true });
      directory = await mkdtemp(path.join(this.#runtimeDirectory, 'run-'));
      const inputPaths: string[] = [];
      for (const [index, request] of requests.entries()) {
        const file = path.join(directory, `request-${index}.json`);
        await writeFile(file, `${JSON.stringify(request.payload, null, 2)}\n`, 'utf8');
        inputPaths.push(file);
      }
      const llmFiles = new Map<string, string>();
      for (const entry of entries.filter((entry) => entry.kind === 'llm')) {
        // IDs are case-sensitive; filenames must also stay distinct on Windows.
        const file = path.join(directory, `llm-${randomUUID()}.json`);
        await writeFile(file, `${JSON.stringify({ llm: entry.llm, timeoutMs: entry.timeoutMs }, null, 2)}\n`, 'utf8');
        llmFiles.set(entry.id, file);
      }
      if (this.#closing) throw new AppError('The server is shutting down.', 503);
      const tasks: InternalTask[] = [];
      for (const [index, request] of requests.entries()) {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
          for (const entry of entries) {
            const inputPath = inputPaths[index]!;
            const command = entry.kind === 'llm' ? llmCommand(inputPath, llmFiles.get(entry.id)!) : renderCommand(kind === 'warmup' ? entry.warmupCommand! : entry.command, inputPath);
            tasks.push({
              entry, request, inputPath, command, output: null,
              snapshot: {
                id: randomUUID(), entryId: entry.id, entryName: entry.name, configuredMode: entry.mode,
                requestId: request.id, requestName: request.name, repetition, status: 'queued',
                startedAt: null, finishedAt: null, wallMs: null, result: null, error: null, progress: null, finishOrder: null,
              },
            });
          }
        }
      }
      const id = randomUUID();
      const run: InternalRun = {
        snapshot: { id, kind, status: 'queued', createdAt: new Date().toISOString(), finishedAt: null, concurrency, execution, repetitions, tasks: tasks.map((task) => task.snapshot), error: null },
        config, tasks, directory, controller: new AbortController(), done: Promise.resolve(),
      };
      this.#runs.set(id, run);
      this.#activeId = id;
      if (kind === 'comparison') this.#latestComparisonId = id;
      this.#prune();
      run.done = this.#execute(run);
      return this.get(id);
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.#starting = false;
    }
  }

  cancel(id: string): RunSnapshot {
    const run = this.#require(id);
    if (isRunActive(run.snapshot)) {
      run.controller.abort();
      for (const task of run.tasks) {
        if (task.snapshot.status === 'queued') {
          task.snapshot.status = 'cancelled';
          task.snapshot.finishedAt = new Date().toISOString();
          task.snapshot.error = 'Cancelled before invocation.';
        }
      }
      this.#publish(run);
    }
    return this.get(id);
  }

  async wait(id: string): Promise<RunSnapshot> {
    await this.#require(id).done;
    return this.get(id);
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#activeId) {
      const id = this.#activeId;
      this.cancel(id);
      await this.#require(id).done;
    }
    this.#events.removeAllListeners();
  }

  #require(id: string): InternalRun {
    const run = this.#runs.get(id);
    if (!run) throw new AppError('Run not found. Runs are kept in memory until the server restarts (up to 10 recent runs).', 404);
    return run;
  }

  #prune() {
    for (const id of this.#runs.keys()) {
      if (this.#runs.size <= 10) break;
      if (id !== this.#activeId && id !== this.#latestComparisonId) {
        this.#runs.delete(id);
        for (const [entryId, state] of Object.entries(this.#warmups)) {
          if (state.runId === id) delete this.#warmups[entryId];
        }
      }
    }
  }

  #reconcileWarmups(config: AppConfig) {
    for (const [id, state] of Object.entries(this.#warmups)) {
      const previous = this.#runs.get(state.runId);
      const task = previous?.tasks.find((candidate) => candidate.snapshot.id === state.taskId);
      const current = config.entries.find((entry) => entry.id === id);
      if (!task || !current || JSON.stringify(current) !== JSON.stringify(task.entry) || previous?.config.shell.executable !== config.shell.executable) {
        delete this.#warmups[id];
      }
    }
  }

  #publish(run: InternalRun) {
    if (run.snapshot.kind === 'warmup') {
      for (const { snapshot: task } of run.tasks) {
        this.#warmups[task.entryId] = { entryId: task.entryId, status: task.status, finishedAt: task.finishedAt, wallMs: task.wallMs, error: task.error, runId: run.snapshot.id, taskId: task.id };
      }
    }
    this.#events.emit(run.snapshot.id, { run: this.get(run.snapshot.id), warmups: structuredClone(this.#warmups) } satisfies RunEvent);
  }

  async #execute(run: InternalRun): Promise<void> {
    try {
      run.snapshot.status = 'running';
      this.#publish(run);
      const finishes = new Map<string, number>();
      const invoke = async (task: InternalTask) => {
        if (run.controller.signal.aborted) return;
        const snapshot = task.snapshot;
        snapshot.status = 'running';
        snapshot.startedAt = new Date().toISOString();
        this.#publish(run);
        try {
          const output = await runCommand({
            config: run.config, entry: task.entry, command: task.command, signal: run.controller.signal,
            onProgress: (line) => { snapshot.progress = line; this.#publish(run); },
          });
          task.output = output;
          snapshot.wallMs = output.wallMs;
          if (output.cancelled) {
            snapshot.status = 'cancelled';
            snapshot.error = 'Cancelled.';
          } else if (output.error || output.exitCode !== 0) {
            snapshot.status = 'error';
            snapshot.error = output.error ?? `Command exited with code ${String(output.exitCode)}${output.signal ? ` (${output.signal})` : ''}. Open output for details.`;
          } else {
            // A lifecycle warm-up such as --start can succeed without returning decisions.
            if (run.snapshot.kind === 'comparison') snapshot.result = normalizeResponse(output.stdout, task.entry.parser, task.request.payload);
            snapshot.status = 'success';
            if (run.snapshot.execution === 'race') {
              const group = JSON.stringify([snapshot.requestId, snapshot.repetition]);
              snapshot.finishOrder = (finishes.get(group) ?? 0) + 1;
              finishes.set(group, snapshot.finishOrder);
            }
          }
        } catch (error) {
          snapshot.status = run.controller.signal.aborted ? 'cancelled' : 'error';
          snapshot.error = error instanceof Error ? error.message : String(error);
        }
        snapshot.finishedAt = new Date().toISOString();
        snapshot.progress = null;
        this.#publish(run);
      };
      if (run.snapshot.execution === 'race') {
        // A shared start for each request/repetition. No entry gets a head start
        // on the next request while a slower contender is still finishing this one.
        for (let offset = 0; offset < run.tasks.length && !run.controller.signal.aborted; offset += run.snapshot.concurrency) {
          await Promise.all(run.tasks.slice(offset, offset + run.snapshot.concurrency).map(invoke));
        }
      } else {
        let next = 0;
        const worker = async () => {
          while (!run.controller.signal.aborted && next < run.tasks.length) await invoke(run.tasks[next++]!);
        };
        await Promise.all(Array.from({ length: Math.min(run.snapshot.concurrency, run.tasks.length) }, worker));
      }
    } catch (error) {
      run.snapshot.error = error instanceof Error ? error.message : String(error);
      for (const task of run.tasks) {
        if (task.snapshot.status === 'queued' || task.snapshot.status === 'running') {
          task.snapshot.status = 'error';
          task.snapshot.error = run.snapshot.error;
          task.snapshot.finishedAt = new Date().toISOString();
        }
      }
    } finally {
      try {
        await rm(run.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        run.snapshot.error = `Could not remove temporary request files: ${error instanceof Error ? error.message : String(error)}`;
      }
      run.snapshot.status = run.controller.signal.aborted ? 'cancelled' : 'completed';
      run.snapshot.finishedAt = new Date().toISOString();
      this.#activeId = null;
      this.#publish(run);
    }
  }
}
