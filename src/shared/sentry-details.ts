import type { DiagnosticEvent } from './run-diagnostics';

export type SentryDetail = { event: DiagnosticEvent; eventId?: string; traceId?: string; occurrences: number };
const identifier = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** A captured exception can appear on multiple spans; show its event ID once. */
export function sentryDetails(events: DiagnosticEvent[]): SentryDetail[] {
  const grouped = new Map<string, SentryDetail>();
  for (const event of [...events].sort((a, b) => a.ts - b.ts || a.seq - b.seq)) {
    const eventId = identifier(event.fields.sentryEventId);
    if (!eventId && event.level !== 'error' && event.fields.status !== 'error') continue;
    const key = eventId ? `sentry:${eventId}` : `event:${event.seq}`;
    const prior = grouped.get(key);
    // Keep the most recent useful error message if a parent span has only an ID.
    const representative = !event.fields.error && prior?.event.fields.error ? prior.event : event;
    grouped.set(key, { event: representative, eventId, traceId: identifier(representative.fields.traceId) ?? prior?.traceId, occurrences: (prior?.occurrences ?? 0) + 1 });
  }
  return [...grouped.values()].sort((a, b) => b.event.ts - a.event.ts || b.event.seq - a.event.seq);
}
