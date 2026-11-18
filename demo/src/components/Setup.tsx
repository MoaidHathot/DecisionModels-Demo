import { Braces, Check, ChevronDown, Cloud, Cpu, Eye, Flame, FolderOpen, Search, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Catalog, PublicEntry, SampleRequest, WarmupState } from '../../shared/types.ts';
import { colorAt, duration, timeOf } from '../lib.ts';

interface EntryPickerProps {
  entries: PublicEntry[];
  selected: string[];
  onChange: (ids: string[]) => void;
  busy: boolean;
  warmups: Record<string, WarmupState>;
  onWarmupDetail: (state: WarmupState) => void;
}

export function EntryPicker({ entries, selected, onChange, busy, warmups, onWarmupDetail }: EntryPickerProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return <section className="setup-panel contenders" aria-labelledby="contenders-title">
    <div className="panel-heading">
      <div><h2 id="contenders-title">Models</h2><span className="count-badge">{selected.length}/{entries.length}</span></div>
      <button className="text-button" disabled={busy} onClick={() => onChange(selected.length === entries.length ? [] : entries.map((entry) => entry.id))}>{selected.length === entries.length ? 'Clear' : 'Select all'}</button>
    </div>
    <div className="entry-list">
      {entries.map((entry, index) => {
        const warmup = warmups[entry.id];
        const Icon = entry.kind === 'llm' || entry.parser === 'llm' ? Sparkles : entry.mode === 'cloud' ? Cloud : Cpu;
        return <div key={entry.id} className={`entry-card ${selected.includes(entry.id) ? 'selected' : ''}`} style={{ '--entry-color': colorAt(index) } as CSSProperties}>
          <div className="entry-row">
            <label className="entry-select" title={entry.description}>
              <input type="checkbox" checked={selected.includes(entry.id)} disabled={busy} onChange={() => toggle(entry.id)} aria-label={`Select ${entry.name}`} />
              <Icon size={15} className="entry-icon" />
              <span className="entry-copy"><span className="entry-name">{entry.name}</span>{entry.llm && <code className="entry-model">{entry.llm.model} · {entry.llm.reasoningEffort ?? 'default'}</code>}</span>
            </label>
            {warmup && <button className={`warmup-state warmup-${warmup.status}`} onClick={() => onWarmupDetail(warmup)} aria-label={`Warm-up details for ${entry.name}`} title={warmup.status === 'success' ? `Warmed ${timeOf(warmup.finishedAt)} · ${duration(warmup.wallMs)}. A past check; sidecars can idle out.` : warmup.error ?? `Warm-up: ${warmup.status}`}>
              {warmup.status === 'success' ? <Check size={13} /> : <Flame size={13} />}
            </button>}
            <span className="mode-tag">{entry.kind === 'llm' || entry.parser === 'llm' ? 'LLM' : entry.mode}</span>
            <button className={`icon-button entry-expand ${expanded === entry.id ? 'expanded' : ''}`} aria-label={`Invocation settings for ${entry.name}`} aria-expanded={expanded === entry.id} aria-controls={`entry-settings-${entry.id}`} onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}><ChevronDown size={14} /></button>
          </div>
          {expanded === entry.id && <div className="entry-settings" id={`entry-settings-${entry.id}`}>
            <pre>{entry.llm ? JSON.stringify(entry.llm, null, 2) : entry.command}</pre>
            {entry.warmupCommand && <p>Warm-up: <code>{entry.warmupCommand}</code></p>}
          </div>}
        </div>;
      })}
    </div>
  </section>;
}

interface RequestPickerProps {
  catalog: Catalog;
  selected: string[];
  onChange: (ids: string[]) => void;
  source: 'samples' | 'custom';
  onSource: (source: 'samples' | 'custom') => void;
  customJson: string;
  onCustomJson: (value: string) => void;
  customError: string | null;
  busy: boolean;
  onPreview: (sample: SampleRequest) => void;
  onLoadSample: () => void;
}

