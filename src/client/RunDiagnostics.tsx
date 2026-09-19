import { useMemo, useState } from "react";
import { diagnose } from "../shared/run-diagnostics";
import type { TapeEvent } from "./RunTape";
import { dur } from "./ui";

export function RunDiagnostics({ events, onPick }: { events: TapeEvent[]; onPick: (seq: number) => void }) {
  const d = useMemo(() => diagnose(events), [events]);
  const [open, setOpen] = useState(true);
  return <section aria-label="Run performance and errors" style={{ margin: "12px 0 18px", padding: 14, border: "1px solid var(--rule)", background: "var(--paper2)" }}>
    <button className="rv-btn is-quiet" aria-expanded={open} onClick={() => setOpen(!open)} style={{ width: "100%", textAlign: "left" }}>
      Performance & diagnostics {open ? "−" : "+"}
    </button>
    {open && <>
      {!d.spans.length && <p style={{ fontSize: 13, color: "var(--soft)" }}>Detailed spans appear on new runs after this update. Existing events remain below.</p>}
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", gap: 14, fontFamily: "var(--mono)", fontSize: 12 }}>
        {[["Model calls", d.modelCalls], ["Model p50", d.p50 == null ? "—" : dur(d.p50)], ["Model p95", d.p95 == null ? "—" : dur(d.p95)], ["Error events", d.errors.length], ["JSON retries", d.retries.length], ["Unfinished spans", d.pending.length], ["Input tokens", d.totals.inputTokens.toLocaleString()], ["Output tokens", d.totals.outputTokens.toLocaleString()], ["Cached tokens", d.totals.cachedTokens.toLocaleString()], ["Reasoning tokens", d.totals.reasoningTokens.toLocaleString()]].map(([label, value]) => <div key={label}><dt style={{ color: "var(--soft)" }}>{label}</dt><dd style={{ margin: "5px 0 0", fontSize: 18 }}>{value}</dd></div>)}
      </dl>
      {!!d.ranked.length && <><p className="rv-meta">Slowest operations · cumulative time</p><div style={{ display: "grid", gap: 6 }}>{d.ranked.slice(0, 6).map((g) => <button key={g.name} onClick={() => onPick(g.seq)} className="rv-btn" style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 8, textAlign: "left", background: `linear-gradient(to right, var(--paper3) ${Math.max(2, g.ms / Math.max(1, d.ranked[0].ms) * 100)}%, transparent 0)` }}><span>{g.name}</span><span>{dur(g.ms)} · {g.count} calls{g.errors ? ` · ${g.errors} failed` : ""}</span></button>)}</div><p style={{ fontSize: 11, color: "var(--soft)" }}>Durations can overlap or nest; they are not additive wall time. Recorded leaf operations occupy {dur(d.occupiedMs)}.</p></>}
      {!!d.errors.length && <details><summary style={{ cursor: "pointer", color: "var(--error)" }}>Inspect {d.errors.length} error events</summary>{d.errors.slice(-15).map((e) => <button key={e.seq} onClick={() => onPick(e.seq)} className="rv-btn" style={{ display: "block", marginTop: 6, textAlign: "left", maxWidth: "100%", overflowWrap: "anywhere" }}>{String(e.fields.operation ?? e.event)}: {String(e.fields.error ?? e.fields.errorType ?? "failed").slice(0, 180)}</button>)}</details>}
      {!!d.insights.length && <details><summary style={{ cursor: "pointer", marginTop: 12 }}>Optimization observations</summary><ul style={{ paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>{d.insights.map((s) => <li key={s}>{s}</li>)}</ul></details>}
      <p style={{ fontSize: 11, color: "var(--soft)", marginBottom: 0 }}>Decision summaries, tool choices, retries and outcomes are recorded. Private model reasoning is not recorded. Select a span for trace IDs and details.</p>
    </>}
  </section>;
}
