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
  // A run linked to directly is often older than the page the list holds. It is
  // kept apart because both the list fetch and the socket's hello replace `runs`
  // wholesale, which would drop it again.
  const [linked, setLinked] = useState<RunSummary | null>(null);
  // /runs?token=… — the API and the live socket both need it when RUNS_TOKEN is set.
  const token = useMemo(() => new URLSearchParams(window.location.search).get("token") ?? "", []);
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
        if (r.status === 401) throw new Error("locked");
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
                {problem === "locked" ? "Locked — open /runs?token=<RUNS_TOKEN>" : `Couldn't load: ${problem}`}
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
        {shown.map((r) => (
          <RunRow key={r.runId} run={r} selected={r.runId === selected} onClick={() => select(r.runId)} />
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
        <span style={{ width: 6, height: 6, borderRadius: 6, background: running ? "var(--accent)" : levelColor(run.level), flexShrink: 0 }} />
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
