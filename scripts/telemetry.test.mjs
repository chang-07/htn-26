import test from "node:test";
import assert from "node:assert/strict";
import { telemetryScope, traceOperation, emitTelemetry, safeFields, traceWorkflowSteps, tracedFetch } from "../src/server/telemetry.ts";
import { diagnose, intervalMs } from "../src/shared/run-diagnostics.ts";

test("concurrent traces isolate runs and preserve child/parent links", async () => {
  const a = [], b = [];
  const sink = (rows) => (level, event, fields) => rows.push({ level, event, fields });
  await Promise.all([telemetryScope(sink(a), () => traceOperation("a", "agent", {}, async () => {
    await traceOperation("a.child", "gen_ai.chat", {}, async () => Promise.resolve());
  })), telemetryScope(sink(b), () => traceOperation("b", "agent", {}, async () => Promise.resolve()))]);
  assert.equal(a.length, 4); assert.equal(b.length, 2);
  assert.notEqual(a[0].fields.traceId, b[0].fields.traceId);
  assert.equal(a[1].fields.parentSpanId, a[0].fields.spanId);
  assert.equal(a[1].fields.traceId, a[0].fields.traceId);
  assert.equal(a[1].fields.spanId, a[2].fields.spanId);
});

test("failures keep their original identity and failed spans even when a sink fails", async () => {
  const rows = [], failure = new Error("provider unavailable");
  await assert.rejects(telemetryScope((level, event, fields) => { rows.push({ level, event, fields }); return Promise.reject(new Error("dashboard down")); }, () => traceOperation("fetch", "http.client", {}, async () => { throw failure; })), (e) => e === failure);
  assert.equal(rows.at(-1).fields.status, "error");
  assert.ok(rows.at(-1).fields.ms >= 0);
});

test("credentials and private reasoning are excluded recursively", () => {
  const result = safeFields({ token: "secret", thinking: "private reasoning", nested: { authorization: "Bearer abc", password: "pw", tokens: 42 }, error: "Bearer abc https://x.test/?token=abc", value: "sk-proj-abcdef" });
  assert.deepEqual(result.nested, { tokens: 42 });
  assert.equal(result.thinking, undefined);
  assert.doesNotMatch(JSON.stringify(result), /abc|private reasoning|secret|pw/);
});

test("workflow tracing records actual retry attempts, leaves cached results alone", async () => {
  const rows = [];
  let stored;
  const step = traceWorkflowSteps({ async do(name, options, callback) { if (stored) return stored; try { await callback({ attempt: 1 }); } catch {} stored = await callback({ attempt: 2 }); return stored; } }, "research");
  let calls = 0;
  await telemetryScope((level, event, fields) => rows.push({ level, event, fields }), async () => {
    const callback = async () => { if (++calls === 1) throw new Error("retry"); return "result"; };
    assert.equal(await step.do("search", {}, callback), "result");
    assert.equal(await step.do("search", {}, callback), "result");
  });
  assert.equal(calls, 2);
  assert.deepEqual(rows.filter((e) => e.event === "trace.end").map((e) => [e.fields.attempt, e.fields.status]), [[1, "error"], [2, "ok"]]);
});

test("HTTP failures preserve responses and expose rate limit metadata without payloads", async (t) => {
  const rows = [];
  t.mock.method(globalThis, "fetch", async () => new Response("private payload", { status: 429 }));
  const response = await telemetryScope((level, event, fields) => rows.push({ level, event, fields }), () => tracedFetch("https://example.test/path?token=secret"));
  assert.equal(response.status, 429);
  assert.ok(rows.some((e) => e.fields.statusCode === 429 && e.fields.retryable));
  assert.equal(rows.at(-1).fields.status, "error");
  assert.doesNotMatch(JSON.stringify(rows), /secret|payload|\/path/);
});

test("diagnostics count overlapping intervals once and expose failures, tokens, retries", () => {
  assert.equal(intervalMs([[0, 100], [50, 150], [160, 180]]), 170);
  const events = [
    { event: "trace.end", fields: { operation: "llm.json", op: "gen_ai.chat", started: 0, ms: 100, status: "ok" } },
    { event: "trace.end", level: "error", fields: { operation: "llm.json", op: "gen_ai.chat", started: 50, ms: 100, status: "error" } },
    { event: "llm.usage", fields: { inputTokens: 15000, outputTokens: 200, cachedTokens: 0, reasoningTokens: 80 } },
    { event: "llm.validation_failed", fields: { retry: true } },
  ].map((e, seq) => ({ seq, ts: seq, level: "info", ...e }));
  const d = diagnose(events);
  assert.equal(d.occupiedMs, 150); assert.equal(d.modelCalls, 2); assert.equal(d.p95, 100);
  assert.equal(d.errors.length, 1); assert.equal(d.retries.length, 1);
  assert.equal(d.totals.reasoningTokens, 80); assert.equal(d.ranked[0].count, 2);
  assert.ok(d.insights.some((i) => i.includes("cache reuse")));
});

test("Sentry export scrubs request data, model payloads, personal contexts and exception messages", async () => {
  const { sentryOptions } = await import("../src/server/sentry-options.ts");
  const options = sentryOptions({ SENTRY_DSN: "https://public@example.test/1", SENTRY_TRACES_SAMPLE_RATE: "bad" });
  assert.equal(options.tracesSampleRate, 0.2);
  const event = options.beforeSend({ request: { data: "private prompt" }, user: { email: "private@example.test" }, extra: { body: "private message" }, contexts: { person: { name: "Private Person" }, trace: { trace_id: "trace", data: { prompt: "private", model: "test-model" } } }, exception: { values: [{ type: "TypeError", value: "private provider payload", stacktrace: { frames: [{ filename: "app.ts", lineno: 4 }] } }] }, breadcrumbs: [{ category: "http", message: "private URL", data: { headers: "private key", ms: 100 } }] });
  assert.doesNotMatch(JSON.stringify(event), /private|Private/);
  assert.equal(event.contexts.trace.data.model, "test-model");
  assert.equal(event.exception.values[0].stacktrace.frames[0].lineno, 4);
  const transaction = options.beforeSendTransaction({ request: { data: "private" }, transaction: "private URL", spans: [{ op: "http.client", description: "private URL", data: { prompt: "private", ms: 100 } }] });
  assert.doesNotMatch(JSON.stringify(transaction), /private/);
  assert.equal(transaction.spans[0].data.ms, 100);
  const log = options.beforeSendLog({ attributes: { input: "private", output: "private", tokens: 100 } });
  assert.deepEqual(log.attributes, { tokens: 100 });
  assert.equal(sentryOptions({}).enabled, false);
});

test("trace timeline pairs ends with starts, retains unfinished spans, and uses elapsed fallback", async () => {
  const { traceTimeline } = await import("../src/shared/run-diagnostics.ts");
  const event = (seq, ts, kind, fields) => ({ seq, ts, event: kind, level: "info", fields });
  const result = traceTimeline([
    event(0, 1000, "trace.start", { traceId: "a", spanId: "1", started: 1000 }),
    event(1, 1200, "trace.end", { traceId: "a", spanId: "1", ms: 200 }),
    event(2, 1100, "trace.start", { traceId: "b", spanId: "1", started: 1100 }),
    event(3, 1500, "trace.end", { traceId: "a", spanId: "2", started: 1050, ms: 450 }),
  ]);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map((r) => [r.start, r.duration]), [[1000, 200], [1050, 450], [1100, null]]);
  assert.equal(result.duration, 500);
  assert.deepEqual(traceTimeline([]), { rows: [], start: 0, duration: 1 });
});
