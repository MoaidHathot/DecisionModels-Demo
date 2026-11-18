import { Braces, Check, ChevronRight, Copy, FileJson, Info, LoaderCircle, Settings2, Terminal, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Catalog, RequestInput, TaskDetail } from '../../shared/types.ts';
import { api, cleanOutput, duration, message, percent } from '../lib.ts';

export function Dialog({ title, eyebrow, onClose, children, className = '' }: { title: string; eyebrow: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={`dialog ${className}`} aria-labelledby={id} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <div className="dialog-heading"><div><span className="eyebrow">{eyebrow}</span><h2 id={id}>{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
    {children}
  </dialog>;
}

export function ConfigDialog({ catalog, onClose, onCopy }: { catalog: Catalog; onClose: () => void; onCopy: (value: string) => void }) {
  const [kind, setKind] = useState<'command' | 'llm'>('llm');
  const configuredLlm = catalog.entries.find((entry) => entry.llm)?.llm;
  const llmExample = {
    id: 'llm-comparison', name: 'LLM comparison', kind: 'llm',
    llm: configuredLlm ?? {
      provider: 'copilot', model: 'gpt-6-luna', reasoningEffort: 'low',
      systemPrompt: 'Classify the supplied state by answering every named question. Return the requested JSON schema. Probabilities are your own estimates. Distributions must sum to one; scores must equal the probability-weighted level index.',
    },
  };
  const commandExample = {
    id: 'laya-vega-sidecar', name: 'LocalLaya · Vega', mode: 'sidecar',
    command: 'LocalLaya --model vega --sidecar --port 8788 --file {input} --json',
    warmupCommand: 'LocalLaya --model vega --sidecar --port 8788 --file {input} --json',
    parser: 'locallaya',
  };
  const example = JSON.stringify(kind === 'llm' ? llmExample : commandExample, null, 2);
  return <Dialog title="Configuration" eyebrow="WORKSPACE" onClose={onClose}>
    <div className="dialog-body config-body">
      <div className="config-location"><Settings2 size={16} /><div><strong>Config file</strong><code>{catalog.configPath}</code></div></div>
      <p>Edit the file, then <strong>Reload</strong>. Each entry needs a unique id and name.</p>
      <div className="code-block-heading">
        <div className="segmented" role="group" aria-label="Configuration example"><button className={kind === 'llm' ? 'active' : ''} aria-pressed={kind === 'llm'} onClick={() => setKind('llm')}>LLM entry</button><button className={kind === 'command' ? 'active' : ''} aria-pressed={kind === 'command'} onClick={() => setKind('command')}>Command entry</button></div>
        <button className="text-button" onClick={() => onCopy(example)}><Copy size={12} /> Copy example</button>
      </div>
      <pre className="code-block">{example}</pre>
      <ul className="config-notes">
        <li><span><strong>LLM:</strong> <code>model</code>, <code>systemPrompt</code>, and <code>reasoningEffort</code> are applied to a fresh Copilot SDK session using your saved login. List supported models/efforts with <code>npm run models:llm</code>.</span></li>
        <li><span><strong>Commands:</strong> use an unquoted <code>{'{input}'}</code> argument. The runner quotes the file path. PowerShell profiles load by default.</span></li>
        <li><span><strong>Race:</strong> all selected entries launch together per request, up to <code>maxConcurrency</code> ({catalog.maxConcurrency}). The next request waits for the current race.</span></li>
        <li><span><strong>Warm-up:</strong> optional <code>warmupCommand</code> uses the first request. Use separate sidecar ports to keep different model configurations loaded.</span></li>
      </ul>
      <div className="config-location"><FileJson size={16} /><div><strong>Requests directory</strong><code>{catalog.requestsDirectory}</code></div></div>
      <p className="method-note"><Info size={13} /><span>Paths are relative to the config file. Full reference: <code>demo/README.md</code>.</span></p>
    </div>
  </Dialog>;
}

export function RequestDialog({ request, canUse, onClose, onUse, onCopy }: { request: RequestInput; canUse: boolean; onClose: () => void; onUse: (json: string) => void; onCopy: (value: string) => void }) {
  const json = JSON.stringify(request.payload, null, 2);
  return <Dialog title={request.name} eyebrow="REQUEST PREVIEW" onClose={onClose}>
    <div className="dialog-body"><div className="code-block-heading"><code>{request.id}</code><button className="text-button" onClick={() => onCopy(json)}><Copy size={13} /> Copy JSON</button></div><pre className="code-block input-preview">{json}</pre></div>
    <div className="dialog-footer"><span>Exactly this payload goes to every entry.</span><button className="button button-primary" disabled={!canUse} onClick={() => onUse(json)}><Braces size={15} /> Use in JSON editor</button></div>
  </Dialog>;
}

export function ResultDialog({ runId, taskId, refreshKey, onClose, onCopy }: { runId: string; taskId: string; refreshKey: string; onClose: () => void; onCopy: (value: string) => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState<'decisions' | 'output' | 'input' | 'settings'>('decisions');
  useEffect(() => {
    const controller = new AbortController();
    void api<TaskDetail>(`/api/runs/${runId}/tasks/${taskId}`, { signal: controller.signal }).then((data) => {
      setDetail(data);
      if (data.task.status === 'error') setPane('output');
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [runId, taskId, refreshKey]);
  const task = detail?.task;
  return <Dialog title={task?.entryName ?? 'Invocation details'} eyebrow={task ? `${task.requestName} · RUN ${task.repetition}` : 'INVOCATION'} onClose={onClose} className="result-dialog">
    {!detail ? <div className="dialog-body">{error ? <p className="error-message" role="alert">{error}</p> : <div className="loading-inline"><LoaderCircle size={18} className="spin" /> Loading invocation…</div>}</div> : <>
      <div className="detail-summary"><div><span>Status</span><strong className={task!.status === 'error' ? 'error-message' : ''}>{task!.status}{task!.finishOrder ? ` · #${task!.finishOrder}` : ''}</strong></div><div><span>End-to-end</span><strong>{duration(task!.wallMs)}</strong></div><div><span>Reported</span><strong title={task!.result?.reportedLabel}>{duration(task!.result?.reportedMs)}</strong></div><div><span>Returned model</span><strong>{task!.result?.model ?? 'Not returned'}</strong></div></div>
      {task!.error && <div className="detail-error" role="alert">{task!.error}</div>}
      <div className="detail-tabs segmented" role="group" aria-label="Invocation detail view"><button className={pane === 'decisions' ? 'active' : ''} aria-pressed={pane === 'decisions'} onClick={() => setPane('decisions')}><Check size={14} /> Decisions</button><button className={pane === 'output' ? 'active' : ''} aria-pressed={pane === 'output'} onClick={() => setPane('output')}><Terminal size={14} /> Raw output</button><button className={pane === 'input' ? 'active' : ''} aria-pressed={pane === 'input'} onClick={() => setPane('input')}><Braces size={14} /> Input</button>{detail.llm && <button className={pane === 'settings' ? 'active' : ''} aria-pressed={pane === 'settings'} onClick={() => setPane('settings')}><Settings2 size={14} /> LLM settings</button>}</div>
      <div className="dialog-body detail-body">
        {pane === 'decisions' ? task!.result ? <>
          <div className="execution-tags">{[task!.result.provider, task!.result.mode, task!.result.device, task!.result.execution, task!.result.reasoningEffort ? `${task!.result.reasoningEffort} reasoning` : null].filter(Boolean).map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>
          {task!.result.probabilitySource === 'llm-estimate' && <p className="method-note"><Info size={13} /><span>These probabilities are self-reported LLM estimates, not measured decision-model probabilities.</span></p>}
          {task!.result.warnings.map((warning) => <p className="inline-warning" key={warning}><Info size={14} />{warning}</p>)}
          {task!.result.decisions.map((decision) => <section key={decision.question} className="decision-detail"><div><span className="question-id">{decision.question} <span>· {decision.type}</span></span><h3>{decision.label}</h3>{decision.detail && <p>{decision.detail}</p>}</div><div className="distribution">
            {decision.distribution ? Object.entries(decision.distribution).map(([label, p]) => <div className="distribution-row" key={label}><span title={label}>{label}</span><div className="distribution-track"><span style={{ width: `${p * 100}%` }} /></div><strong>{percent(p)}</strong></div>) : <span className="cell-secondary">No distribution returned.</span>}
          </div></section>)}
          <p className="method-note"><Info size={14} /><span>Yes/no uses a 0.5 threshold. Probability is always P(yes), even for a “No”. Score labels show the most probable level; the fractional score is the expected level index.</span></p>
        </> : <div className="small-empty"><Terminal size={22} /><p>{task!.status === 'error' ? 'No usable decision returned.' : 'No decisions returned yet.'}</p><button className="text-button" onClick={() => setPane('output')}>Inspect output <ChevronRight size={13} /></button></div> : pane === 'settings' ? <><div className="code-block-heading"><strong>LLM settings used for this invocation</strong><button className="text-button" onClick={() => onCopy(JSON.stringify(detail.llm, null, 2))}><Copy size={12} /> Copy</button></div><pre className="code-block">{JSON.stringify(detail.llm, null, 2)}</pre></> : pane === 'input' ? <><div className="code-block-heading"><strong>Frozen request payload</strong><button className="text-button" onClick={() => onCopy(JSON.stringify(detail.request, null, 2))}><Copy size={12} /> Copy</button></div><pre className="code-block">{JSON.stringify(detail.request, null, 2)}</pre></> : <>
          <div className="code-block-heading"><strong>Invocation</strong><button className="text-button" onClick={() => onCopy(detail.command)}><Copy size={12} /> Copy</button></div><pre className="code-block command-block">{detail.command}</pre>
          <div className="code-block-heading"><strong>stdout</strong><span>Exit code: {detail.output?.exitCode ?? '—'}</span><button className="text-button" disabled={!detail.output?.stdout} onClick={() => onCopy(detail.output!.stdout)}><Copy size={12} /> Copy</button></div><pre className="code-block output-block">{detail.output?.stdout ? cleanOutput(detail.output.stdout) : 'No stdout captured.'}</pre>
          <div className="code-block-heading"><strong>stderr / diagnostics</strong></div><pre className="code-block output-block stderr-block">{detail.output?.stderr ? cleanOutput(detail.output.stderr) : 'No stderr captured.'}</pre>
          <p className="method-note"><Info size={14} /><span>Diagnostic messages on stderr can accompany a successful command. The exit code and parsed response determine success.</span></p>
        </>}
      </div>
    </>}
  </Dialog>;
}