export function RequestPicker({ catalog, selected, onChange, source, onSource, customJson, onCustomJson, customError, busy, onPreview, onLoadSample }: RequestPickerProps) {
  const [query, setQuery] = useState('');
  const available = catalog.requests.filter((sample) => !sample.error);
  const visible = catalog.requests.filter((sample) => `${sample.name} ${sample.description} ${sample.id}`.toLowerCase().includes(query.toLowerCase()));
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return <section className="setup-panel requests" aria-labelledby="requests-title">
    <div className="panel-heading request-heading">
      <h2 id="requests-title">Requests</h2>
      <div className="segmented" role="group" aria-label="Request source">
        <button aria-pressed={source === 'samples'} className={source === 'samples' ? 'active' : ''} disabled={busy} onClick={() => onSource('samples')}><FolderOpen size={13} /> Samples</button>
        <button aria-pressed={source === 'custom'} className={source === 'custom' ? 'active' : ''} disabled={busy} onClick={() => onSource('custom')}><Braces size={13} /> Paste JSON</button>
      </div>
      {source === 'samples' && <button className="text-button" disabled={busy || !available.length} onClick={() => onChange(selected.length === available.length ? [] : available.map((sample) => sample.id))}>{selected.length === available.length ? 'Clear' : 'Select all'}</button>}
    </div>
    {source === 'samples' ? <>
      {catalog.requests.length > 6 && <label className="search-box request-search"><Search size={14} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a request" aria-label="Find a request" /></label>}
      <div className="sample-grid">
        {visible.map((sample) => <div key={sample.id} className={`sample-card ${selected.includes(sample.id) ? 'selected' : ''} ${sample.error ? 'invalid' : ''}`} title={sample.error ?? sample.description}>
          <label>
            <input type="checkbox" checked={selected.includes(sample.id)} disabled={busy || Boolean(sample.error)} onChange={() => toggle(sample.id)} aria-label={`Select ${sample.name}`} />
            <span className="sample-copy"><span className="sample-name">{sample.name}</span><span className="sample-meta">{sample.error ? 'Invalid JSON' : `${sample.questionCount} ${sample.questionCount === 1 ? 'question' : 'questions'}`}</span></span>
          </label>
          <button className="icon-button preview-button" aria-label={`Preview ${sample.name}`} title="Preview JSON" onClick={() => onPreview(sample)} disabled={Boolean(sample.error)}><Eye size={14} /></button>
        </div>)}
        {!visible.length && <div className="small-empty"><p>{query ? 'No matching requests.' : 'Add JSON files to the requests directory, then reload.'}</p>{query && <button className="text-button" onClick={() => setQuery('')}>Clear search</button>}</div>}
      </div>
      <div className="directory-hint" title={catalog.requestsDirectory}><code>{catalog.requestsDirectory.split(/[\\/]/).at(-1)}/</code><span>{selected.length} selected</span></div>
    </> : <div className="json-editor">
      <div className="editor-heading"><code>request.json</code><button className="text-button" disabled={busy || !available.length} onClick={onLoadSample}>Use a sample</button></div>
      <textarea aria-label="Custom request JSON" spellCheck={false} value={customJson} disabled={busy} onChange={(event) => onCustomJson(event.target.value)} placeholder={'{\n  "state": "Your evidence",\n  "questions": {\n    "decision": {\n      "type": "predicate",\n      "instructions": "What should the model decide?"\n    }\n  }\n}'} />
      <div className={`editor-status ${customJson.trim() ? customError ? 'invalid' : 'valid' : ''}`} aria-live="polite">{customJson.trim() ? customError ? <><X size={12} /><span>{customError}</span></> : <><Check size={12} /><span>Valid JSON</span></> : <span>Paste a JSON request object.</span>}</div>
    </div>}
  </section>;
}
