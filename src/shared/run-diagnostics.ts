export type DiagnosticEvent = { seq: number; ts: number; level: string; event: string; fields: Record<string, unknown> };
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
const key = (e: DiagnosticEvent) => `${e.fields.traceId}/${e.fields.spanId}`;

/** Union of intervals: overlapping calls must not inflate occupied wall time. */
export function intervalMs(intervals: [number, number][]): number {
  const sorted = intervals.filter(([a, b]) => b >= a).sort((a, b) => a[0] - b[0]);
  let end = -Infinity, total = 0;
  for (const [a, b] of sorted) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
  return total;
}
export function diagnose(events: DiagnosticEvent[]) {
  const spans = events.filter((e) => e.event === "trace.end" && typeof e.fields.ms === "number");
  const ended = new Set(spans.map(key));
  const pending = events.filter((e) => e.event === "trace.start" && !ended.has(key(e)));
  const leaves = spans.filter((e) => !["agent", "workflow", "workflow.step"].includes(String(e.fields.op)));
  const model = leaves.filter((e) => String(e.fields.op).startsWith("gen_ai"));
  const times = model.map((e) => number(e.fields.ms)).sort((a, b) => a - b);
  const percentile = (p: number) => times.length ? times[Math.ceil(times.length * p) - 1] : null;
  const usage = events.filter((e) => e.event === "turn.step" || e.event === "llm.usage");
  const totals = Object.fromEntries(["inputTokens", "outputTokens", "cachedTokens", "reasoningTokens"].map((k) => [k, usage.reduce((sum, e) => sum + number(e.fields[k]), 0)]));
  const retries = events.filter((e) => e.fields.retry === true);
  const errors = events.filter((e) => e.level === "error" || e.fields.status === "error");
  const groups = new Map<string, { name: string; ms: number; count: number; errors: number; seq: number }>();
  for (const e of leaves) {
    const name = String(e.fields.tool ?? e.fields.operation ?? e.event);
    const group = groups.get(name) ?? { name, ms: 0, count: 0, errors: 0, seq: e.seq };
    group.ms += number(e.fields.ms); group.count++; group.errors += e.fields.status === "error" ? 1 : 0;
    groups.set(name, group);
  }
  const ranked = [...groups.values()].sort((a, b) => b.ms - a.ms);
  const insights: string[] = [];
  if (ranked[0]) insights.push(`Largest cumulative operation: ${ranked[0].name} (${ranked[0].count} calls). Inspect it before changing concurrency or models.`);
  if (retries.length) insights.push(`${retries.length} JSON validation retries. Review schema failures to avoid repeat model calls.`);
  if (totals.inputTokens > 10000 && totals.cachedTokens / totals.inputTokens < 0.1) insights.push("High prompt volume with little cache reuse. Inspect context size and keep stable instructions at the front.");
  if (events.some((e) => e.event.includes("loop_detected") || e.fields.outcome === "max_steps")) insights.push("An execution limit or repeated-action guard fired. Inspect the preceding tool outcomes.");
  const repeated = ranked.filter((g) => g.count >= 3 && !g.name.startsWith("llm.") && !g.name.startsWith("agent.model"));
  if (repeated.length) insights.push(`Repeated operations: ${repeated.map((g) => `${g.name} ×${g.count}`).join(", ")}. Repetition may be legitimate; compare inputs and outcomes before deduplicating.`);
  return { spans, pending, errors, retries, ranked, insights, totals, modelCalls: model.length, p50: percentile(0.5), p95: percentile(0.95), occupiedMs: intervalMs(leaves.map((e) => [number(e.fields.started), number(e.fields.started) + number(e.fields.ms)])) };
}
