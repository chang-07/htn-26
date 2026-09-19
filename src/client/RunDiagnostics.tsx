import { useMemo, useState } from "react";
import { diagnose, operationLabel, traceTimeline } from "../shared/run-diagnostics";
import type { TapeEvent } from "./RunTape";
import { dur } from "./ui";

export function RunDiagnostics({ events, onPick, finished }: { events: TapeEvent[]; onPick: (seq: number) => void; finished: boolean }) {
  const d = useMemo(() => diagnose(events), [events]);
  const timeline = useMemo(() => traceTimeline(events), [events]);
  const [view, setView] = useState<"overview" | "traces">("overview");
  const hasMetric = (key: string) => events.some((e) => ["turn.step", "llm.usage"].includes(e.event) && typeof e.fields[key] === "number");
  const hasUsage = hasMetric("inputTokens") && hasMetric("outputTokens");
  const hasTraces = timeline.rows.length > 0;
  const note = { fontSize: 12, color: "var(--soft)", lineHeight: 1.5 };
  return <section aria-label="Run analytics" style={{ margin: "12px 0 24px", border: "1px solid var(--rule)", padding: 18 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
      <h2 style={{ fontSize: 18, margin: 0 }}>Run analytics</h2>
      <div role="group" aria-label="Analytics view" style={{ display: "flex", gap: 6 }}>
        {(["overview", "traces"] as const).map((v) => <button key={v} className={`rv-btn${view === v ? " is-on" : ""}`} aria-pressed={view === v} onClick={() => setView(v)}>{v === "overview" ? "Overview" : `Traces (${timeline.rows.length})`}</button>)}
      </div>
    </div>
    {!hasTraces && <p style={note}>Detailed timings were not recorded for this run. Its recorded activity is still available below.</p>}
    {view === "overview" ? <>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 16, margin: "20px 0" }}>
        {[
          ["Model calls", hasTraces ? String(d.modelCalls) : "—", "Completed model requests"],
          ["Typical response", d.p50 === null ? "—" : dur(d.p50), "Median model request time"],
          ["Tokens used", hasUsage ? (d.totals.inputTokens + d.totals.outputTokens).toLocaleString() : "—", hasUsage ? "Input + output tokens" : "Not recorded"],
          ["Error events", String(d.errors.length), "May share the same root cause"],
        ].map(([label, value, hint]) => <div key={label}><dt style={note}>{label}</dt><dd style={{ margin: "5px 0", fontSize: 25, fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{value}</dd><div style={{ ...note, fontSize: 11 }}>{hint}</div></div>)}
      </dl>
      {(d.errors.length > 0 || d.pending.length > 0 || d.retries.length > 0) && <div style={{ padding: 12, background: "var(--paper2)", marginBottom: 18 }}>
        <h3 style={{ margin: "0 0 8px", fontSize: 13 }}>Needs a look</h3>
        {d.errors.slice(-3).map((e) => <button key={e.seq} className="rv-btn is-quiet" onClick={() => onPick(e.seq)} style={{ display: "block", textAlign: "left", color: "var(--error)", overflowWrap: "anywhere" }}>{operationLabel(String(e.fields.operation ?? e.event))} — {String(e.fields.error ?? e.fields.errorType ?? "Error recorded").slice(0, 140)} →</button>)}
        {d.errors.length > 3 && <p style={note}>{d.errors.length - 3} more error events are recorded in the activity below.</p>}
        {d.retries.length > 0 && <p style={note}>{d.retries.length} retries after the model returned invalid structured data.</p>}
        {d.pending.length > 0 && <p style={note}>{d.pending.length} operations have no recorded end.{finished ? " They may have been interrupted or their final event was not saved." : " They may still be running."}</p>}
      </div>}
      {d.ranked.length > 0 && <>
        <h3 style={{ fontSize: 13, margin: "16px 0 8px" }}>Where time went</h3>
        {d.ranked.slice(0, 5).map((g) => <button key={g.name} onClick={() => onPick(g.seq)} className="rv-btn is-quiet" style={{ display: "flex", width: "100%", justifyContent: "space-between", gap: 12, padding: "10px 8px", marginBottom: 4, textAlign: "left", background: `linear-gradient(to right, var(--paper2) ${g.ms / Math.max(1, d.ranked[0].ms) * 100}%, transparent 0)` }}><span>{operationLabel(g.name)}<small style={{ display: "block", color: "var(--soft)" }}>{g.count} {g.count === 1 ? "call" : "calls"}{g.errors ? ` · ${g.errors} failed` : ""}</small></span><span style={{ whiteSpace: "nowrap" }}>{dur(g.ms)}</span></button>)}
        <p style={note}>Time is summed per operation. Calls can overlap, so these numbers do not add up to the run’s elapsed time.</p>
      </>}
      <details style={{ marginTop: 16 }}><summary style={{ cursor: "pointer", fontSize: 13 }}>Token breakdown & more metrics</summary>
        <dl style={{ fontSize: 13, lineHeight: 1.8 }}>
          {[["Input tokens", hasMetric("inputTokens") ? d.totals.inputTokens.toLocaleString() : "Not recorded"], ["Output tokens", hasMetric("outputTokens") ? d.totals.outputTokens.toLocaleString() : "Not recorded"], ["Cached input tokens", hasMetric("cachedTokens") ? d.totals.cachedTokens.toLocaleString() : "Not recorded"], ["Reasoning tokens", hasMetric("reasoningTokens") ? d.totals.reasoningTokens.toLocaleString() : "Not recorded"], ["95th-percentile model time", d.p95 === null ? "Not recorded" : dur(d.p95)]].map(([label, value]) => <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><dt>{label}</dt><dd style={{ margin: 0 }}>{value}</dd></div>)}
        </dl><p style={note}>Cached tokens are part of input; reasoning tokens are part of output. Percentiles describe this run only.</p>
      </details>
    </> : <>
      <p style={note}>Each row is one operation. Bars show when it ran relative to the other operations. Select a row for details.</p>
      {hasTraces && <div style={{ overflowX: "auto" }}><div style={{ minWidth: 340 }}>
        <div style={{ display: "flex", justifyContent: "space-between", ...note, marginBottom: 8 }}><span>First operation · 0s</span><span>{dur(timeline.duration)}</span></div>
        {timeline.rows.map(({ event: e, start, duration }) => <button key={e.seq} className="rv-btn is-quiet" onClick={() => onPick(e.seq)} style={{ display: "block", width: "100%", padding: "10px 0", borderBottom: "1px solid var(--rule)", textAlign: "left" }}>
          <span style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span>{operationLabel(String(e.fields.operation ?? e.event))}</span><span style={{ color: e.fields.status === "error" ? "var(--error)" : "var(--soft)", whiteSpace: "nowrap" }}>{duration === null ? "No end recorded" : `${dur(duration)}${e.fields.status === "error" ? " · failed" : ""}`}</span></span>
          <span aria-hidden="true" style={{ display: "block", height: 6, background: "var(--paper2)", marginTop: 8, position: "relative" }}><span style={{ position: "absolute", left: `${Math.min(99, (start - timeline.start) / timeline.duration * 100)}%`, width: `${Math.min(100 - Math.min(99, (start - timeline.start) / timeline.duration * 100), Math.max(1, (duration ?? 0) / timeline.duration * 100))}%`, height: "100%", background: e.fields.status === "error" ? "var(--error)" : "var(--ink)", opacity: duration === null ? 0.3 : 0.65 }} /></span>
        </button>)}
      </div></div>}
    </>}
  </section>;
}
