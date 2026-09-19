import { AsyncLocalStorage } from "node:async_hooks";

export type TelemetryFields = Record<string, unknown>;
export type TelemetryLevel = "info" | "warn" | "error";
export type TelemetrySink = (level: TelemetryLevel, event: string, fields: TelemetryFields) => void | Promise<void>;
type Context = { traceId: string; spanId?: string; sink?: TelemetrySink; pending: Promise<unknown>[] };
const storage = new AsyncLocalStorage<Context>();
const id = () => crypto.randomUUID().replaceAll("-", "");

// An optional adapter keeps local tracing testable without a Cloudflare runtime.
export const telemetryAdapter: {
  span?: <T>(name: string, op: string, fields: TelemetryFields, run: () => Promise<T>) => Promise<T>;
  identity?: () => TelemetryFields;
  httpStatus?: (status: number) => void;
  error?: (error: unknown, fields: TelemetryFields) => string | undefined;
  event?: (level: TelemetryLevel, event: string, fields: TelemetryFields) => string | undefined;
} = {};

export function traceFields(): TelemetryFields {
  const ctx = storage.getStore();
  return { ...(ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}), ...telemetryAdapter.identity?.() };
}

const blocked = /^(authorization|cookie|password|secret|api_?key|access_?token|refresh_?token|token|dsn|thinking|reasoning|chain.?of.?thought|cardNumber|cvv|cvc)$/i;
export function safeFields(fields: TelemetryFields): TelemetryFields {
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 6) return "[truncated]";
    if (typeof value === "string") return value.slice(0, 4000)
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk|sk-proj|sk-ant)-[\w-]+/g, "[redacted]")
      .replace(/([?&](?:token|key|api_key|secret|signature)=)[^&#\s]+/gi, "$1[redacted]");
    if (Array.isArray(value)) return value.slice(0, 100).map((v) => clean(v, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !blocked.test(k)).map(([k, v]) => [k, clean(v, depth + 1)]));
    return value;
  };
  return clean(fields) as TelemetryFields;
}

export function emitTelemetry(level: TelemetryLevel, event: string, fields: TelemetryFields, mirror = true, external = true): TelemetryFields {
  const enriched = safeFields({ ...traceFields(), ...fields });
  try {
    const sentryEventId = external ? telemetryAdapter.event?.(level, event, enriched) : undefined;
    if (sentryEventId) enriched.sentryEventId = sentryEventId;
  } catch { /* Observability cannot fail application work. */ }
  const ctx = storage.getStore();
  if (mirror && ctx?.sink) {
    try {
      const result = ctx.sink(level, event, { ...enriched, telemetryExported: true });
      if (result) ctx.pending.push(Promise.resolve(result).catch(() => {}));
    } catch { /* Keep the operation running if the viewer is unavailable. */ }
  }
  return enriched;
}

export async function telemetryScope<T>(sink: TelemetrySink, run: () => Promise<T>): Promise<T> {
  const ctx: Context = { traceId: id(), sink, pending: [] };
  return storage.run(ctx, async () => {
    try { return await run(); }
    finally { await Promise.allSettled(ctx.pending); }
  });
}

export async function traceOperation<T>(name: string, op: string, fields: TelemetryFields, run: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  const ctx: Context = { ...parent, traceId: parent?.traceId ?? id(), spanId: id().slice(0, 16), pending: parent?.pending ?? [] };
  const identity = telemetryAdapter.identity?.();
  const execute = () => {
    const current = telemetryAdapter.identity?.();
    if (typeof current?.traceId === "string") ctx.traceId = current.traceId;
    if (typeof current?.spanId === "string") ctx.spanId = current.spanId;
    return storage.run(ctx, async () => {
      const started = Date.now();
      const base = { ...fields, operation: name, op, parentSpanId: identity?.spanId ?? parent?.spanId, started };
      emitTelemetry("info", "trace.start", base);
      try {
        const result = await run();
        const httpFailure = result instanceof Response && !result.ok;
        if (result instanceof Response) {
          try { telemetryAdapter.httpStatus?.(result.status); } catch { /* Non-blocking telemetry. */ }
        }
        emitTelemetry(httpFailure ? "error" : "info", "trace.end", {
          ...base, ms: Date.now() - started, status: httpFailure ? "error" : "ok",
          ...(httpFailure ? { statusCode: result.status, error: `HTTP ${result.status}`, errorType: "HTTPError" } : {}),
        });
        return result;
      } catch (error) {
        let sentryEventId: string | undefined;
        try { sentryEventId = telemetryAdapter.error?.(error, { ...traceFields(), ...base }); } catch { /* Non-blocking telemetry. */ }
        emitTelemetry("error", "trace.end", { ...base, sentryEventId, ms: Date.now() - started, status: "error", error: error instanceof Error ? error.message : String(error), errorType: error instanceof Error ? error.name : "Error" });
        throw error;
      }
    });
  };
  return telemetryAdapter.span ? telemetryAdapter.span(name, op, fields, execute) : execute();
}

/** Trace each actual Workflow attempt inside step.do, not cached replay results. */
export function traceWorkflowSteps<T extends object>(step: T, workflow: string): T {
  return new Proxy(step, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key !== "do" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
    return (...args: unknown[]) => {
      const callback = args.at(-1) as (...a: unknown[]) => Promise<unknown>;
      args[args.length - 1] = (...a: unknown[]) => traceOperation(`${workflow}.${args[0]}`, "workflow.step", { workflow, stage: args[0], attempt: (a[0] as { attempt?: number } | undefined)?.attempt }, () => callback(...a));
      return value.apply(target, args);
    };
  } });
}

/** One transport attempt, including SDK-managed retries, with no URLs or payloads logged. */
export const tracedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const started = Date.now();
  return traceOperation("provider.request", "http.client", { provider: url.hostname }, async () => {
    const response = await fetch(input, init);
    emitTelemetry(response.ok ? "info" : "warn", "provider.response", {
      provider: url.hostname, statusCode: response.status, ms: Date.now() - started,
      retryable: response.status === 429 || response.status >= 500,
      requestId: response.headers.get("x-request-id") ?? undefined,
    });
    return response;
  });
};
