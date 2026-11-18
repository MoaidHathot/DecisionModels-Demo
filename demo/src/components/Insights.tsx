import { ArrowDownRight, ChartNoAxesCombined, Info, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RunSnapshot } from '../../shared/types.ts';
import { answerAgreement, entryMetrics, median } from '../../shared/metrics.ts';
import { colorAt, duration, percent } from '../lib.ts';

export default function Insights({ run, entryColors }: { run: RunSnapshot | null; entryColors: Record<string, string> }) {
  const [metric, setMetric] = useState<'wall' | 'reported'>('wall');
  const entries = useMemo(() => entryMetrics(run), [run]);
  const agreement = useMemo(() => answerAgreement(run), [run]);
  const successes = run?.tasks.filter((task) => task.status === 'success') ?? [];
  if (!successes.length) return <div className="empty-state"><ChartNoAxesCombined size={22} /><p>Complete a comparison to see latency and agreement.</p></div>;
  const value = (entry: typeof entries[number]) => metric === 'wall' ? entry.medianWallMs : entry.medianReportedMs;
  const ranked = [...entries].sort((a, b) => (value(a) ?? Infinity) - (value(b) ?? Infinity));
  const max = Math.max(...entries.map((entry) => value(entry) ?? 0), 1);
  const requests = [...new Map(run!.tasks.map((task) => [task.requestId, task.requestName])).entries()];

  return <div className="insights">
    <div className="insights-top"><span>Successful invocations</span><div className="segmented compact" role="group" aria-label="Chart timing metric"><button className={metric === 'wall' ? 'active' : ''} aria-pressed={metric === 'wall'} onClick={() => setMetric('wall')}>End-to-end</button><button className={metric === 'reported' ? 'active' : ''} aria-pressed={metric === 'reported'} onClick={() => setMetric('reported')}>Tool-reported</button></div></div>
    <div className="chart-grid">
      <section className="chart-card" aria-label="Median latency by entry">
        <div className="chart-heading"><div><h3>Median latency</h3><p>Median {metric === 'wall' ? 'end-to-end' : 'tool-reported'} time per invocation</p></div><ArrowDownRight size={17} /></div>
        <div className="bar-chart">
          {ranked.map((entry, index) => <div className="bar-row" key={entry.id}>
            <div className="bar-label"><span><span className="legend-dot" style={{ background: entryColors[entry.id] ?? colorAt(entry.index) }} />{entry.name}{index === 0 && value(entry) !== null && <Trophy size={12} className="winner-icon" />}</span><strong>{duration(value(entry))}</strong></div>
            <div className="bar-track"><div className="bar-fill" style={{ width: `${value(entry) === null ? 0 : Math.max(0.5, value(entry)! / max * 100)}%`, background: entryColors[entry.id] ?? colorAt(entry.index) }} /></div>
            <div className="bar-caption"><span>{entry.successes} successful {entry.successes === 1 ? 'call' : 'calls'}{entry.failures ? ` · ${entry.failures} failed` : ''}</span>{metric === 'wall' && <span>{duration(entry.minMs)} – {duration(entry.maxMs)}</span>}</div>
          </div>)}
        </div>
        <p className="chart-footnote">Lower is faster. Failed and cancelled calls are excluded.</p>
      </section>
      <section className="chart-card agreement-card" aria-label="Answer agreement">
        <div className="chart-heading"><div><h3>Answer agreement</h3><p>Across selected entries</p></div></div>
        <div className="agreement-visual">
          <svg viewBox="0 0 160 160" role="img" aria-label={agreement.rate === null ? 'No complete comparisons yet' : `${percent(agreement.rate)} answer agreement`}>
            <circle className="ring-track" cx="80" cy="80" r="62" />
            <circle className="ring-value" cx="80" cy="80" r="62" pathLength="100" strokeDasharray={`${(agreement.rate ?? 0) * 100} 100`} transform="rotate(-90 80 80)" />
            <text x="80" y="78" className="ring-number">{agreement.rate === null ? '—' : `${Math.round(agreement.rate * 100)}%`}</text>
            <text x="80" y="99" className="ring-caption">agreement</text>
          </svg>
          <div className="agreement-copy"><strong>{agreement.comparable ? `${agreement.agreeing} of ${agreement.comparable}` : 'No paired results'}</strong><p>{agreement.comparable ? 'question groups returned the same decision.' : 'Complete a shared request with two or more entries.'}</p></div>
        </div>
        <p className="chart-footnote">Complete groups only, matched by request and repetition. Scores use the top level. Agreement is not accuracy.</p>
      </section>
    </div>
    <section className="chart-card breakdown-card" aria-label="Latency by request">
      <div className="chart-heading"><div><h3>Latency by request</h3><p>Median per request; fastest highlighted.</p></div><span className="subtle-label">{metric === 'wall' ? 'END-TO-END' : 'TOOL-REPORTED'}</span></div>
      <div className="table-scroll"><table className="heatmap"><thead><tr><th>Request</th>{entries.map((entry) => <th key={entry.id}><span className="legend-dot" style={{ background: entryColors[entry.id] ?? colorAt(entry.index) }} />{entry.name}</th>)}</tr></thead><tbody>
        {requests.map(([id, name]) => {
          const values = entries.map((entry) => median(successes.filter((task) => task.entryId === entry.id && task.requestId === id).flatMap((task) => { const ms = metric === 'wall' ? task.wallMs : task.result?.reportedMs; return ms == null ? [] : [ms]; })));
          const fastest = Math.min(...values.filter((ms): ms is number => ms !== null));
          return <tr key={id}><th scope="row">{name}</th>{entries.map((entry, index) => <td key={entry.id}><span className={values[index] === fastest ? 'heatmap-value fastest' : 'heatmap-value'}>{values[index] === fastest && <Trophy size={12} />}{duration(values[index])}</span></td>)}</tr>;
        })}
      </tbody></table></div>
    </section>
    <p className="method-note"><Info size={13} /><span>{metric === 'wall' ? 'End-to-end includes shell, runtime startup, response, and teardown. Warm-ups are excluded.' : 'Reported clocks differ: Copilot CLI request, LocalLaya inference, and LLM SDK request time.'}{run!.concurrency > 1 ? ' Parallel entries share resources.' : ''}</span></p>
  </div>;
}
