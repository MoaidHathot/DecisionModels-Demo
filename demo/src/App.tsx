import { Check, CircleAlert, Flame, LoaderCircle, Play, RefreshCw, Settings2, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Catalog, ExecutionMode, RequestInput, RunEvent, RunSnapshot, RunsState, SampleRequest, WarmupState } from '../shared/types.ts';
import { isRecord, isRunActive } from '../shared/types.ts';
import { ApiError, api, colorAt, message, post } from './lib.ts';
import { ConfigDialog, RequestDialog, ResultDialog } from './components/Dialogs.tsx';
import Results from './components/Results.tsx';
import { EntryPicker, RequestPicker } from './components/Setup.tsx';

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selectedEntries, setSelectedEntries] = useState<string[] | null>(null);
  const [selectedRequests, setSelectedRequests] = useState<string[] | null>(null);
  const [source, setSource] = useState<'samples' | 'custom'>('samples');
  const [customJson, setCustomJson] = useState('');
  const [repetitions, setRepetitions] = useState(1);
  const [concurrency, setConcurrency] = useState(1);
  const [execution, setExecution] = useState<ExecutionMode>('race');
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [action, setAction] = useState<RunSnapshot | null>(null);
  const [warmups, setWarmups] = useState<Record<string, WarmupState>>({});
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [preview, setPreview] = useState<RequestInput | null>(null);
  const [detail, setDetail] = useState<{ runId: string; taskId: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const loadVersion = useRef(0);
  const running = isRunActive(action);
  const busy = loading || launching || running;

  const reload = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    try {
      const [nextCatalog, state] = await Promise.all([api<Catalog>('/api/catalog'), api<RunsState>('/api/runs')]);
      if (version !== loadVersion.current) return;
      setCatalog(nextCatalog);
      setRun(state.latestComparison);
      setAction(state.active);
      setWarmups(state.warmups);
      setError(null);
      setReconnecting(false);
      setCancelling(false);
      setSelectedEntries((previous) => previous?.filter((id) => nextCatalog.entries.some((entry) => entry.id === id)) ?? null);
      setSelectedRequests((previous) => previous?.filter((id) => nextCatalog.requests.some((request) => request.id === id && !request.error)) ?? null);
      setConcurrency((previous) => Math.min(previous, nextCatalog.maxConcurrency));
      if (state.active?.kind === 'comparison') {
        const active = state.active;
        setSelectedEntries([...new Set(active.tasks.map((task) => task.entryId))]);
        setRepetitions(active.repetitions);
        setConcurrency(active.concurrency);
        setExecution(active.execution);
        if (active.tasks[0]?.requestId === 'custom') {
          setSource('custom');
          const task = await api<{ request: Record<string, unknown> }>(`/api/runs/${active.id}/tasks/${active.tasks[0].id}`);
          if (version === loadVersion.current) setCustomJson(JSON.stringify(task.request, null, 2));
        } else {
          setSource('samples');
          setSelectedRequests([...new Set(active.tasks.map((task) => task.requestId))]);
        }
      }
    } catch (cause) {
      if (version === loadVersion.current) setError(message(cause));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); return () => { loadVersion.current++; }; }, [reload]);

  const applyRun = useCallback((next: RunSnapshot, nextWarmups?: Record<string, WarmupState>) => {
    setAction(next);
    if (nextWarmups) setWarmups(nextWarmups);
    else if (next.kind === 'warmup') setWarmups((previous) => ({
      ...previous,
      ...Object.fromEntries(next.tasks.map((task) => [task.entryId, {
        entryId: task.entryId, status: task.status, finishedAt: task.finishedAt,
        wallMs: task.wallMs, error: task.error, runId: next.id, taskId: task.id,
      }])),
    }));
    if (next.kind === 'comparison') setRun(next);
    if (!isRunActive(next)) {
      setCancelling(false);
      setReconnecting(false);
    }
    if (next.error) setError(next.error);
  }, []);

  useEffect(() => {
    if (!action || !running) return;
    const id = action.id;
    const events = new EventSource(`/api/runs/${id}/events`);
    let disposed = false;
    events.addEventListener('snapshot', (event: MessageEvent<string>) => {
      if (disposed) return;
      const data = JSON.parse(event.data) as RunEvent;
      setReconnecting(false);
      applyRun(data.run, data.warmups);
      if (!isRunActive(data.run)) events.close();
    });
    events.onerror = () => {
      if (disposed) return;
      setReconnecting(true);
      // Reconnecting receives a complete snapshot, so no result is lost between events.
      void api<RunSnapshot>(`/api/runs/${id}`).then((current) => {
        if (disposed) return;
        applyRun(current);
        if (!isRunActive(current)) {
          events.close();
        }
      }).catch((cause: unknown) => {
        if (!disposed && cause instanceof ApiError && cause.status === 404) {
          events.close();
          setAction(null);
          setRun(null);
          setWarmups({});
          setCancelling(false);
          setReconnecting(false);
          setError('The server no longer has this run, usually after a restart. Reload the workspace to start a new comparison.');
        }
      });
    };
    return () => { disposed = true; events.close(); };
  }, [action?.id, running, applyRun]);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const entryIds = selectedEntries ?? catalog?.entries.filter((entry) => entry.selected).map((entry) => entry.id) ?? [];
  const entryColors = useMemo(() => Object.fromEntries((catalog?.entries ?? []).map((entry, index) => [entry.id, colorAt(index)])), [catalog]);
  const requestIds = selectedRequests ?? catalog?.requests.filter((request) => !request.error).slice(0, 2).map((request) => request.id) ?? [];
  const warmable = catalog?.entries.filter((entry) => entryIds.includes(entry.id) && entry.warmupCommand).map((entry) => entry.id) ?? [];
  const customError = useMemo(() => {
    if (!customJson.trim()) return 'Paste a JSON request to begin.';
    if (new TextEncoder().encode(customJson).length > 1024 * 1024) return 'The request exceeds 1 MiB.';
    try { if (!isRecord(JSON.parse(customJson))) return 'The request must be a JSON object.'; }
    catch (cause) { return message(cause); }
    return null;
  }, [customJson]);
  const requestCount = source === 'custom' ? 1 : requestIds.length;
  const validInput = source === 'custom' ? !customError : requestCount > 0;
  const calls = entryIds.length * requestCount * repetitions;
  const raceOverLimit = execution === 'race' && entryIds.length > (catalog?.maxConcurrency ?? 8);

  async function launch(kind: 'comparison' | 'warmup') {
    if (busy) return;
    setLaunching(true);
    setCancelling(false);
    setError(null);
    try {
      const started = await post<RunSnapshot>('/api/runs', {
        kind,
        entryIds: kind === 'warmup' ? warmable : entryIds,
        ...(source === 'custom' ? { customJson } : { requestIds }),
        repetitions: kind === 'warmup' ? 1 : repetitions,
        execution: kind === 'warmup' ? 'sequential' : execution,
        concurrency: kind === 'warmup' || execution === 'sequential' ? 1 : execution === 'race' ? entryIds.length : concurrency,
      });
      setNow(Date.now());
      applyRun(started);
    } catch (cause) { setError(message(cause)); }
    finally { setLaunching(false); }
  }

  async function cancel() {
    if (!action || cancelling) return;
    setCancelling(true);
    try { applyRun(await post<RunSnapshot>(`/api/runs/${action.id}/cancel`, {})); }
    catch (cause) { setError(message(cause)); setCancelling(false); }
  }

  async function previewRequest(sample: SampleRequest) {
    try { setPreview(await api<RequestInput>(`/api/request?id=${encodeURIComponent(sample.id)}`)); }
    catch (cause) { setError(message(cause)); }
  }

  async function loadSample() {
    const id = requestIds[0] ?? catalog?.requests.find((sample) => !sample.error)?.id;
    if (!id) return;
    try {
      const request = await api<RequestInput>(`/api/request?id=${encodeURIComponent(id)}`);
      setCustomJson(JSON.stringify(request.payload, null, 2));
    } catch (cause) { setError(message(cause)); }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setToast('Copied'); }
    catch { setError('Could not access the clipboard. You can select and copy the text directly.'); }
  }

  const completed = action?.tasks.filter((task) => task.status !== 'queued' && task.status !== 'running').length ?? 0;
  const detailTask = detail ? [run, action].find((candidate) => candidate?.id === detail.runId)?.tasks.find((task) => task.id === detail.taskId) : null;

  return <>
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="site-header" id="top">
      <div className="header-inner">
        <a href="#top" className="brand"><img src="/favicon.svg" width="26" height="26" alt="" /><h1>Decision Lab</h1></a>
        <div className="header-actions">
          <span className="local-indicator"><span className={`status-dot ${catalog ? 'online' : ''}`} />Local</span>
          <button className="button button-quiet button-small" aria-label="Reload workspace" onClick={() => void reload()} disabled={busy} title="Reload config and requests"><RefreshCw size={14} className={loading ? 'spin' : ''} /><span>Reload</span></button>
          <button className="button button-quiet button-small" aria-label="Configure workspace" onClick={() => setConfigOpen(true)} disabled={!catalog}><Settings2 size={15} /><span>Configure</span></button>
        </div>
      </div>
    </header>
    <main id="workspace" className="workspace">
      {error && <div className="alert-banner" role="alert"><CircleAlert size={18} /><span>{error}</span><button className="icon-button" onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button></div>}
      {reconnecting && <div className="connection-banner" role="status"><LoaderCircle className="spin" size={15} />Reconnecting. The comparison continues on the server.</div>}
      {!catalog ? <div className="initial-state">{loading ? <><LoaderCircle size={22} className="spin" /><p>Loading configuration…</p></> : <><h2>Unable to load workspace</h2><p>Check the local server and configuration.</p><button className="button button-primary" onClick={() => void reload()}><RefreshCw size={15} /> Retry</button></>}</div> : <>
        <div className="setup-board">
          <EntryPicker entries={catalog.entries} selected={entryIds} onChange={setSelectedEntries} busy={busy} warmups={warmups} onWarmupDetail={(state) => setDetail({ runId: state.runId, taskId: state.taskId })} />
          <RequestPicker catalog={catalog} selected={requestIds} onChange={setSelectedRequests} source={source} onSource={setSource} customJson={customJson} onCustomJson={setCustomJson} customError={customError} busy={busy} onPreview={(sample) => void previewRequest(sample)} onLoadSample={() => void loadSample()} />
        </div>
        <section className="run-controls" aria-label="Run controls">
          <div className="run-options">
            <label><span>Execution</span><select aria-label="Execution mode" value={execution} disabled={busy} onChange={(event) => setExecution(event.target.value as ExecutionMode)} title="A parallel race launches all selected entries together for each request."><option value="race">Parallel race</option><option value="sequential">Sequential</option>{execution === 'parallel' && <option value="parallel">Parallel queue · {concurrency}</option>}</select></label>
            <label><span>Repeat</span><select aria-label="Repetitions" value={repetitions} disabled={busy} onChange={(event) => setRepetitions(Number(event.target.value))}>{[1, 2, 3, 5, 10].map((count) => <option value={count} key={count}>{count}×</option>)}</select></label>
            <span className="call-count" title={`${entryIds.length} entries × ${requestCount} requests × ${repetitions} repetitions`}><strong>{calls}</strong> {calls === 1 ? 'call' : 'calls'}</span>
          </div>
          <div className="run-buttons">
            <button className="button button-warmup" disabled={busy || !warmable.length || !validInput} onClick={() => void launch('warmup')} title="Warm selected persistent entries using the first request. Excluded from results."><Flame size={14} />Warm up</button>
            {running ? <button className="button button-stop" onClick={() => void cancel()} disabled={cancelling}>{cancelling ? <LoaderCircle size={14} className="spin" /> : <Square size={12} fill="currentColor" />}{cancelling ? 'Stopping…' : 'Stop run'}</button> : <button className="button button-primary button-run" disabled={busy || !entryIds.length || !validInput || calls > 200 || raceOverLimit} onClick={() => void launch('comparison')}>{launching ? <LoaderCircle size={14} className="spin" /> : <Play size={12} fill="currentColor" />}Run comparison</button>}
          </div>
        </section>
        {calls > 200 && <p className="inline-warning"><CircleAlert size={13} />Select at most 200 calls per batch.</p>}
        {raceOverLimit && <p className="inline-warning"><CircleAlert size={13} />A race starts every selected entry together. Select at most {catalog.maxConcurrency}, or increase maxConcurrency in the configuration.</p>}
        {action?.kind === 'warmup' && <div className="run-progress" role="status">
          {running ? <LoaderCircle size={13} className="spin" /> : action.tasks.some((task) => task.status === 'error') ? <CircleAlert size={13} /> : <Check size={13} />}
          <strong>{running ? 'Warming up' : action.status === 'cancelled' ? 'Warm-up stopped' : action.tasks.some((task) => task.status === 'error') ? 'Warm-up finished with issues' : 'Warm-up complete'}</strong>
          <span>{completed}/{action.tasks.length}</span>
          {running && <progress max={action.tasks.length} value={completed} aria-label="Warm-up progress" />}
          {!running && <button className="icon-button" onClick={() => setAction(null)} aria-label="Dismiss warm-up status"><X size={14} /></button>}
        </div>}
        <Results key={run?.id ?? 'empty'} run={run} now={now} entryColors={entryColors} onDetail={(runId, taskId) => setDetail({ runId, taskId })} />
      </>}
    </main>
    {catalog && configOpen && <ConfigDialog catalog={catalog} onClose={() => setConfigOpen(false)} onCopy={(value) => void copy(value)} />}
    {preview && <RequestDialog request={preview} canUse={!busy} onClose={() => setPreview(null)} onCopy={(value) => void copy(value)} onUse={(value) => { setCustomJson(value); setSource('custom'); setPreview(null); }} />}
    {detail && <ResultDialog key={detail.taskId} {...detail} refreshKey={detailTask?.finishedAt ?? detailTask?.status ?? ''} onClose={() => setDetail(null)} onCopy={(value) => void copy(value)} />}
    {toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}
  </>;
}
