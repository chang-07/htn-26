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
import { FONT_LINK, SERVICES, THEME_CSS, clock, dur, levelColor, servicesForTools } from "./ui";

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
  const [showBackground, setShowBackground] = useState(false);
  // ?step=<seq> opens that step's panel, so one step of a run can be linked to.
  const [picked, setPicked] = useState<number | null>(() => {
    const step = Number(new URLSearchParams(window.location.search).get("step") ?? NaN);
    return Number.isInteger(step) ? step : null;
  });
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
    const timer = window.setInterval(refresh, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [chat, tokenParam]);

  // A run picked from the list has its events in D1, not in memory.
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    const refresh = () => fetch(`/api/runs/${selected}?${tokenParam.slice(1)}`, { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ run: RunSummary; events: TapeEvent[] }>) : null))
      .then((d) => {
        if (!d) return;
        setEvents((prev) => ({ ...prev, [selected]: [...new Map([...(prev[selected] ?? []), ...d.events].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq) }));
        setLinked((prev) => mergeRunState(prev?.runId === d.run.runId ? prev : undefined, d.run));
        upsert(d.run);
      })
      .catch(() => {});
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [selected, tokenParam, upsert]);

  // Landing on bare /runs with an empty pane is a dead end; open the newest.
  useEffect(() => {
    if (!selected && runs.length) select(runs[0].runId, false);
  }, [selected, runs, select]);

  const chats = useMemo(() => [...new Set(runs.map((r) => r.chat))], [runs]);
  const shown = chat ? runs.filter((r) => r.chat === chat) : runs;
  const filtered = shown.filter(run => statusFilter === "all" || runStatus(run).key === statusFilter);
  const sessions = useMemo(
    () =>
      groupIntoSessions(filtered)
        .map((sess) => ({ ...sess, visible: showBackground || statusFilter !== "all" ? sess.runs : sess.runs.filter((r) => !isBackground(r)) }))
        // A session of nothing but background work — an e2e script, a dev tool
        // call — has no turn to look at, so it stays out of the way.
        .filter((sess) => sess.visible.length),
    [shown, showBackground, statusFilter],
  );

  // A session opens when it holds the selected run, or when anything in it is
  // still going — the two cases where its turns are worth seeing.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isOpen = (sess: Session) =>
    collapsed[sess.id] === undefined
      ? statusFilter !== "all" || sess.runs.some((r) => r.runId === selected || r.ended === null)
      : !collapsed[sess.id];

  const detail = selected
    ? (runs.find((r) => r.runId === selected) ?? (linked?.runId === selected ? linked : undefined))
    : undefined;

  // Selecting a hidden run — from a link, or from following a live one — has to
  // reveal it rather than leave the rail looking like it does not exist.
  useEffect(() => {
    if (!showBackground && detail && isBackground(detail)) setShowBackground(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the selection changes
  }, [selected]);

  const nodes = useMemo(() => toNodes(detail ? (events[detail.runId] ?? []) : []), [detail, events]);
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
            <p style={{ fontSize: 11, color: "var(--soft)", margin: "14px 0 0" }}>Recent activity · counts reflect loaded runs</p>
            <div className="rv-filter-grid" aria-label="Filter runs by status">
              {([['all', 'All runs'], ['active', 'In progress'], ['attention', 'Needs attention'], ['finished', 'Finished']] as const).map(([key, label]) => <button key={key} aria-pressed={statusFilter === key} onClick={() => { setStatusFilter(key); setFollow(false); }}><span>{label}</span><b>{shown.filter(run => key === 'all' || runStatus(run).key === key).length}</b></button>)}
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
              <button
                className={`rv-btn${showBackground ? " is-on" : ""}`}
                onClick={() => setShowBackground((b) => !b)}
                aria-pressed={showBackground}
                title="Work that happened outside a model turn: workflow callbacks, browser steps, form submissions, dev tool calls."
              >
                Background activity
              </button>
              <button className={`rv-btn${raw ? " is-on" : ""}`} onClick={() => setRaw((r) => !r)} aria-pressed={raw} title="Print every step's fields on the tape">
                Technical fields
              </button>
              <button className="rv-btn is-quiet" onClick={flipTheme} title="Toggle theme">
                {theme === "light" ? "Dark" : "Light"}
              </button>
            </div>
          </header>
          {sessions.map((sess) => (
            <div key={sess.id} style={{ borderTop: "1px solid var(--hair)" }}>
              <SessionHeader
                session={sess}
                open={isOpen(sess)}
                onToggle={() => setCollapsed((c) => ({ ...c, [sess.id]: isOpen(sess) }))}
              />
              {isOpen(sess) &&
                sess.visible.map((r) => (
                  <RunRow key={r.runId} run={r} selected={r.runId === selected} onClick={() => { setFollow(false); select(r.runId); }} />
                ))}
            </div>
          ))}
          {!sessions.length && !problem && (
            <p style={{ color: "var(--soft)", padding: "16px 18px", fontSize: 13.5, borderTop: "1px solid var(--hair)", margin: 0, maxWidth: "36ch" }}>
              {statusFilter === "all" ? "No runs to show. Try including background activity." : "No runs match this status."}
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
                <RunOverview run={detail} events={nodes} onPick={setPicked} />
                <div className="rv-feed-heading"><h2>Activity, step by step</h2><p>Read from top to bottom. Select a step to inspect its details.</p></div>
                <RunTape run={detail} nodes={nodes} token={token} picked={picked} onPick={setPicked} raw={raw} />
                <details className="rv-advanced" key={detail.runId}><summary>Performance & technical details<span>Timing, model usage, traces, and all recorded errors</span></summary><RunDiagnostics events={nodes} onPick={setPicked} run={detail} /></details>
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

/** The outcome as one word, for beside a title that no longer says it. */
const OUTCOME_WORD: Record<string, string> = { timed_out: "timed out", replied: "replied", silent: "no reply", llm_failed: "model error", max_steps: "max steps", background: "background" };

type Session = { id: string; chat: string; runs: RunSummary[]; from: number; to: number };
type ShownSession = Session & { visible: RunSummary[] };

/**
 * A run with no model turn behind it: a research callback landing between
 * turns, a booking workflow's browser steps, a profile form submission, a dev
 * tool call. Real work — the booking is genuinely happening — but it is part of
 * a session's story rather than a turn of its own, and it costs no tokens. On a
 * busy chat these outnumber the turns, so the rail hides them by default.
 */
const isBackground = (r: RunSummary) => r.outcome === "background";

/**
 * A turn on its own is rarely the thing you want to look at — one conversation
 * produces a dozen of them. Runs in the same chat are gathered into a session,
 * split wherever the chat went quiet for longer than SESSION_GAP, so the rail
 * lists conversations and the turns sit underneath as sub-runs.
 */
const SESSION_GAP = 20 * 60 * 1000;

function groupIntoSessions(runs: RunSummary[]): Session[] {
  const byChat = new Map<string, RunSummary[]>();
  for (const r of runs) {
    const list = byChat.get(r.chat) ?? [];
    list.push(r);
    byChat.set(r.chat, list);
  }
  const out: Session[] = [];
  for (const [chat, list] of byChat) {
    // Newest first everywhere else, so walk oldest-first to find the breaks.
    const asc = [...list].sort((a, b) => a.started - b.started);
    let current: RunSummary[] = [];
    const flush = () => {
      if (!current.length) return;
      out.push({
        id: `${chat}:${current[0].started}`,
        chat,
        runs: [...current].reverse(),
        from: current[0].started,
        to: current[current.length - 1].started,
      });
      current = [];
    };
    for (const r of asc) {
      if (current.length && r.started - current[current.length - 1].started > SESSION_GAP) flush();
      current.push(r);
    }
    flush();
  }
  return out.sort((a, b) => b.to - a.to);
}

function SessionHeader({ session, open, onToggle }: { session: ShownSession; open: boolean; onToggle: () => void }) {
  const live = session.runs.filter((r) => r.ended === null).length;
  const bad = session.runs.filter((r) => r.level === "error").length;
  const tokens = session.runs.reduce((n, r) => n + (r.tokens ?? 0), 0);
  const turns = session.runs.filter((r) => !isBackground(r)).length;
  const background = session.runs.length - turns;
  const facts = [
    `${turns} turn${turns === 1 ? "" : "s"}`,
    background ? `${background} background` : null,
    tokens ? `${tokens.toLocaleString()} tok` : null,
    bad ? `${bad} failed` : null,
  ].filter(Boolean);
  return (
    <button className="rv-session" onClick={onToggle} aria-expanded={open}>
      <span aria-hidden style={{ width: 0, height: 0, borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: open ? "6px solid var(--soft)" : 0, borderBottom: open ? 0 : "6px solid var(--soft)", transform: open ? "none" : "rotate(-90deg)", flex: "none" }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontFamily: "var(--sans)", fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            <span title={session.chat} style={{ fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 500 }}>{session.chat.slice(0, 8)}</span>
          </span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{clock(session.to)}</span>
        </span>
        <span style={{ display: "flex", gap: 10, marginTop: 3, fontFamily: "var(--mono)", fontSize: 11, color: bad ? "var(--error)" : "var(--soft)", flexWrap: "wrap" }}>
          {facts.map((f) => <span key={f as string}>{f}</span>)}
          {live > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ink)", marginLeft: "auto" }}>
              <i className="rv-live" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ink)" }} />
              {live > 1 ? `${live} running` : "running"}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** What each outcome code means, in a sentence a judge can read from the back of the room. */


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
      <div style={{ display: "flex", alignItems: "stretch", gap: 18 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rv-meta" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {onBack && (
              <button className="rv-btn is-quiet" onClick={onBack} style={{ padding: "3px 8px" }}>All runs</button>
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
            {nodes.find((n) => n.event === "run.timeout")?.fields.sentryEventId != null && <p style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
              Sentry event: {String(nodes.find((n) => n.event === "run.timeout")?.fields.sentryEventId)}
            </p>}
          </div>}

        </div>

      </div>
    </header>
  );
}

function RunRow({ run, selected, onClick }: { run: RunSummary; selected: boolean; onClick: () => void }) {
  const label = runLabel(run);
  const running = run.ended === null;
  const quiet = run.outcome === "silent" || run.outcome === "background";
  const facts = [
    running ? "running" : run.outcome && run.outcome !== "replied" ? (OUTCOME_WORD[run.outcome] ?? run.outcome) : null,
    run.ms !== null ? dur(run.ms) : null,
    run.tokens ? `${run.tokens.toLocaleString()} tok` : null,
  ].filter(Boolean) as string[];
  return (
    <button className={`rv-run${selected ? " is-selected" : ""}`} onClick={onClick} aria-current={selected ? "true" : undefined}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5 }}>
        <i
          className={running ? "rv-live" : undefined}
          style={{ width: 6, height: 6, borderRadius: "50%", background: running ? "var(--ink)" : levelColor(run.level), flexShrink: 0 }}
        />
        <span className="rv-clamp2" title={label.title} style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere", fontFamily: "var(--sans)", fontWeight: selected ? 600 : 500, color: quiet && !selected ? "var(--soft)" : undefined }}>
          {label.title}
        </span>
        <span style={{ color: "var(--faint)", fontFamily: "var(--mono)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{clock(run.started)}</span>
      </span>
      {label.detail && <span className="rv-clamp2" title={label.detail} style={{ margin: "5px 0 0 14px", fontSize: 11, color: "var(--soft)", textAlign: "left", overflowWrap: "anywhere" }}>{label.detail}</span>}
      <span style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, fontFamily: "var(--mono)", fontSize: 11, color: "var(--soft)", flexWrap: "wrap" }}>
        <span style={{ display: "flex", gap: 3 }}>
          {servicesForTools(run.tools).map((s) => (
            <i key={s} title={SERVICES[s].label} style={{ width: 6, height: 6, borderRadius: "50%", background: `var(${SERVICES[s].v})` }} />
          ))}
        </span>
        <span className={`rv-status is-${runStatus(run).key}`}>{runStatus(run).label}</span>
        {facts.filter(f => f !== "running" && f !== OUTCOME_WORD[run.outcome ?? ""]).map((f) => <span key={f}>{f}</span>)}
      </span>
    </button>
  );
}

const EMPTY_RUN: RunSummary = {
  runId: "", chat: "", trigger: null, started: Date.now(), ended: null,
  outcome: null, level: "info", ms: null, tokens: null, steps: null, tools: [], events: 0,
};
