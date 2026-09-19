import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import type { RunEventRow, RunSummary } from "../server/runs";
import { RunGraph } from "./RunGraph";
import { FONT_LINK, FieldList, MONO, SERVICES, THEME_CSS, UI_FONT, btn, clock, dur, levelColor, servicesForTools } from "./ui";

/**
 * Live view of what the agent is doing, across every chat.
 *
 * Past runs come from /api/runs (D1). Runs happening right now arrive over the
 * RunHub WebSocket and are merged into the same list, so a turn triggered by a
 * text lands here a few hundred ms later and fills in step by step.
 */

type TimelineEvent = { seq: number; ts: number; level: string; event: string; fields: Record<string, unknown> };

const TOKEN_KEY = "runs.token";

/** /runs/<runId> — so a run found here can be pasted to someone else. */
const runIdFromPath = () => window.location.pathname.match(/^\/runs\/(.+)$/)?.[1] ?? null;

export function Runs() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(runIdFromPath);
  const [events, setEvents] = useState<Record<string, TimelineEvent[]>>({});
  const [chat, setChat] = useState<string>("");
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [mode, setMode] = useState<"graph" | "list">("graph");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [showBackground, setShowBackground] = useState(false);
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
      if (fromUrl) localStorage.setItem(TOKEN_KEY, fromUrl);
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
    window.history[push ? "pushState" : "replaceState"]({}, "", `/runs/${runId}`);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

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
        setEvents((prev) => {
          const next = { ...prev };
          for (const ev of incoming) {
            const list = next[ev.runId] ?? [];
            // A reconnect can replay; seq is the run's primary key.
            if (list.some((x) => x.seq === ev.seq)) continue;
            next[ev.runId] = [...list, ev as TimelineEvent].sort((a, b) => a.seq - b.seq);
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
      .then((r) => (r.ok ? (r.json() as Promise<{ run: RunSummary; events: TimelineEvent[] }>) : null))
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

  // Selecting a hidden run — from a link, or from following a live one — has to
  // reveal it rather than leave the rail looking like it does not exist.
  useEffect(() => {
    if (!showBackground && detail && isBackground(detail)) setShowBackground(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the selection changes
  }, [selected]);
  const detail = selected
    ? (runs.find((r) => r.runId === selected) ?? (linked?.runId === selected ? linked : undefined))
    : undefined;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(252px, 300px) 1fr", height: "100vh", background: "var(--paper)", color: "var(--ink)", fontFamily: UI_FONT }}>
      <style>{THEME_CSS}</style>
      <link rel="stylesheet" href={FONT_LINK} />
      <aside style={{ borderRight: `1px solid var(--rule)`, overflowY: "auto" }}>
        <header style={{ padding: "16px 16px 12px", position: "sticky", top: 0, background: "var(--paper)", borderBottom: `1px solid var(--rule)` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ fontSize: 16, margin: 0, flex: 1 }}>Agent runs</h1>
            {problem ? (
              <span style={{ fontSize: 12, color: "var(--error)" }}>
                {problem === "locked"
                  ? "Locked. Open this page once as /runs?token=<RUNS_TOKEN> and it will be remembered."
                  : `Couldn't load: ${problem}`}
              </span>
            ) : null}
            <span title={live ? "connected" : "disconnected"} style={{ width: 8, height: 8, borderRadius: 8, background: live ? "var(--good)" : "var(--muted)" }} />
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            <select value={chat} onChange={(e) => setChat(e.target.value)} style={selectStyle}>
              <option value="">all chats</option>
              {chats.map((c) => (
                <option key={c} value={c}>
                  {c.slice(0, 12)}
                </option>
              ))}
            </select>
            <label style={{ ...selectStyle, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              follow
            </label>
            <button
              onClick={() => setShowBackground((b) => !b)}
              style={{ ...btn, cursor: "pointer", ...(showBackground ? { color: "var(--accent)", borderColor: "var(--accent)" } : {}) }}
              title="Work that happened outside a model turn: workflow callbacks, browser steps, form submissions, dev tool calls."
            >
              background
            </button>
            <button
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              style={{ ...btn, cursor: "pointer" }}
            >
              {theme === "light" ? "dark" : "light"}
            </button>
            <button
              onClick={() => setMode((m) => (m === "graph" ? "list" : "graph"))}
              style={{ ...selectStyle, cursor: "pointer", fontFamily: MONO, marginLeft: "auto" }}
              title="The graph shows which services a turn touched; the list is easier to read field by field."
            >
              {mode === "graph" ? "graph" : "list"}
            </button>
          </div>
        </header>
        {sessions.map((sess) => (
          <div key={sess.id}>
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
        {!shown.length && <p style={{ color: "var(--muted)", padding: 16, fontSize: 13 }}>No runs yet. Text the agent, or POST /api/dev/message.</p>}
      </aside>

      <section style={{ display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0 }}>
        {detail && <Telemetry run={detail} events={events[detail.runId] ?? []} />}
        <div style={{ flex: 1, minHeight: 0, overflow: mode === "graph" ? "hidden" : "auto", padding: mode === "graph" ? 0 : 24 }}>
          {!detail ? (
            <p style={{ color: "var(--muted)", padding: 24 }}>Pick a run.</p>
          ) : mode === "graph" ? (
            <RunGraph run={detail} events={events[detail.runId] ?? []} token={token} />
          ) : (
            <Timeline run={detail} events={events[detail.runId] ?? []} />
          )}
        </div>
      </section>
    </div>
  );
}

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
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
        background: "var(--card-2)", border: 0, borderBottom: "1px solid var(--rule)",
        padding: "9px 14px", cursor: "pointer", font: "inherit", position: "sticky", top: 0, zIndex: 1,
      }}
    >
      <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--faint)", width: 9 }}>{open ? "▾" : "▸"}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {session.chat}
        </span>
        <span style={{ display: "block", fontFamily: MONO, fontSize: 9.5, color: "var(--faint)", marginTop: 2 }}>
          {turns} turn{turns === 1 ? "" : "s"}
          {background ? ` · ${background} background` : ""}
          {tokens ? ` · ${tokens.toLocaleString()} tok` : ""}
          {bad ? ` · ${bad} failed` : ""}
          {` · ${clock(session.to)}`}
        </span>
      </span>
      {live > 0 && (
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 9, color: "var(--accent)" }}>
          <span className="rg-live" style={{ width: 7, height: 7, borderRadius: 7, background: "var(--accent)" }} />
          {live > 1 ? `${live} running` : "running"}
        </span>
      )}
    </button>
  );
}

