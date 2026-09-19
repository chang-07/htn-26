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
  /**
   * /runs?token=… — the API and the live socket both need it when RUNS_TOKEN is
   * set. Once a working token has been seen it is remembered, so a bare /runs
   * keeps working and the link only has to carry it the first time. Per-viewer
   * convenience only: it never leaves this browser, and a 401 clears it.
   */
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
      next[i] = { ...next[i], ...run };
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
      if (msg.type === "hello") setRuns(msg.runs as RunSummary[]);
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
    fetch(url)
      .then(async (r) => {
        if (r.status === 401) {
          // A remembered token that no longer works would wedge the page.
          try {
            localStorage.removeItem(TOKEN_KEY);
          } catch {
            /* nothing stored */
          }
          throw new Error("locked");
        }
        if (!r.ok) throw new Error(`the server answered ${r.status}`);
        return r.json() as Promise<{ runs: RunSummary[] }>;
      })
      .then((d) => {
        setProblem(null);
        setRuns(d.runs);
      })
      // A blank list with no explanation is indistinguishable from "no runs yet".
      .catch((e: Error) => setProblem(e.message));
  }, [chat, tokenParam]);

  // A run picked from the list has its events in D1, not in memory.
  useEffect(() => {
    if (!selected || events[selected]) return;
    fetch(`/api/runs/${selected}?${tokenParam.slice(1)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ run: RunSummary; events: TapeEvent[] }>) : null))
      .then((d) => {
        if (!d) return;
        setEvents((prev) => ({ ...prev, [selected]: d.events }));
        setLinked(d.run);
      })
      .catch(() => {});
  }, [selected, events, tokenParam]);

  // Landing on bare /runs with an empty pane is a dead end; open the newest.
  useEffect(() => {
    if (!selected && runs.length) select(runs[0].runId, false);
  }, [selected, runs, select]);

  const chats = useMemo(() => [...new Set(runs.map((r) => r.chat))], [runs]);
  const shown = chat ? runs.filter((r) => r.chat === chat) : runs;
  const sessions = useMemo(
    () =>
      groupIntoSessions(shown)
        .map((sess) => ({ ...sess, visible: showBackground ? sess.runs : sess.runs.filter((r) => !isBackground(r)) }))
        // A session of nothing but background work — an e2e script, a dev tool
        // call — has no turn to look at, so it stays out of the way.
        .filter((sess) => sess.visible.length),
    [shown, showBackground],
  );

  // A session opens when it holds the selected run, or when anything in it is
  // still going — the two cases where its turns are worth seeing.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const isOpen = (sess: Session) =>
    collapsed[sess.id] === undefined
      ? sess.runs.some((r) => r.runId === selected || r.ended === null)
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
        <aside style={{ borderRight: mid ? "2px dotted var(--rule)" : 0, overflowY: "auto", minHeight: 0 }}>
          <header style={{ padding: "18px 18px 14px", position: "sticky", top: 0, background: "var(--ground)", zIndex: 2 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <a href="/" style={{ textDecoration: "none", fontFamily: "var(--sans)", fontWeight: 800, fontSize: 22, letterSpacing: "-0.02em", lineHeight: 1 }}>Plan</a>
              <span className="rv-meta">run viewer</span>
              <span
                title={live ? "Connected: new runs appear as they happen" : "Not connected. New runs will not appear until it reconnects."}
                aria-label={live ? "connected" : "disconnected"}
                style={{ marginLeft: "auto", width: 9, height: 9, background: live ? "var(--good)" : "var(--faint)" }}
              />
            </div>
            {problem ? (
              <p style={{ margin: "10px 0 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--error)" }}>
                {problem === "locked" ? "This viewer is locked." : `Couldn't load runs: ${problem}`}
              </p>
            ) : null}
            {problem === "locked" ? (
              // Asked for once per browser. The key is RUNS_TOKEN; it is kept in this browser only.
              <form
                style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "flex-end" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const key = String(new FormData(e.currentTarget).get("key") ?? "").trim();
                  if (!key) return;
                  try {
                    localStorage.setItem(TOKEN_KEY, key);
                    window.location.reload();
                  } catch {
                    // No storage (private window): carry it in the URL for this visit instead.
                    window.location.search = `?token=${encodeURIComponent(key)}`;
                  }
                }}
              >
                <input className="rv-input" name="key" type="password" placeholder="Viewer key" autoFocus autoComplete="current-password" style={{ flex: 1 }} aria-label="Viewer key" />
                <button className="rv-btn is-go" type="submit">Unlock</button>
              </form>
            ) : null}
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
              <button className={`rv-btn${follow ? " is-on" : ""}`} onClick={() => setFollow((f) => !f)} aria-pressed={follow} title="Open each new run as it starts">
                Follow
              </button>
              <button
                className={`rv-btn${showBackground ? " is-on" : ""}`}
                onClick={() => setShowBackground((b) => !b)}
                aria-pressed={showBackground}
                title="Work that happened outside a model turn: workflow callbacks, browser steps, form submissions, dev tool calls."
              >
                Background
              </button>
              <button className={`rv-btn${raw ? " is-on" : ""}`} onClick={() => setRaw((r) => !r)} aria-pressed={raw} title="Print every step's fields on the tape">
                Raw
              </button>
              <button className="rv-btn is-quiet" onClick={flipTheme} title="Switch between paper and night">
                {theme === "light" ? "Night" : "Paper"}
              </button>
            </div>
          </header>
          {sessions.map((sess) => (
            <div key={sess.id} style={{ borderTop: "2px dotted var(--rule)" }}>
              <SessionHeader
                session={sess}
                open={isOpen(sess)}
                onToggle={() => setCollapsed((c) => ({ ...c, [sess.id]: isOpen(sess) }))}
              />
              {isOpen(sess) &&
                sess.visible.map((r) => (
                  <RunRow key={r.runId} run={r} selected={r.runId === selected} onClick={() => select(r.runId)} />
                ))}
            </div>
          ))}
          {!shown.length && !problem && (
            <p style={{ color: "var(--soft)", padding: "16px 18px", fontSize: 13.5, borderTop: "2px dotted var(--rule)", margin: 0, maxWidth: "36ch" }}>
              No runs yet. Text the number and the first turn appears here as it happens.
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
                <RunDiagnostics events={nodes} onPick={setPicked} />
                <RunTape run={detail} nodes={nodes} token={token} picked={picked} onPick={setPicked} raw={raw} />
              </div>
            </>
          ) : (
            <p style={{ color: "var(--soft)", padding: 24, margin: 0 }}>{runs.length ? "Pick a run from the rail." : "The first run will open here by itself."}</p>
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

/** The six inks, named once, so a projected page needs no explaining. */
function Legend() {
  return (
    <p style={{ margin: "0 0 12px", display: "flex", flexWrap: "wrap", gap: "4px 14px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--soft)" }}>
      {(Object.keys(SERVICES) as (keyof typeof SERVICES)[]).map((k) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <i style={{ width: 8, height: 8, background: `var(${SERVICES[k].v})` }} />
          {SERVICES[k].label}
        </span>
      ))}
    </p>
  );
}

/** A run is named by what was said to it; failing that, by what woke it. */
const runTitle = (run: RunSummary) =>
  // The rail is what a projector shows first, so an address typed into a chat stays off it.
  run.said?.trim().replace(/\s+/g, " ").replace(/\S+@\S+/g, "(email)") || (run.outcome !== "background" && OUTCOME_TITLE[run.outcome ?? ""]) || (run.trigger ?? "run").replace(/[._]/g, " ");

/** The outcome as one word, for beside a title that no longer says it. */
const OUTCOME_WORD: Record<string, string> = { replied: "replied", silent: "stayed quiet", llm_failed: "model failed", max_steps: "step ceiling", background: "background" };

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
        <span style={{ display: "flex", gap: 10, marginTop: 3, fontFamily: "var(--mono)", fontSize: 11, color: bad ? "var(--error)" : "var(--soft)", whiteSpace: "nowrap", overflow: "hidden" }}>
          {facts.map((f) => <span key={f as string}>{f}</span>)}
          {live > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ink)", marginLeft: "auto" }}>
              <i className="rv-live" style={{ width: 7, height: 7, background: "var(--ink)" }} />
              {live > 1 ? `${live} running` : "running"}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** What each outcome code means, in a sentence a judge can read from the back of the room. */
const OUTCOME_TITLE: Record<string, string> = {
  replied: "It replied",
  silent: "It stayed quiet",
  llm_failed: "The model call failed",
  max_steps: "It hit the step ceiling",
  background: "Work between turns",
};

/**
 * The run's head, drawn as the ticket's: meta row, title, and a stub that
 * counts the one number the room cares about. Wall clock and turn time differ
 * on purpose: research runs in a workflow outside the turn, so a short turn can
 * sit inside a long run.
 */
function RunHead({ run, nodes, onBack }: { run: RunSummary; nodes: { ts: number; ms: number | null; event: string; fields: Record<string, unknown> }[]; onBack?: () => void }) {
  const running = run.ended === null;
  const wall = nodes.length ? nodes[nodes.length - 1].ts - nodes[0].ts : null;
  const slowest = [...nodes].filter((n) => n.ms != null && n.event !== "turn.end" && !["agent", "workflow", "workflow.step"].includes(String(n.fields.op))).sort((a, b) => (b.ms as number) - (a.ms as number))[0];
  const asked = nodes.find((n) => (n.event === "message.in" || n.event === "message.stored") && typeof n.fields.text === "string");
  const title = (asked?.fields.text as string | undefined)?.trim() || run.said?.trim() || (running ? "Running now" : (OUTCOME_TITLE[run.outcome ?? ""] ?? run.outcome ?? "Run"));
  const verdict = running ? "running now" : (OUTCOME_TITLE[run.outcome ?? ""] ?? run.outcome ?? "run");
  const facts = [
    wall != null ? `${dur(wall)} wall` : null,
    run.ms != null ? `${dur(run.ms)} in turn` : null,
    `${nodes.length || run.events} event${(nodes.length || run.events) === 1 ? "" : "s"}`,
    slowest ? `slowest ${slowest.fields.operation ?? slowest.event}` : null,
  ].filter(Boolean) as string[];
  return (
    <header style={{ flex: "none", padding: "18px 18px 0", borderBottom: "2px dotted var(--rule)" }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 18 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rv-meta" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            {onBack && (
              <button className="rv-btn is-quiet" onClick={onBack} style={{ padding: "3px 8px" }}>All runs</button>
            )}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, color: run.level === "error" ? "var(--error)" : "var(--ink)" }}>
              <i className={running ? "rv-live" : undefined} style={{ width: 8, height: 8, background: running ? "var(--ink)" : levelColor(run.level) }} />
              {verdict}
            </span>
            <span title={run.chat}>chat {run.chat.slice(0, 8)}</span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{new Date(run.started).toLocaleString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" })}</span>
          </div>
          <h1 className="rv-clamp2" title={title} style={{ margin: "10px 0 0", fontFamily: "var(--sans)", fontWeight: 800, fontSize: title.length > 60 ? 20 : 25, lineHeight: 1.12, letterSpacing: "-0.02em", textWrap: "balance", maxWidth: "34ch" }}>
            {title}
          </h1>
          <p style={{ margin: "10px 0 8px", display: "flex", gap: 14, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 12, color: "var(--soft)", fontVariantNumeric: "tabular-nums" }}>
            {facts.map((f) => <span key={f}>{f}</span>)}
          </p>
          <Legend />
        </div>
        <div className="rv-stub" style={{ marginBottom: 14 }}>
          <b>{run.tokens ? run.tokens.toLocaleString() : "—"}</b>
          <span className="rv-meta">tokens</span>
        </div>
      </div>
    </header>
  );
}

function RunRow({ run, selected, onClick }: { run: RunSummary; selected: boolean; onClick: () => void }) {
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
          style={{ width: 7, height: 7, background: running ? "var(--ink)" : levelColor(run.level), flexShrink: 0 }}
        />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--sans)", fontWeight: selected ? 600 : 500, color: quiet && !selected ? "var(--soft)" : undefined }}>
          {runTitle(run)}
        </span>
        <span style={{ color: "var(--faint)", fontFamily: "var(--mono)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{clock(run.started)}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, fontFamily: "var(--mono)", fontSize: 11, color: "var(--soft)", whiteSpace: "nowrap", overflow: "hidden" }}>
        <span style={{ display: "flex", gap: 3 }}>
          {servicesForTools(run.tools).map((s) => (
            <i key={s} title={SERVICES[s].label} style={{ width: 8, height: 8, background: `var(${SERVICES[s].v})` }} />
          ))}
        </span>
        {facts.map((f) => <span key={f}>{f}</span>)}
      </span>
    </button>
  );
}

const EMPTY_RUN: RunSummary = {
  runId: "", chat: "", trigger: null, started: Date.now(), ended: null,
  outcome: null, level: "info", ms: null, tokens: null, steps: null, tools: [], events: 0,
};
