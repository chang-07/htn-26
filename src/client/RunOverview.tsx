import { useMemo } from 'react';
import type { RunSummary } from '../server/runs';
import { diagnose, operationLabel, type DiagnosticEvent } from '../shared/run-diagnostics';
import { runStatus } from '../shared/run-status';
import { dur, clock } from './ui';
import { SentryDetails } from './SentryDetails';

export function RunOverview({ run, events, onPick }: { run: RunSummary; events: DiagnosticEvent[]; onPick: (seq: number) => void }) {
  const status = runStatus(run);
  const diagnostics = useMemo(() => diagnose(events), [events]);
  const pending = diagnostics.pending.filter(event => !['agent', 'workflow', 'workflow.step'].includes(String(event.fields.op)));
  const latest = events.at(-1);
  const lastReply = [...events].reverse().find(event => event.event === 'message.out' && typeof event.fields.text === 'string');
  const operation = (event: DiagnosticEvent) => operationLabel(String(event.fields.tool ?? event.fields.operation ?? event.event));
  const elapsed = Math.max(0, (run.ended ?? latest?.ts ?? run.started) - run.started);
  return <section className={`rv-overview is-${status.key}`} aria-label="Run summary">
    <div className="rv-overview-heading"><span className={`rv-status is-${status.key}`}>{status.label}</span><span>{latest ? `Last event ${clock(latest.ts)}` : 'Waiting for recorded events'}</span></div>
    <h2>{status.key === 'active' ? 'What’s happening now' : 'What happened'}</h2>
    <p>{status.description}</p>
    <SentryDetails events={events} onPick={onPick} />
    {status.key === 'active' && <div className="rv-current-work" aria-live="polite">
      {pending.length ? <><strong>Started; no completion recorded yet</strong>{pending.slice(-3).map(event => <button key={event.seq} onClick={() => onPick(event.seq)}>{operation(event)} <span>Inspect →</span></button>)}{pending.length > 3 && <small>Plus {pending.length - 3} other operations</small>}</> : <span>Waiting for the next recorded activity.</span>}
    </div>}
    <div className="rv-overview-metrics">
      <div><span>{run.ended === null ? 'Recorded duration' : 'Total duration'}</span><strong>{dur(elapsed)}</strong></div>
      <div><span>Tool types used</span><strong>{new Set(run.tools).size}</strong></div>
      <div><span>Error events</span><strong>{diagnostics.errors.length || (run.level === 'error' ? 'Details pending' : '0')}</strong></div>
    </div>
    {lastReply && <details className="rv-reply"><summary>Read Whim’s last reply</summary><p>{String(lastReply.fields.text)}</p></details>}
  </section>;
}