/**
 * Run totals, read before the detail. Wall clock and turn time differ on
 * purpose: research runs in a workflow outside the turn, so a short turn can
 * sit inside a long run.
 */
function Telemetry({ run, events }: { run: RunSummary; events: TimelineEvent[] }) {
  const wall = events.length ? events[events.length - 1].ts - events[0].ts : null;
  const slowest = [...events]
    .filter((e) => typeof e.fields.ms === "number")
    .sort((a, b) => (b.fields.ms as number) - (a.fields.ms as number))[0];
  const cells: [string, string, string?][] = [
    ["STATE", run.ended === null ? "live" : (run.outcome ?? "—"),
      run.ended === null ? "var(--accent)" : run.level === "error" ? "var(--error)" : undefined],
    ["WALL CLOCK", wall != null ? dur(wall) : "—"],
    ["IN TURN", run.ms != null ? dur(run.ms) : "—"],
    ["TOKENS", run.tokens ? run.tokens.toLocaleString() : "—"],
    ["STEPS", String(events.length || run.events)],
    ["SLOWEST", slowest ? slowest.event : "—"],
  ];
  return (
    <div style={{ display: "flex", borderBottom: "1px solid var(--rule)", background: "var(--card)", overflowX: "auto", flex: "none" }}>
      {cells.map(([label, value, color]) => (
        <div key={label} style={{ padding: "11px 18px", borderRight: "1px solid var(--rule)", minWidth: 104, flex: "none" }}>
          <b style={{ display: "block", fontFamily: MONO, fontSize: 16, fontWeight: 500, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", color: color ?? "var(--ink)" }}>
            {value}
          </b>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.1em", color: "var(--faint)" }}>{label}</span>
        </div>
      ))}
    </div>
  );
}

function RunRow({ run, selected, onClick }: { run: RunSummary; selected: boolean; onClick: () => void }) {
  const running = run.ended === null;
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left", background: selected ? "var(--card)" : "transparent",
        border: "none", borderBottom: `1px solid var(--rule)`, borderLeft: `2px solid ${selected ? "var(--accent)" : "transparent"}`,
        color: "var(--ink)", padding: "10px 16px", cursor: "pointer", font: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span
          className={running ? "rg-live" : undefined}
          style={{ width: 6, height: 6, borderRadius: 6, background: running ? "var(--accent)" : levelColor(run.level), flexShrink: 0 }}
        />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {running ? <em style={{ color: "var(--accent)" }}>running…</em> : (run.outcome ?? "—")}
        </span>
        <span style={{ color: "var(--muted)", fontSize: 11 }}>{clock(run.started)}</span>
      </div>
      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        {servicesForTools(run.tools).map((s) => (
          <span key={s} title={SERVICES[s].label} style={{ width: 16, height: 4, borderRadius: 2, background: `var(${SERVICES[s].v})` }} />
        ))}
      </div>
      <div style={{ color: "var(--faint)", fontSize: 10, marginTop: 6, display: "flex", gap: 9, fontFamily: MONO, whiteSpace: "nowrap", overflow: "hidden" }}>
        <span>{run.chat.slice(0, 10)}</span>
        {run.ms !== null && <span>{dur(run.ms)}</span>}
        {!!run.tokens && <span>{run.tokens.toLocaleString()} tok</span>}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{run.events} steps</span>
      </div>
    </button>
  );
}

function Timeline({ run, events }: { run: RunSummary; events: TimelineEvent[] }) {
  const t0 = events[0]?.ts ?? run.started;
  return (
    <>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>
        {run.trigger ?? "run"} · <span style={{ color: run.level === "error" ? "var(--error)" : "var(--muted)" }}>{run.ended === null ? "running" : (run.outcome ?? "—")}</span>
      </h2>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: "0 0 20px" }}>
        {run.chat} · {new Date(run.started).toLocaleString()}
        {run.ms !== null && ` · ${dur(run.ms)}`}
        {!!run.tokens && ` · ${run.tokens} tokens`}
        {run.steps !== null && ` · ${run.steps} steps`}
      </p>
      {events.map((e) => (
        <div key={e.seq} style={{ display: "grid", gridTemplateColumns: "56px 8px 1fr", gap: 10, padding: "6px 0", borderTop: `1px solid var(--rule)` }}>
          <span style={{ color: "var(--muted)", fontSize: 11, fontVariantNumeric: "tabular-nums", paddingTop: 2 }}>+{e.ts - t0}ms</span>
          <span style={{ width: 6, height: 6, borderRadius: 6, background: levelColor(e.level), marginTop: 7 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{e.event}</div>
            {!!Object.keys(e.fields).length && <FieldList fields={e.fields} />}
          </div>
        </div>
      ))}
      {!events.length && <p style={{ color: "var(--muted)", fontSize: 13 }}>No events recorded for this run.</p>}
    </>
  );
}

const selectStyle: React.CSSProperties = {
  background: "var(--card)", color: "var(--ink)", border: `1px solid var(--rule)`,
  borderRadius: 6, padding: "4px 8px", fontSize: 12,
};

const EMPTY_RUN: RunSummary = {
  runId: "", chat: "", trigger: null, started: Date.now(), ended: null,
  outcome: null, level: "info", ms: null, tokens: null, steps: null, tools: [], events: 0,
};
