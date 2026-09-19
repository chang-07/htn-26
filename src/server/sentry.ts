import * as Sentry from "@sentry/cloudflare";
import { telemetryAdapter } from "./telemetry";
import { metadata } from "./sentry-options";
export { sentryOptions } from "./sentry-options";

telemetryAdapter.identity = () => {
  const span = Sentry.getActiveSpan();
  if (!span || !Sentry.isEnabled()) return {};
  const sc = span.spanContext();
  return { traceId: sc.traceId, spanId: sc.spanId };
};
telemetryAdapter.httpStatus = (status) => {
  const span = Sentry.getActiveSpan();
  if (span) Sentry.setHttpStatus(span, status);
};
telemetryAdapter.span = (name, op, fields, run) => Sentry.startSpan({ name, op, attributes: metadata(fields) }, run);
const captured = new WeakMap<object, string>();
telemetryAdapter.error = (error, fields) => {
  if (!Sentry.isEnabled()) return;
  if (typeof error === "object" && error !== null && captured.has(error)) return captured.get(error);
  const eventId = Sentry.captureException(error, { tags: { operation: String(fields.operation), traceId: String(fields.traceId) } });
  if (typeof error === "object" && error !== null) captured.set(error, eventId);
  return eventId;
};
telemetryAdapter.event = (level, event, fields) => {
  if (!Sentry.isEnabled()) return;
  const data = metadata(fields);
  Sentry.logger[level](event, data);
  // Capture the failed leaf operation once; parent spans and turn summaries stay logs.
  if (level === "error" && event !== "trace.end" && !fields.sentryEventId) {
    return Sentry.captureMessage(event, { level: "error", tags: { operation: event, traceId: String(fields.traceId ?? "") }, extra: data });
  }
};

export { Sentry };
