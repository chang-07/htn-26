import { useMemo, useState } from 'react';
import { sentryDetails, type SentryDetail } from '../shared/sentry-details';
import { operationLabel, type DiagnosticEvent } from '../shared/run-diagnostics';
import { clock } from './ui';

export function SentryDetails({ events, onPick }: { events: DiagnosticEvent[]; onPick: (seq: number) => void }) {
  const entries = useMemo(() => sentryDetails(events), [events]);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const recorded = entries.filter(entry => entry.eventId).length;
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(value); setCopyError(false); }
    catch { setCopyError(true); setCopied(null); }
  }
  function entry(detail: SentryDetail) {
    const { event, eventId, traceId, occurrences } = detail;
    const operation = operationLabel(String(event.fields.tool ?? event.fields.operation ?? event.event));
    const message = typeof event.fields.error === 'string' ? event.fields.error : typeof event.fields.errorType === 'string' ? event.fields.errorType : 'No error message was recorded for this event.';
    return <article className="rv-sentry-event" key={eventId ?? event.seq}>
      <div className="rv-sentry-event-heading"><strong>{operation}</strong><time>{clock(event.ts)}</time></div>
      <p className="rv-sentry-message">{message.length > 240 ? `${message.slice(0, 240)}…` : message}</p>
      <div className="rv-sentry-actions">
        <button className="rv-btn" onClick={() => onPick(event.seq)}>Inspect error →</button>
        {eventId ? <button className="rv-btn is-quiet" onClick={() => void copy(eventId)} aria-label={`Copy Sentry event ID ${eventId}`}>{copied === eventId ? 'Copied event ID' : 'Copy Sentry ID'}</button> : <span>No Sentry event ID recorded</span>}
        {occurrences > 1 && <span>{occurrences} related log entries</span>}
      </div>
      <details className="rv-sentry-identifiers"><summary>Identifiers & context</summary>
        {eventId && <div><span>Sentry event ID</span><code>{eventId}</code></div>}
        {traceId && <div><span>Trace ID</span><code>{traceId}</code><button className="rv-btn is-quiet" onClick={() => void copy(traceId)}>{copied === traceId ? 'Copied trace ID' : 'Copy trace ID'}</button></div>}
        {typeof event.fields.errorType === 'string' && <div><span>Error type</span><code>{event.fields.errorType}</code></div>}
        {message.length > 240 && <p>{message}</p>}
        {!eventId && !traceId && <p>No identifiers were recorded. Inspect the event for available context.</p>}
      </details>
    </article>;
  }
  return <section className={`rv-sentry${entries.length ? ' has-errors' : ''}`} aria-label="Sentry and errors">
    <header><strong>Sentry & errors</strong><span>{recorded ? `${recorded} Sentry event ID${recorded === 1 ? '' : 's'}` : 'No Sentry event IDs recorded'}</span></header>
    {entries.length ? <>
      {entry(entries[0])}
      {entries.length > 1 && <details className="rv-sentry-more"><summary>{entries.length - 1} more recorded error{entries.length === 2 ? '' : 's'}</summary><div>{entries.slice(1).map(entry)}</div></details>}
    </> : <p className="rv-sentry-empty">No errors in the loaded activity.</p>}
    <span className="rv-sentry-feedback" role="status">{copyError ? 'Couldn’t copy. Expand identifiers to select the value.' : copied ? 'Identifier copied to clipboard.' : ''}</span>
  </section>;
}
