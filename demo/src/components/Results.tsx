import { ArrowDown, ArrowUp, Check, ChevronRight, CircleAlert, Download, Ellipsis, Info, LoaderCircle, Search, Table2, ChartNoAxesCombined, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Decision, RunSnapshot, TaskSnapshot } from '../../shared/types.ts';
import { isRunActive } from '../../shared/types.ts';
import { entryMetrics, median } from '../../shared/metrics.ts';
import { colorAt, duration, percent } from '../lib.ts';
import Insights from './Insights.tsx';

const groupKey = (task: TaskSnapshot) => JSON.stringify([task.requestId, task.repetition]);

function Status({ status }: { status: TaskSnapshot['status'] }) {
  const Icon = status === 'running' ? LoaderCircle : status === 'success' ? Check : status === 'error' ? CircleAlert : status === 'cancelled' ? X : Ellipsis;
  return <span className={`task-status status-${status}`}><Icon size={11} className={status === 'running' ? 'spin' : ''} />{status === 'success' ? 'Done' : status === 'error' ? 'Failed' : status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

function Probability({ decision }: { decision: Decision }) {
  return <div className="probability-line" title={decision.probabilityLabel.startsWith('Est.') ? 'Self-reported LLM estimate, not a measured model probability.' : decision.probabilityLabel}>
    <strong>{percent(decision.probability)}</strong><small>{decision.probabilityLabel}</small>
  </div>;
}

function tabKey(event: KeyboardEvent, change: (view: 'table' | 'insights') => void) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 'table' : event.key === 'End' ? 'insights' : event.currentTarget.id === 'table-tab' ? 'insights' : 'table';
  change(next);
  document.getElementById(`${next}-tab`)?.focus();
}

export default function Results({ run, now, onDetail, entryColors }: {
  run: RunSnapshot | null;
  now: number;
  onDetail: (runId: string, taskId: string) => void;
  entryColors: Record<string, string>;
}) {
  const [view, setView] = useState<'table' | 'insights'>('table');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<'order' | 'finish' | 'fastest' | 'slowest'>(run?.execution === 'race' ? 'finish' : 'order');
  const entries = useMemo(() => entryMetrics(run), [run]);
  const successes = run?.tasks.filter((task) => task.status === 'success') ?? [];
  const failures = run?.tasks.filter((task) => task.status === 'error').length ?? 0;
  const elapsed = median(successes.flatMap((task) => task.wallMs === null ? [] : [task.wallMs]));
  const groups = new Map<string, number>();
  for (const task of run?.tasks ?? []) if (!groups.has(groupKey(task))) groups.set(groupKey(task), groups.size);
  const visible = (run?.tasks ?? []).filter((task) => {
    const matchesStatus = filter === 'all' || task.status === filter;
    const text = `${task.requestName} ${task.entryName} ${task.result?.model ?? ''} ${task.result?.decisions.map((decision) => `${decision.question} ${decision.label}`).join(' ') ?? ''}`;
    return matchesStatus && text.toLowerCase().includes(query.toLowerCase());
  });
  if (sort === 'finish') visible.sort((a, b) => {
    const group = groups.get(groupKey(a))! - groups.get(groupKey(b))!;
    return group || (a.finishOrder ?? Infinity) - (b.finishOrder ?? Infinity) || 0;
  });
  else if (sort !== 'order') visible.sort((a, b) => {
    if (a.wallMs === null) return b.wallMs === null ? 0 : 1;
    if (b.wallMs === null) return -1;
    return sort === 'fastest' ? a.wallMs - b.wallMs : b.wallMs - a.wallMs;
  });
  const active = isRunActive(run);
  const status = !run ? 'Ready' : active ? 'Running' : run.status === 'cancelled' ? 'Stopped' : failures ? `Finished · ${failures} failed` : 'Complete';

  return <section className="results-section" aria-labelledby="results-title" data-run-id={run?.id}>
    <h2 id="results-title" className="sr-only">Results</h2>
    <div className="results-panel">
      <div className="results-toolbar">
        <div className="result-tabs" role="tablist" aria-label="Results view">
          <button role="tab" id="table-tab" aria-selected={view === 'table'} aria-controls="table-panel" tabIndex={view === 'table' ? 0 : -1} onClick={() => setView('table')} onKeyDown={(event) => tabKey(event, setView)}><Table2 size={14} /> Results table{run && <span>{run.tasks.length}</span>}</button>
          <button role="tab" id="insights-tab" aria-selected={view === 'insights'} aria-controls="insights-panel" tabIndex={view === 'insights' ? 0 : -1} onClick={() => setView('insights')} onKeyDown={(event) => tabKey(event, setView)}><ChartNoAxesCombined size={15} /> Insights</button>
        </div>
        <div className="results-actions">
          <span className={`run-badge ${active ? 'live' : run ? failures ? 'has-errors' : 'complete' : ''}`} role="status">{active ? <LoaderCircle size={11} className="spin" /> : run && !failures ? <Check size={11} /> : <span className="status-dot" />}{status}</span>
          {run ? <a className="button button-small button-quiet" href={`/api/runs/${run.id}/export`} download aria-label="Export JSON"><Download size={14} /><span className="export-label">Export</span></a> : <button className="button button-small button-quiet" disabled aria-label="Export JSON"><Download size={14} /><span className="export-label">Export</span></button>}
        </div>
      </div>
      {run && <div className="results-summary">
        <span><strong>{successes.length}/{run.tasks.length}</strong> successful{failures ? ` · ${failures} failed` : ''}</span>
        <span>Median <strong>{duration(elapsed)}</strong></span>
        <span className="execution-summary" title={run.execution === 'race' ? 'All entries start together for each request and repetition. The next request waits for the current race.' : 'Execution mode used by this run.'}>{run.execution === 'race' ? `Parallel race · ${run.concurrency} entries` : run.concurrency > 1 ? `Parallel queue · ${run.concurrency}` : 'Sequential'}</span>
      </div>}
      {view === 'table' ? <div id="table-panel" role="tabpanel" aria-labelledby="table-tab">
        {run && <div className="table-filters">
          <label className="search-box"><Search size={14} /><input type="search" aria-label="Filter results" placeholder="Filter requests, models, decisions" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <select aria-label="Result status" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All results</option><option value="success">Successful</option><option value="error">Failed</option></select>
        </div>}
        {!run ? <div className="empty-state"><Table2 size={22} /><p>Select models and requests, then run a comparison.</p></div> : <>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Scrollable comparison results">
            <table className="results-table">
              <thead><tr>
                <th aria-sort={sort === 'finish' ? 'ascending' : 'none'}><button className="sort-button" disabled={run.execution !== 'race'} onClick={() => setSort(sort === 'finish' ? 'order' : 'finish')} title="Successful finish order within each request and repetition">Finish{sort === 'finish' && <ArrowUp size={11} />}</button></th>
                <th>Request</th><th>Entry / returned model</th><th>Decision</th>
                <th title="P(yes), P(selected choice), or P(top score level). Est. indicates an LLM self-estimate.">Probability <Info size={11} /></th>
                <th aria-sort={sort === 'fastest' ? 'ascending' : sort === 'slowest' ? 'descending' : 'none'}><button className="sort-button" onClick={() => setSort(sort === 'fastest' ? 'slowest' : 'fastest')}>End-to-end{sort === 'fastest' ? <ArrowUp size={11} /> : sort === 'slowest' ? <ArrowDown size={11} /> : null}</button></th>
                <th title="The tool's own timing scope; excludes some startup overhead.">Reported</th><th><span className="sr-only">Details</span></th>
              </tr></thead>
              <tbody>{visible.map((task, rowIndex) => {
                const index = entries.findIndex((entry) => entry.id === task.entryId);
                const result = task.result;
                const meta = [result?.mode ?? task.configuredMode, result?.device, result?.reasoningEffort ? `${result.reasoningEffort} reasoning` : null].filter(Boolean).join(' · ');
                const groupStart = rowIndex > 0 && groupKey(visible[rowIndex - 1]!) !== groupKey(task);
                return <tr key={task.id} className={`result-row row-${task.status} ${groupStart ? 'group-start' : ''}`} data-testid="result-row">
                  <td><span className={`finish-position ${task.finishOrder === 1 ? 'first' : ''}`} data-testid="finish-order" title="Finish position for this request/repetition">{task.finishOrder ? `#${task.finishOrder}` : '—'}</span></td>
                  <td><span className="request-cell-name">{task.requestName}</span><div className="request-cell-meta"><Status status={task.status} />{run.repetitions > 1 && <span className="repetition">Run {task.repetition}</span>}</div></td>
                  <td>
                    <span className="table-entry"><span className="legend-dot" style={{ background: entryColors[task.entryId] ?? colorAt(index) }} /><span>{task.entryName}</span>{result?.probabilitySource === 'llm-estimate' && <span className="llm-tag">LLM</span>}</span>
                    {result?.model && <code className="returned-model" title={result.model}>{result.model}</code>}
                    <span className="cell-secondary">{meta}</span>
                  </td>
                  {result ? <>
                    <td><div className="answer-stack">{result.decisions.map((decision) => <div className="decision-line" key={decision.question}>
                      <span className="question-id" title={decision.question}>{decision.question}</span>
                      <span className={`decision-value type-${decision.type} ${decision.value === false ? 'negative' : ''}`} title={decision.detail ?? decision.label}>{decision.label}</span>
                      {decision.type === 'score' && <small title={decision.detail ?? ''}>{Number(decision.value).toFixed(2)}</small>}
                    </div>)}</div></td>
                    <td><div className="answer-stack">{result.decisions.map((decision) => <Probability key={decision.question} decision={decision} />)}</div></td>
                  </> : <td colSpan={2}><div className={`pending-answer ${task.status === 'error' ? 'error-message' : ''}`}>{task.status === 'running' ? <LoaderCircle size={13} className="spin" /> : task.status === 'error' ? <CircleAlert size={13} /> : null}<span>{task.status === 'running' ? task.progress ?? 'Waiting for response…' : task.status === 'queued' ? 'Queued' : task.error ?? 'Cancelled'}</span></div></td>}
                  <td><span className={`timing-value ${task.status === 'running' ? 'timing-live' : ''}`}>{task.status === 'running' && task.startedAt ? duration(Math.max(0, now - Date.parse(task.startedAt))) : duration(task.wallMs)}</span></td>
                  <td title={result?.reportedLabel}><span className="timing-value reported">{duration(result?.reportedMs)}</span>{result && <span className="cell-secondary">{result.provider === 'LocalLaya' ? 'inference' : result.probabilitySource === 'llm-estimate' ? 'LLM request' : 'CLI request'}</span>}</td>
                  <td><div className="row-actions">{Boolean(result?.warnings.length) && <span className="result-warning" title={result!.warnings.join(' ')} aria-label={`${result!.warnings.length} result notes`}><CircleAlert size={13} /></span>}<button className="icon-button details-button" aria-label={`View details for ${task.entryName}, ${task.requestName}, repetition ${task.repetition}`} onClick={() => onDetail(run.id, task.id)}><ChevronRight size={16} /></button></div></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          {!visible.length && <div className="filter-empty">No matching results. <button className="text-button" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button></div>}
          <div className="table-footer"><span>One row per invocation · end-to-end includes startup</span><span>{run.execution === 'race' ? 'Finish ranks are per request / repetition · ' : ''}Est. = LLM probability estimate</span></div>
        </>}
      </div> : <div id="insights-panel" role="tabpanel" aria-labelledby="insights-tab"><Insights run={run} entryColors={entryColors} /></div>}
    </div>
  </section>;
}
