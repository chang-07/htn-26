import { useMemo, useState } from "react";
import { diagnose, operationLabel, traceTimeline } from "../shared/run-diagnostics";
import type { TapeEvent } from "./RunTape";
import type { RunSummary } from "../server/runs";
import { dur } from "./ui";
import "./run-analytics.css";

const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function Sparkline({ values, label, error = false }: { values: number[]; label: string; error?: boolean }) {
  if (!values.length) return <div className="ra-chart-empty">No samples recorded</div>;
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => `${values.length === 1 ? 150 : i / (values.length - 1) * 300},${48 - v / max * 40}`);
  return <svg className={`ra-chart${error ? " is-error" : ""}`} viewBox="0 0 300 54" preserveAspectRatio="none" role="img" aria-label={label}>
    <title>{label}: {values.map((v) => Math.round(v)).join(", ")}</title>
    {values.length > 1 && <><polygon points={`0,54 ${points.join(" ")} 300,54`} /><polyline points={points.join(" ")} /></>}
    {values.length === 1 && <circle cx="150" cy={48 - values[0] / max * 40} r="3" />}
  </svg>;
}

function Badge({ children, tone = "" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`ra-badge ${tone}`}>{children}</span>;
}

export function RunDiagnostics({ events, onPick, run }: { events: TapeEvent[]; onPick: (seq: number) => void; run: RunSummary }) {
  const d = useMemo(() => diagnose(events), [events]);
  const timeline = useMemo(() => traceTimeline(events), [events]);
  const [view, setView] = useState<"performance" | "traces" | "errors">("performance");
  const [expanded, setExpanded] = useState<string | null>("Models");
  const finished = run.ended !== null;
  const hasMetric = (key: string) => events.some((e) => ["turn.step", "llm.usage"].includes(e.event) && numeric(e.fields[key]));
  const hasUsage = hasMetric("inputTokens") && hasMetric("outputTokens");
  const usage = events.filter((e) => ["turn.step", "llm.usage"].includes(e.event) && numeric(e.fields.inputTokens) && numeric(e.fields.outputTokens));
  const modelSpans = d.spans.filter((e) => String(e.fields.op).startsWith("gen_ai"));
  const modelTimes = modelSpans.map((e) => Number(e.fields.ms));
  const tokenSamples = usage.map((e) => Number(e.fields.inputTokens) + Number(e.fields.outputTokens));
  const observedEnd = events.reduce((end, e) => Math.max(end, e.ts), run.started);
  const elapsed = Math.max(0, (run.ended ?? observedEnd) - run.started);
  const inputs = [
    { label: "Messages", events: events.filter((e) => e.event === "message.in") },
    { label: "Votes", events: events.filter((e) => e.event === "vote.cast") },
    { label: "Location updates", events: events.filter((e) => e.event === "location.taken") },
  ].filter((group) => group.events.length > 0);
  const categories = new Map<string, typeof timeline.rows>();
  for (const row of timeline.rows) {
    const op = String(row.event.fields.op ?? "");
    if (op === "agent") continue;
    const category = op.startsWith("gen_ai") ? "Models" : op.startsWith("workflow") ? "Workflows" : op === "http.client" ? "API requests" : op === "browser" ? "Browser" : "Tools & operations";
    const rows = categories.get(category) ?? [];
    rows.push(row);
    categories.set(category, rows);
  }
  const componentCount = [...categories.values()].reduce((sum, rows) => sum + rows.length, 0);
  const showTraces = () => setView("traces");

  return <section className="ra" aria-label="Run analytics">
    <header className="ra-context">
      <div><span className="ra-context-icon" aria-hidden="true">◈</span><strong>Run overview</strong><span className="ra-muted ra-context-id" title={run.runId}>{run.runId.slice(0, 8)}</span></div>
      <span className="ra-muted">{new Date(run.started).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
    </header>

    <div className="ra-map" aria-label="Recorded run components">
      <div className="ra-map-caption"><span>Execution map</span><span>Recorded in this run</span></div>
      <div className="ra-map-grid">
        <div className="ra-inputs">
          <p className="ra-eyebrow">Inputs</p>
          {inputs.map((group) => <details className="ra-node" key={group.label}>
            <summary>{group.label}<Badge>{group.events.length}</Badge><span className="ra-chevron" aria-hidden="true">⌄</span></summary>
            <div className="ra-node-list">{group.events.map((e, i) => <button key={e.seq} onClick={() => onPick(e.seq)}>{group.label === "Messages" ? "Message" : "Event"} {i + 1}<span>Inspect →</span></button>)}</div>
          </details>)}
          {!inputs.length && <div className="ra-node ra-empty-node"><strong>{run.trigger ? operationLabel(run.trigger) : "Run trigger"}</strong><p className="ra-muted">No detailed input events recorded</p></div>}
        </div>
        <div className="ra-connector" aria-hidden="true"><span /></div>
        <div className="ra-node ra-agent">
          <header><span className="ra-context-icon" aria-hidden="true">◈</span><strong>Plan agent</strong><span className={`ra-dot${finished ? " is-ended" : ""}`} aria-hidden="true" /></header>
          <div className="ra-agent-body">
            <div><span>Status</span><Badge tone={finished ? "" : "blue"}>{finished ? "Ended" : "Open"}</Badge></div>
            <div><span>{finished ? "Elapsed time" : "Recorded so far"}</span><strong>{dur(elapsed)}</strong></div>
            <button onClick={showTraces}><span>Recorded traces</span><Badge tone={timeline.rows.length ? "blue" : ""}>{timeline.rows.length || "None"} →</Badge></button>
            <button onClick={() => setView("errors")}><span>Error events</span><Badge tone={d.errors.length ? "red" : ""}>{d.errors.length} →</Badge></button>
            {run.outcome && <p className="ra-outcome">{operationLabel(run.outcome)}</p>}
          </div>
        </div>
        <div className="ra-connector" aria-hidden="true"><span /></div>
        <div className="ra-node ra-services">
          <header><strong>Operations</strong><Badge>{componentCount}</Badge></header>
          {!categories.size && <p className="ra-empty-node ra-muted">No operation traces recorded. The activity feed may still contain events.</p>}
          {[...categories].map(([name, rows]) => <div className="ra-service" key={name}>
            <button className="ra-service-toggle" aria-expanded={expanded === name} onClick={() => setExpanded(expanded === name ? null : name)}><span>{name}</span><Badge>{rows.length}</Badge><span className="ra-chevron" aria-hidden="true">{expanded === name ? "⌃" : "⌄"}</span></button>
            {expanded === name && <div className="ra-node-list">{rows.map(({ event: e, duration }) => <button key={e.seq} onClick={() => onPick(e.seq)}><span title={String(e.fields.operation)}>{String(e.fields.model ?? e.fields.provider ?? e.fields.tool ?? operationLabel(String(e.fields.operation ?? e.event)))}</span><span className={e.fields.status === "error" ? "ra-error" : ""}>{duration === null ? "No end" : dur(duration)} →</span></button>)}</div>}
          </div>)}
        </div>
      </div>
      <p className="ra-map-note">Connections summarize participation. Use Traces for operation timing; overlapping operations may run in parallel.</p>
    </div>

    <div className="ra-summary-grid">
      <section className="ra-card ra-metrics" aria-label="Run metrics">
        <header className="ra-card-heading"><h3>Metrics</h3><Badge>This run</Badge><button onClick={showTraces} aria-label="Inspect traces">↗</button></header>
        <div className="ra-metric-grid">
          <div className="ra-metric"><span>Model calls</span><strong>{timeline.rows.length ? d.modelCalls : "—"}</strong><small>{d.p50 === null ? "No response times recorded" : `${dur(d.p50)} median response`}</small><Sparkline values={modelTimes} label="Model durations in milliseconds, in completion order" /><footer>Response time · call order</footer></div>
          <div className="ra-metric"><span>Tokens used</span><strong>{hasUsage ? (d.totals.inputTokens + d.totals.outputTokens).toLocaleString() : "—"}</strong><small>Input + output · recorded usage</small><Sparkline values={tokenSamples} label="Tokens per recorded model response, in event order" /><footer>Tokens · response order</footer></div>
          <button className="ra-metric ra-metric-button" onClick={() => setView("errors")}><span>Error events</span><strong className={d.errors.length ? "ra-error" : ""}>{d.errors.length}</strong><small>{d.errors.length ? "Inspect recorded errors →" : "No errors in recorded events"}</small><Sparkline values={events.map((e) => e.level === "error" || e.fields.status === "error" ? 1 : 0)} label="Error flags in recorded event order; 1 means error" error /><footer>Errors · event order</footer></button>
        </div>
      </section>
      <section className="ra-card ra-health"><header className="ra-card-heading"><h3>Recording</h3></header><div className="ra-health-body">
        <div><span>Events available</span><strong>{events.length}</strong></div>
        <div><span>Operations without an end</span><strong>{d.pending.length}</strong></div>
        <div><span>Structured-output retries</span><strong>{d.retries.length}</strong></div>
        <p>{d.pending.length ? "An operation without an end may still be running or its final event may be missing." : "Metrics describe the events saved for this run."}</p>
      </div></section>
    </div>

    <section className="ra-card ra-detail">
      <div className="ra-tabs" role="group" aria-label="Analytics detail">
        {(["performance", "traces", "errors"] as const).map((v) => <button key={v} aria-pressed={view === v} className={view === v ? "is-active" : ""} onClick={() => setView(v)}>{v === "performance" ? "Performance" : v === "traces" ? "Traces" : "Errors"}{v !== "performance" && <Badge>{v === "traces" ? timeline.rows.length : d.errors.length}</Badge>}</button>)}
      </div>
      <div className="ra-detail-body">
        {view === "performance" && <div className="ra-performance-grid">
          <div><h3>Where time went</h3><p className="ra-muted">Cumulative time per operation. Durations can overlap and do not add up to elapsed time.</p>
            {!d.ranked.length && <p className="ra-empty">No completed operation timings recorded.</p>}
            {d.ranked.slice(0, 6).map((g) => <button key={g.name} className="ra-duration-row" onClick={() => onPick(g.seq)}><span><strong>{operationLabel(g.name)}</strong><small>{g.count} {g.count === 1 ? "call" : "calls"}{g.errors ? ` · ${g.errors} failed` : ""}</small></span><span>{dur(g.ms)} →</span><i aria-hidden="true" style={{ width: `${g.ms / Math.max(1, d.ranked[0].ms) * 100}%` }} /></button>)}
          </div>
          <div><h3>Token breakdown</h3><dl className="ra-breakdown">{[["Input tokens", "inputTokens"], ["Output tokens", "outputTokens"], ["Cached input", "cachedTokens"], ["Reasoning output", "reasoningTokens"]].map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{hasMetric(key) ? d.totals[key].toLocaleString() : "Not recorded"}</dd></div>)}</dl><p className="ra-muted">Cached tokens are included in input; reasoning tokens are included in output.</p><div className="ra-latency"><span>95th-percentile model response</span><strong>{d.p95 === null ? "Not recorded" : dur(d.p95)}</strong></div></div>
        </div>}
        {view === "traces" && <>
          <div className="ra-section-heading"><h3>Operation timeline</h3><span className="ra-muted">Select an operation to inspect it</span></div>
          {!timeline.rows.length ? <p className="ra-empty">No traces were recorded for this run. Recorded messages and results remain in Activity below.</p> : <div className="ra-trace-scroll"><div className="ra-traces">
            <div className="ra-trace-axis"><span>Operation</span><span>0s <span>{dur(timeline.duration)}</span></span><span>Duration</span></div>
            {timeline.rows.map(({ event: e, start, duration }) => {
              const left = Math.min(99, (start - timeline.start) / timeline.duration * 100);
              const width = Math.min(100 - left, Math.max(1, (duration ?? 0) / timeline.duration * 100));
              return <button key={e.seq} className="ra-trace-row" onClick={() => onPick(e.seq)}><span title={String(e.fields.operation)}>{operationLabel(String(e.fields.operation ?? e.event))}{e.fields.status === "error" && <small className="ra-error">Failed</small>}</span><span className="ra-trace-track" aria-hidden="true"><i className={e.fields.status === "error" ? "is-error" : duration === null ? "is-pending" : ""} style={{ left: `${left}%`, width: `${width}%` }} /></span><span>{duration === null ? "No end" : dur(duration)}</span></button>;
            })}
          </div></div>}
        </>}
        {view === "errors" && <><h3>Error events</h3><p className="ra-muted">Multiple events may describe the same failure. Select an event for context and trace IDs.</p>{!d.errors.length && <p className="ra-empty">No errors found in the recorded events.</p>}{d.errors.map((e) => <button className="ra-error-row" key={e.seq} onClick={() => onPick(e.seq)}><span><strong>{operationLabel(String(e.fields.operation ?? e.event))}</strong><small>{String(e.fields.error ?? e.fields.errorType ?? "Error recorded")}</small></span><span>Inspect →</span></button>)}</>}
      </div>
    </section>
  </section>;
}
