import { groupIntoSessions, sessionSummary, sessionEvents, type RunSession } from "../shared/run-sessions";
import { RunOverview } from "./RunOverview";
import { runStatus, type RunFilter } from "../shared/run-status";
import "./runs-overview.css";
import { mergeRunState, RUN_TIMEOUT_MESSAGE } from "../shared/run-timeout";
import { runLabel } from "../shared/run-labels";
import { RunDiagnostics } from "./RunDiagnostics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import type { RunEventRow, RunSummary } from "../server/runs";
import { RunTape, StepDetail, toNodes, type TapeEvent } from "./RunTape";
import { FONT_LINK, THEME_CSS, SERVICES, clock, dur } from "./ui";

/**
 * Live view of what the agent is doing, across every chat.
 *
 * Past runs come from /api/runs (D1). Runs happening right now arrive over the
 * RunHub WebSocket and are merged into the same list, so a turn triggered by a
 * text lands here a few hundred ms later and fills in step by step.
 *
 * Three columns when there is room — the rail of sessions, the tape of the
 * selected run, and the stage explaining the selected step — and fewer as the
 * window narrows: the stage becomes a sheet, then the rail and the tape take
 * turns. This page gets projected, so night mode is a first-class state.
 */

const TOKEN_KEY = "runs.token";
const THEME_KEY = "runs.theme";

/** The simulator routes only exist on a dev server; the hint is only useful there. */
const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);

/** /runs/<runId> — so a run found here can be pasted to someone else. */
const runIdFromPath = () => window.location.pathname.match(/^\/runs\/(.+)$/)?.[1] ?? null;

