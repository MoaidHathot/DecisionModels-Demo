import type { RunSnapshot, TaskSnapshot } from './types.ts';

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface EntryMetrics {
  id: string;
  name: string;
  index: number;
  successes: number;
  failures: number;
  total: number;
  medianWallMs: number | null;
  medianReportedMs: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export function entryMetrics(run: RunSnapshot | null): EntryMetrics[] {
  if (!run || run.kind === 'warmup') return [];
  const groups = new Map<string, TaskSnapshot[]>();
  for (const task of run.tasks) groups.set(task.entryId, [...(groups.get(task.entryId) ?? []), task]);
  return [...groups.entries()].map(([id, tasks], index) => {
    const successes = tasks.filter((task) => task.status === 'success');
    const walls = successes.flatMap((task) => task.wallMs === null ? [] : [task.wallMs]);
    const reported = successes.flatMap((task) => task.result?.reportedMs == null ? [] : [task.result.reportedMs]);
    return {
      id, name: tasks[0]!.entryName, index,
      successes: successes.length, failures: tasks.filter((task) => task.status === 'error').length, total: tasks.length,
      medianWallMs: median(walls), medianReportedMs: median(reported), minMs: walls.length ? Math.min(...walls) : null, maxMs: walls.length ? Math.max(...walls) : null,
    };
  });
}

export function answerAgreement(run: RunSnapshot | null): { agreeing: number; comparable: number; rate: number | null } {
  let agreeing = 0;
  let comparable = 0;
  const groups = new Map<string, TaskSnapshot[]>();
  for (const task of run?.kind === 'comparison' ? run.tasks : []) {
    const key = JSON.stringify([task.requestId, task.repetition]);
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  for (const tasks of groups.values()) {
    if (new Set(tasks.map((task) => task.entryId)).size < 2 || tasks.some((task) => task.status !== 'success' || !task.result)) continue;
    for (const decision of tasks[0]!.result!.decisions) {
      const peers = tasks.map((task) => task.result!.decisions.find((candidate) => candidate.question === decision.question));
      if (peers.some((peer) => !peer || peer.type === 'refused')) continue;
      comparable++;
      // Scores compare the most probable level, while retaining the expected score in the table.
      const values = peers.map((peer) => JSON.stringify([peer!.type, peer!.type === 'score' ? peer!.label : peer!.value]));
      if (new Set(values).size === 1) agreeing++;
    }
  }
  return { agreeing, comparable, rate: comparable ? agreeing / comparable : null };
}
