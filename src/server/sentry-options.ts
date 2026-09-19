import type { CloudflareOptions } from "@sentry/cloudflare";
import { safeFields, type TelemetryFields } from "./telemetry.ts";

// External telemetry is metadata only, independent of LOG_BODIES in the local viewer.
const allowed = /^(traceId|spanId|parentSpanId|runId|operation|op|status|errorType|model|profile|provider|tool|scope|stage|workflow|attempt|step|ms|started|tokens|inputTokens|outputTokens|cachedTokens|reasoningTokens|promptChars|responseChars|finishReason|requestId|statusCode|retryable|sentryEventId)$/;
export function metadata(fields: TelemetryFields) {
  return Object.fromEntries(Object.entries(safeFields(fields)).filter(([k, v]) => allowed.test(k) && ["string", "number", "boolean"].includes(typeof v))) as Record<string, string | number | boolean>;
}

export function sentryOptions(env: Env): CloudflareOptions {
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0.2");
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    environment: env.SENTRY_ENVIRONMENT || "development",
    release: env.SENTRY_RELEASE,
    tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.2,
    enableLogs: true,
    enableRpcTracePropagation: true,
    sendDefaultPii: false,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.extra;
      event.tags = metadata(event.tags ?? {});
      event.contexts = event.contexts?.trace ? { trace: { ...event.contexts.trace, data: metadata(event.contexts.trace.data ?? {}) } } : {};
      event.breadcrumbs = event.breadcrumbs?.map((b) => ({ ...b, message: b.category, data: metadata(b.data ?? {}) }));
      // SDK exceptions may include provider payloads or contact details in messages.
      for (const ex of event.exception?.values ?? []) {
        ex.value = `${ex.type ?? "Error"} (details in protected run dashboard)`;
        if (ex.mechanism) delete ex.mechanism.data;
        for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;
      }
      return event;
    },
    beforeSendTransaction(event) {
      delete event.request;
      delete event.user;
      delete event.extra;
      event.tags = metadata(event.tags ?? {});
      event.contexts = event.contexts?.trace ? { trace: { ...event.contexts.trace, data: metadata(event.contexts.trace.data ?? {}) } } : {};
      delete event.breadcrumbs;
      event.transaction = "agent.process";
      for (const span of event.spans ?? []) {
        span.description = span.op;
        span.data = metadata(span.data ?? {});
      }
      return event;
    },
    beforeSendLog(log) { log.attributes = metadata(log.attributes ?? {}); return log; },
  };
}