/** Follows a media query; re-renders when it flips. */
function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function Runs() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const [selected, setSelected] = useState<string | null>(runIdFromPath);
  const [events, setEvents] = useState<Record<string, TapeEvent[]>>({});
  const [chat, setChat] = useState<string>("");
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const [statusFilter, setStatusFilter] = useState<RunFilter>("all");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* no storage */
    }
    return "light";
  });
  // ?step=<seq> opens that step's panel, so one step of a run can be linked to.
  const [picked, setPicked] = useState<number | null>(null);
  const initialStep = useRef(new URLSearchParams(window.location.search).get("step"));
  const eventIds = useRef(new Map<string, number>());
  const [detailProblem, setDetailProblem] = useState(false);

  // On a phone the rail and the tape take turns; this is which one is up.
  const [railOpen, setRailOpen] = useState(false);
  const wide = useMedia("(min-width: 1180px)");
  const mid = useMedia("(min-width: 760px)");
  // A run linked to directly is often older than the page the list holds. It is
  // kept apart because both the list fetch and the socket's hello replace `runs`
  // wholesale, which would drop it again.
  const [linked, setLinked] = useState<RunSummary | null>(null);
  // Optional operator token for cart edits; viewing runs never needs it.
  const token = useMemo(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    try {
      if (fromUrl) {
        localStorage.setItem(TOKEN_KEY, fromUrl);
        // Remembered now, so take it out of the address bar: this page gets projected.
        const clean = new URL(window.location.href);
        clean.searchParams.delete("token");
        window.history.replaceState({}, "", clean.pathname + clean.search);
      }
      return fromUrl ?? localStorage.getItem(TOKEN_KEY) ?? "";
    } catch {
      // Private window, or site data blocked. The URL token still works.
      return fromUrl ?? "";
    }
  }, []);
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  // `follow` is read inside the socket callback, which is created once.
  const followRef = useRef(follow);
  followRef.current = follow;

  // A run opened while following is not one you navigated to, so it replaces
  // the current URL rather than stacking up history entries.
  const select = useCallback((runId: string, push = true) => {
    setSelected(runId);
    setPicked(null);
    initialStep.current = null;
    setRailOpen(false);
    window.history[push ? "pushState" : "replaceState"]({}, "", `/runs/${runId}`);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  // Only a deliberate flip is remembered; until then the page follows the OS.
  const flipTheme = () =>
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* no storage */
      }
      return next;
    });

  useEffect(() => {
    const onPop = () => setSelected(runIdFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const upsert = useCallback((run: Partial<RunSummary> & { runId: string }) => {
    setRuns((prev) => {
      const i = prev.findIndex((r) => r.runId === run.runId);
      if (i === -1) return [{ ...EMPTY_RUN, ...run } as RunSummary, ...prev];
      const next = [...prev];
      next[i] = mergeRunState(next[i], { ...next[i], ...run });
      return next;
    });
  }, []);

  useAgent({
    agent: "run-hub",
    name: "global",
    query: token ? { token } : undefined,
    onOpen: () => setLive(true),
    onClose: () => setLive(false),
    onMessage: (e: MessageEvent) => {
      let msg: Record<string, unknown>;
      // The agents protocol shares this socket; its own frames are ignored.
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (msg.type === "hello") setRuns((prev) => (msg.runs as RunSummary[]).map((run) => mergeRunState(prev.find((r) => r.runId === run.runId), run)));
      else if (msg.type === "run.open") {
        const run = msg.run as RunSummary;
        upsert(run);
        if (followRef.current) select(run.runId, false);
      } else if (msg.type === "run.close") {
        upsert(msg.run as RunSummary & { runId: string });
      } else if (msg.type === "events") {
        const incoming = msg.events as RunEventRow[];
        if (!incoming.length) return;
        // The summary of a run that opened over the socket has no text yet; its first message does.
        for (const ev of incoming) {
          const text = ev.event === "message.in" || ev.event === "message.stored" ? ev.fields.text : undefined;
          if (typeof text === "string") setRuns((prev) => prev.map((r) => (r.runId === ev.runId && !r.said ? { ...r, said: text } : r)));
        }
        setEvents((prev) => {
          const next = { ...prev };
          for (const ev of incoming) {
            const list = next[ev.runId] ?? [];
            // A reconnect can replay; seq is the run's primary key.
            if (list.some((x) => x.seq === ev.seq)) continue;
            next[ev.runId] = [...list, ev as TapeEvent].sort((a, b) => a.seq - b.seq);
          }
          return next;
        });
      }
    },
  });

  // Past runs, and a refresh whenever the chat filter changes.
  useEffect(() => {
    const url = `/api/runs?limit=100${chat ? `&chat=${encodeURIComponent(chat)}` : ""}${tokenParam}`;
    const controller = new AbortController();
    const refresh = () => fetch(url, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`the server answered ${r.status}`);
        return r.json() as Promise<{ runs: RunSummary[] }>;
      })
      .then((d) => {
        setProblem(null);
        setRuns((prev) => d.runs.map((run) => mergeRunState(prev.find((r) => r.runId === run.runId), run)));
      })
      // A blank list with no explanation is indistinguishable from "no runs yet".
      .catch((e: Error) => { if (!controller.signal.aborted) setProblem(e.message); });
    void refresh();
    // Live runs arrive over the socket; this only catches what it missed, so a
    // tab nobody is looking at does not keep reading the database.
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [chat, tokenParam]);

  // Landing on bare /runs with an empty pane is a dead end; open the newest.
  useEffect(() => {
    if (!selected && runs.length) select(runs[0].runId, false);
  }, [selected, runs, select]);

  const chats = useMemo(() => [...new Set(runs.map((r) => r.chat))], [runs]);
  const shown = chat ? runs.filter((r) => r.chat === chat) : runs;
  const allSessions = useMemo(() => groupIntoSessions(shown), [shown]);
  const sessions = allSessions.filter(session => statusFilter === "all" || runStatus(sessionSummary(session)).key === statusFilter);
  const selectedRun = runs.find(run => run.runId === selected) ?? (linked?.runId === selected ? linked : undefined);
  const selectedSession = groupIntoSessions(selectedRun && !runs.some(run => run.runId === selectedRun.runId) ? [...runs, selectedRun] : runs)
    .find(session => session.runs.some(run => run.runId === selected));
  const detail = selectedSession ? sessionSummary(selectedSession) : undefined;
  const memberIds = JSON.stringify(selectedSession?.runs.map(run => run.runId).sort() ?? (selected ? [selected] : []));

  // Load every turn in the selected conversation. Live events still merge by
  // their original run ID and sequence number, so reconnects cannot duplicate them.
  useEffect(() => {
    const ids = JSON.parse(memberIds) as string[];
    if (!ids.length) return;
    const controller = new AbortController();
    let refreshing = false;
    const refresh = async (ids: string[]) => {
      if (refreshing || !ids.length) return;
      refreshing = true;
      let failed = false;
      for (let i = 0; i < ids.length && !controller.signal.aborted; i += 4) {
        await Promise.all(ids.slice(i, i + 4).map(async id => {
          try {
            const response = await fetch(`/api/runs/${encodeURIComponent(id)}?${tokenParam.slice(1)}`, { signal: controller.signal });
            if (!response.ok) throw new Error('Could not load turn');
            const data = await response.json() as { run: RunSummary; events: TapeEvent[] };
            if (controller.signal.aborted) return;
            setEvents(prev => ({ ...prev, [id]: [...new Map([...(prev[id] ?? []), ...data.events].map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq) }));
            if (id === selected) setLinked(prev => mergeRunState(prev?.runId === id ? prev : undefined, data.run));
            upsert(data.run);
          } catch { failed = true; }
        }));
      }
      if (!controller.signal.aborted) setDetailProblem(failed);
      refreshing = false;
    };
    setDetailProblem(false);
    void refresh(ids);
    // A closed run's events never change, so only turns still open are read
    // again, and only while someone is looking.
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refresh(ids.filter(id => runsRef.current.find(run => run.runId === id)?.ended == null));
    }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [memberIds, selected, tokenParam, upsert]);

  const combinedEvents = selectedSession ? sessionEvents(selectedSession, events).map(event => {
    const key = `${event.sourceRunId}:${event.sourceSeq}`;
    if (!eventIds.current.has(key)) eventIds.current.set(key, eventIds.current.size + 1);
    return { ...event, seq: eventIds.current.get(key)! };
  }) : [];
  const nodes = toNodes(combinedEvents, detail?.started);
  useEffect(() => {
    if (initialStep.current === null) return;
    const event = combinedEvents.find(event => event.sourceRunId === selected && event.sourceSeq === Number(initialStep.current));
    if (event) { setPicked(event.seq); initialStep.current = null; }
  }, [combinedEvents, selected]);
  const pickedNode = picked === null ? null : (nodes.find((n) => n.seq === picked) ?? null);
  const t0 = nodes[0]?.ts ?? detail?.started ?? 0;

  // A picked step opens in a panel over the middle of the page. Escape closes
  // it; the arrow keys walk the tape without leaving it.
  const stepBy = (by: number) => {
    const i = nodes.findIndex((n) => n.seq === picked);
    const next = nodes[i + by];
    return i === -1 || !next ? undefined : () => setPicked(next.seq);
  };
  useEffect(() => {
    if (picked === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicked(null);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") stepBy(-1)?.(), e.preventDefault();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") stepBy(1)?.(), e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const columns = mid ? (wide ? "300px minmax(0,1fr)" : "280px minmax(0,1fr)") : "minmax(0,1fr)";
  const showRail = mid || railOpen || !detail;
  const showTape = mid || !showRail;

  return (
    <div className="rv" style={{ display: "grid", gridTemplateColumns: columns, height: "100vh", fontFamily: "var(--sans)" }}>
      <style>{THEME_CSS}</style>
      <link rel="stylesheet" href={FONT_LINK} />

      {showRail && (
        <aside style={{ borderRight: mid ? "1px solid var(--hair)" : 0, overflowY: "auto", minHeight: 0 }}>
          <header style={{ padding: "18px 18px 14px", position: "sticky", top: 0, background: "var(--ground)", zIndex: 2 }}>
            <LandingBackLink />
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <a href="/" style={{ textDecoration: "none", fontFamily: "var(--sans)", fontWeight: 600, fontSize: 16, letterSpacing: "-0.01em", lineHeight: 1 }}>Whim</a>
              <span className="rv-meta">Telemetry</span>
              <span className={`rv-connection${live ? " is-live" : ""}`} title={live ? "New activity appears immediately" : "Reconnecting; history refreshes every 15 seconds"}><i aria-hidden="true" />{live ? "Live" : "Reconnecting"}</span>
            </div>
            {problem ? (
              <p style={{ margin: "10px 0 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--error)" }}>
                {`Failed to load runs: ${problem}`}
              </p>
            ) : null}
            <p style={{ fontSize: 11, color: "var(--soft)", margin: "14px 0 0" }}>Conversations · grouped across turns</p>
            <div className="rv-filter-grid" aria-label="Filter runs by status">
              {([['all', 'All conversations'], ['active', 'In progress'], ['attention', 'Needs attention'], ['finished', 'Finished']] as const).map(([key, label]) => <button key={key} aria-pressed={statusFilter === key} onClick={() => { setStatusFilter(key); setFollow(false); }}><span>{label}</span><b>{allSessions.filter(session => key === 'all' || runStatus(sessionSummary(session)).key === key).length}</b></button>)}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
              <span className="rv-select">
                <select value={chat} onChange={(e) => setChat(e.target.value)} aria-label="Chat">
                  <option value="">All chats</option>
                  {chats.map((c) => (
                    <option key={c} value={c}>
                      {c.slice(0, 12)}
                    </option>
                  ))}
                </select>
              </span>
              <button className={`rv-btn${follow ? " is-on" : ""}`} onClick={() => { if (!follow) setStatusFilter("all"); setFollow((f) => !f); }} aria-pressed={follow} title="Open each new run as it starts">
                {follow ? "Auto-follow on" : "Auto-follow off"}
              </button>
              <button className={`rv-btn${raw ? " is-on" : ""}`} onClick={() => setRaw((r) => !r)} aria-pressed={raw} title="Print every step's fields on the tape">
                Technical fields
              </button>
              <button className="rv-btn is-quiet" onClick={flipTheme} title="Toggle theme">
                {theme === "light" ? "Dark" : "Light"}
              </button>
            </div>
          </header>
          {sessions.map(session => <SessionRow key={session.id} session={session} selected={session.id === selectedSession?.id} onClick={() => { setFollow(false); select(session.runs[0].runId); }} />)}
          {!sessions.length && !problem && (
            <p style={{ color: "var(--soft)", padding: "16px 18px", fontSize: 13.5, borderTop: "1px solid var(--hair)", margin: 0, maxWidth: "36ch" }}>
              {statusFilter === "all" ? "No conversations to show yet." : "No conversations match this status."}
              {isLocal ? <> Or, in a terminal: <code style={{ fontFamily: "var(--mono)", fontSize: 12 }}>POST /api/dev/message</code>.</> : null}
            </p>
          )}
        </aside>
      )}

      {showTape && (
        <section style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, }}>
          {detail ? (
            <>
              <RunHead run={detail} nodes={nodes} onBack={mid ? undefined : () => setRailOpen(true)} />
              <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 18px 0 12px" }}>
                {detailProblem && <p role="status" style={{ color: "var(--error)", fontSize: 12 }}>Some turns couldn’t load. Showing available activity; retrying automatically.</p>}
                <p className="rv-conversation-note">{selectedSession?.runs.length} recorded runs in this conversation · turns and background activity share one trace.</p>
                <RunOverview run={detail} events={nodes} onPick={setPicked} />
                <details className="rv-advanced" key={detail.runId}><summary>Performance & technical details<span>Timing, model usage, traces, and all recorded errors</span></summary><RunDiagnostics events={nodes} onPick={setPicked} run={detail} /></details>
                <details className="rv-trace" key={`trace-${detail.runId}`} open>
                  <summary>Activity trace <span>{nodes.length} events</span></summary>
                  <p>Each row shows time since the previous recorded event, then total elapsed time. Select a step for details.</p>
                  <details className="rv-colour-legend">
                    <summary>Colours</summary>
                    <ul aria-label="Event colour legend">
                      {Object.entries(SERVICES).map(([id, service]) => (
                        <li key={id}><i aria-hidden="true" style={{ background: `var(${service.v})` }} />{service.label}</li>
                      ))}
                      <li><i aria-hidden="true" style={{ background: "var(--error)" }} />Error</li>
                    </ul>
                  </details>
                  <RunTape run={detail} nodes={nodes} token={token} picked={picked} onPick={setPicked} raw={raw} />
                </details>
              </div>
            </>
          ) : (
            <p style={{ color: "var(--soft)", padding: 24, margin: 0 }}>{runs.length ? "Select a run." : "No runs yet."}</p>
          )}
        </section>
      )}

      {pickedNode && detail && (
        <div className="rv-scrim" onClick={(e) => e.target === e.currentTarget && setPicked(null)}>
          <div className="rv-sheet" role="dialog" aria-modal="true" aria-label="Step detail">
            <StepDetail node={pickedNode} t0={t0} chat={detail.chat} onClose={() => setPicked(null)} onPrev={stepBy(-1)} onNext={stepBy(1)} />
          </div>
        </div>
      )}
    </div>
  );
}

function LandingBackLink() {
  return (
    <a href="/" className="rv-btn is-quiet" style={{ textDecoration: "none", marginBottom: 14 }}>
      <span aria-hidden="true">←</span> Back to home
    </a>
  );
}

function SessionRow({ session, selected, onClick }: { session: RunSession; selected: boolean; onClick: () => void }) {
  const summary = sessionSummary(session);
  const label = runLabel(summary);
  const status = runStatus(summary);
  const turns = session.runs.filter(run => run.outcome !== "background").length;
  return <button className={`rv-run rv-conversation${selected ? " is-selected" : ""}`} onClick={onClick} aria-current={selected ? "true" : undefined}>
    <span className="rv-conversation-title">{label.title}</span>
    <span className="rv-conversation-meta"><span className={`rv-status is-${status.key}`}>{status.label}</span><span>{turns} turn{turns === 1 ? "" : "s"}</span><time>{clock(session.to)}</time></span>
    <span className="rv-conversation-chat" title={session.chat}>Chat {session.chat.slice(0, 8)}</span>
  </button>;
}

/** Keep the selected run’s identity and result visible above its activity. */
function RunHead({ run, nodes, onBack }: { run: RunSummary; nodes: { ts: number; ms: number | null; event: string; fields: Record<string, unknown> }[]; onBack?: () => void }) {
  const wall = nodes.length ? nodes[nodes.length - 1].ts - nodes[0].ts : null;
  const asked = nodes.find((n) => (n.event === "message.in" || n.event === "message.stored") && typeof n.fields.text === "string");
  const label = runLabel({ ...run, said: (asked?.fields.text as string | undefined)?.trim() || run.said });
  const title = label.title;
  const facts = [
    wall != null ? `${dur(wall)} recorded` : null,
    `${nodes.length || run.events} event${(nodes.length || run.events) === 1 ? "" : "s"}`,
  ].filter(Boolean) as string[];
  return (
    <header style={{ flex: "none", padding: "18px 18px 0", borderBottom: "1px solid var(--hair)" }}>
      {onBack && <LandingBackLink />}
      <div style={{ display: "flex", alignItems: "stretch", gap: 18 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rv-meta" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {onBack && (
              <button className="rv-btn is-quiet" onClick={onBack} style={{ padding: "3px 8px" }}>All conversations</button>
            )}
            <span className={`rv-status is-${runStatus(run).key}`}>{runStatus(run).label}</span>
            <span title={run.chat} style={{ fontFamily: "var(--mono)", fontSize: 11.5 }}>{run.chat.slice(0, 8)}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{new Date(run.started).toLocaleString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" })}</span>
          </div>
          <h1 className="rv-clamp2" title={title} style={{ margin: "10px 0 0", fontFamily: "var(--sans)", fontWeight: 600, fontSize: title.length > 60 ? 17 : 20, lineHeight: 1.25, letterSpacing: "-0.01em", textWrap: "balance", maxWidth: "34ch" }}>
            {title}
          </h1>
          {label.detail && <p style={{ margin: "8px 0", fontSize: 12, color: "var(--soft)", overflowWrap: "anywhere" }}>{label.detail}</p>}
          <p style={{ margin: "10px 0 8px", display: "flex", gap: 14, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 12, color: "var(--soft)", fontVariantNumeric: "tabular-nums" }}>
            {facts.map((f) => <span key={f}>{f}</span>)}
          </p>
          {run.outcome === "timed_out" && <div role="alert" style={{ color: "var(--error)", margin: "12px 0", fontSize: 13 }}>
            <strong>Run timed out.</strong> {RUN_TIMEOUT_MESSAGE}
            {(run.tools.includes("book_option") || nodes.some((n) => n.event.startsWith("pay."))) && " Check the actual booking or payment status before retrying."}

          </div>}

        </div>

      </div>
    </header>
  );
}

const EMPTY_RUN: RunSummary = {
  runId: "", chat: "", trigger: null, started: Date.now(), ended: null,
  outcome: null, level: "info", ms: null, tokens: null, steps: null, tools: [], events: 0,
};
