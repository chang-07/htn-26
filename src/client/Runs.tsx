import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import type { RunEventRow, RunSummary } from "../server/runs";

/**
 * Live view of what the agent is doing, across every chat.
 *
 * Past runs come from /api/runs (D1). Runs happening right now arrive over the
 * RunHub WebSocket and are merged into the same list, so a turn triggered by a
 * text lands here a few hundred ms later and fills in step by step.
 */

type TimelineEvent = { seq: number; ts: number; level: string; event: string; fields: Record<string, unknown> };

const COLOR = {
  bg: "#0B0B0F",
  panel: "#141419",
  line: "#25252E",
  text: "#FAFAFA",
  dim: "#9C9CAC",
  info: "#5B8CFF",
  warn: "#E0A33E",
  error: "#E5484D",
  good: "#3DD68C",
};

const levelColor = (l: string) => (l === "error" ? COLOR.error : l === "warn" ? COLOR.warn : COLOR.dim);

const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";

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
      .then((r) => (r.ok ? (r.json() as Promise<{ events: TimelineEvent[] }>) : null))
      .then((d) => d && setEvents((prev) => ({ ...prev, [selected]: d.events })))
      .catch(() => {});
  }, [selected, events]);

  const chats = useMemo(() => [...new Set(runs.map((r) => r.chat))], [runs]);
  const shown = chat ? runs.filter((r) => r.chat === chat) : runs;
  const detail = selected ? runs.find((r) => r.runId === selected) : undefined;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 380px) 1fr", height: "100vh", background: COLOR.bg, color: COLOR.text, fontFamily: FONT }}>
      <aside style={{ borderRight: `1px solid ${COLOR.line}`, overflowY: "auto" }}>
        <header style={{ padding: "16px 16px 12px", position: "sticky", top: 0, background: COLOR.bg, borderBottom: `1px solid ${COLOR.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ fontSize: 16, margin: 0, flex: 1 }}>Agent runs</h1>
            {problem ? (
              <span style={{ fontSize: 12, color: COLOR.error }}>
                {problem === "locked" ? "Locked — open /runs?token=<RUNS_TOKEN>" : `Couldn't load: ${problem}`}
              </span>
            ) : null}
            <span title={live ? "connected" : "disconnected"} style={{ width: 8, height: 8, borderRadius: 8, background: live ? COLOR.good : COLOR.dim }} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
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
          </div>
        </header>
        {shown.map((r) => (
          <RunRow key={r.runId} run={r} selected={r.runId === selected} onClick={() => select(r.runId)} />
        ))}
        {!shown.length && <p style={{ color: COLOR.dim, padding: 16, fontSize: 13 }}>No runs yet. Text the agent, or POST /api/dev/message.</p>}
      </aside>

      <section style={{ overflowY: "auto", padding: 24 }}>
        {detail ? <Timeline run={detail} events={events[detail.runId] ?? []} /> : <p style={{ color: COLOR.dim }}>Pick a run.</p>}
      </section>
    </div>
  );
}

function RunRow({ run, selected, onClick }: { run: RunSummary; selected: boolean; onClick: () => void }) {
  const running = run.ended === null;
  return (
    <button
      onClick={onClick}
      style={{
        display: "block", width: "100%", textAlign: "left", background: selected ? COLOR.panel : "transparent",
        border: "none", borderBottom: `1px solid ${COLOR.line}`, borderLeft: `2px solid ${selected ? COLOR.info : "transparent"}`,
        color: COLOR.text, padding: "10px 16px", cursor: "pointer", font: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <span style={{ width: 6, height: 6, borderRadius: 6, background: running ? COLOR.info : levelColor(run.level), flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {running ? <em style={{ color: COLOR.info }}>running…</em> : (run.outcome ?? "—")}
        </span>
        <span style={{ color: COLOR.dim, fontSize: 11 }}>{clock(run.started)}</span>
      </div>
      <div style={{ color: COLOR.dim, fontSize: 11, marginTop: 4, display: "flex", gap: 10 }}>
        <span>{run.chat.slice(0, 8)}</span>
        {run.ms !== null && <span>{run.ms}ms</span>}
        {!!run.tokens && <span>{run.tokens} tok</span>}
        {!!run.tools.length && <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{run.tools.join(" → ")}</span>}
      </div>
    </button>
  );
}

function Timeline({ run, events }: { run: RunSummary; events: TimelineEvent[] }) {
  const t0 = events[0]?.ts ?? run.started;
  return (
    <>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>
        {run.trigger ?? "run"} · <span style={{ color: run.level === "error" ? COLOR.error : COLOR.dim }}>{run.ended === null ? "running" : (run.outcome ?? "—")}</span>
      </h2>
      <p style={{ color: COLOR.dim, fontSize: 12, margin: "0 0 20px" }}>
        {run.chat} · {new Date(run.started).toLocaleString()}
        {run.ms !== null && ` · ${run.ms}ms`}
        {!!run.tokens && ` · ${run.tokens} tokens`}
        {run.steps !== null && ` · ${run.steps} steps`}
      </p>
      {events.map((e) => (
        <div key={e.seq} style={{ display: "grid", gridTemplateColumns: "56px 8px 1fr", gap: 10, padding: "6px 0", borderTop: `1px solid ${COLOR.line}` }}>
          <span style={{ color: COLOR.dim, fontSize: 11, fontVariantNumeric: "tabular-nums", paddingTop: 2 }}>+{e.ts - t0}ms</span>
          <span style={{ width: 6, height: 6, borderRadius: 6, background: levelColor(e.level), marginTop: 7 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{e.event}</div>
            {!!Object.keys(e.fields).length && <FieldList fields={e.fields} />}
          </div>
        </div>
      ))}
      {!events.length && <p style={{ color: COLOR.dim, fontSize: 13 }}>No events recorded for this run.</p>}
    </>
  );
}

/**
 * One `k=v  k=v` line per event. Tool arguments and research reports run long,
 * so it clamps to two lines until clicked, and any URL in there — a Browserbase
 * session replay, a checkout link — stays clickable.
 */
function FieldList({ fields }: { fields: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const text = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
  return (
    <pre
      onClick={() => setOpen((o) => !o)}
      style={{
        margin: "4px 0 0", color: COLOR.dim, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word",
        cursor: "pointer", ...(open ? {} : { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }),
      }}
    >
      {linkify(text)}
    </pre>
  );
}

/** Splits on URLs so they render as anchors; everything else stays plain text. */
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s"',\]}]+)/g).map((part, i) =>
    part.startsWith("http") ? (
      <a
        key={i}
        href={part}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ color: COLOR.info }}
      >
        {part}
      </a>
    ) : (
      part
    ),
  );
}

const selectStyle: React.CSSProperties = {
  background: COLOR.panel, color: COLOR.text, border: `1px solid ${COLOR.line}`,
  borderRadius: 6, padding: "4px 8px", fontSize: 12,
};

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const EMPTY_RUN: RunSummary = {
  runId: "", chat: "", trigger: null, started: Date.now(), ended: null,
  outcome: null, level: "info", ms: null, tokens: null, steps: null, tools: [], events: 0,
};
