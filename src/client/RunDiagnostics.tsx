import { useMemo, useState } from "react";
import { diagnose } from "../shared/run-diagnostics";
import type { TapeEvent } from "./RunTape";
import { dur } from "./ui";

/**
 * Timing and errors for the run, as one line until someone wants more. A run
 * recorded before spans existed has nothing to say here, so it says nothing —
 * a grid of zeros above the tape only pushes the tape down.
 */
export function RunDiagnostics({ events, onPick }: { events: TapeEvent[]; onPick: (seq: number) => void }) {
  const d = useMemo(() => diagnose(events), [events]);
  // Errors open it by themselves; otherwise it waits to be asked.
  const [toggled, setToggled] = useState<boolean | null>(null);
  if (!d.spans.length && !d.errors.length && !d.retries.length) return null;
  const open = toggled ?? d.errors.length > 0;

  const headline = [
    d.modelCalls ? `${d.modelCalls} model call${d.modelCalls === 1 ? "" : "s"}` : null,
    d.p50 != null ? `p50 ${dur(d.p50)}` : null,
    d.p95 != null ? `p95 ${dur(d.p95)}` : null,
    d.retries.length ? `${d.retries.length} JSON retr${d.retries.length === 1 ? "y" : "ies"}` : null,
    d.pending.length ? `${d.pending.length} unfinished` : null,
  ].filter(Boolean) as string[];
  // Zeros are not news: only the counters that counted something are printed.
  const stats = ([
    ["Input tokens", d.totals.inputTokens],
    ["Output tokens", d.totals.outputTokens],
    ["Cached tokens", d.totals.cachedTokens],
    ["Reasoning tokens", d.totals.reasoningTokens],
  ] as [string, number][]).filter(([, v]) => v > 0);

  return (
    <section aria-label="Run performance and errors" style={{ margin: "10px 0 14px 4px", background: "var(--paper2)" }}>
      <button className="rv-diag" aria-expanded={open} onClick={() => setToggled(!open)}>
        <span className="rv-meta" style={{ color: "var(--ink)" }}>Diagnostics</span>
        <span style={{ display: "flex", gap: 14, flexWrap: "wrap", minWidth: 0, color: "var(--soft)" }}>
          {headline.map((h) => <span key={h}>{h}</span>)}
          {d.errors.length > 0 && <span style={{ color: "var(--error)" }}>{d.errors.length} error{d.errors.length === 1 ? "" : "s"}</span>}
        </span>
        <span aria-hidden style={{ marginLeft: "auto", color: "var(--soft)" }}>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div style={{ padding: "4px 14px 14px", display: "flex", flexDirection: "column", gap: 14 }}>
          {stats.length > 0 && (
            <dl style={{ margin: 0, display: "flex", gap: 28, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 12 }}>
              {stats.map(([label, value]) => (
                <div key={label}>
                  <dt style={{ color: "var(--soft)" }}>{label}</dt>
                  <dd style={{ margin: "3px 0 0", fontSize: 16, fontVariantNumeric: "tabular-nums" }}>{value.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          )}
          {d.ranked.length > 0 && (
            <div>
              <p className="rv-meta" style={{ margin: "0 0 6px" }}>Slowest operations</p>
              {d.ranked.slice(0, 6).map((g) => (
                <button key={g.name} onClick={() => onPick(g.seq)} className="rv-bar" style={{ background: `linear-gradient(to right, var(--paper3) ${Math.max(2, (g.ms / Math.max(1, d.ranked[0].ms)) * 100)}%, transparent 0)` }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{g.name}</span>
                  <span style={{ marginLeft: "auto", color: g.errors ? "var(--error)" : "var(--soft)", whiteSpace: "nowrap" }}>
                    {dur(g.ms)} · {g.count}×{g.errors ? ` · ${g.errors} failed` : ""}
                  </span>
                </button>
              ))}
              <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "var(--soft)" }}>
                Cumulative; spans may overlap. Occupied: {dur(d.occupiedMs)}.
              </p>
            </div>
          )}
          {d.errors.length > 0 && (
            <div>
              <p className="rv-meta" style={{ margin: "0 0 6px", color: "var(--error)" }}>Errors</p>
              {d.errors.slice(-15).map((e) => (
                <button key={e.seq} onClick={() => onPick(e.seq)} className="rv-bar" style={{ overflowWrap: "anywhere" }}>
                  <span>{String(e.fields.operation ?? e.event)}: {String(e.fields.error ?? e.fields.errorType ?? "failed").slice(0, 180)}</span>
                </button>
              ))}
            </div>
          )}
          {d.insights.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.5, color: "var(--soft)" }}>
              {d.insights.map((s) => <li key={s}>{s}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
