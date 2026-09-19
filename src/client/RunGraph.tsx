import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunSummary } from "../server/runs";
import { COLOR, FieldList, MONO, dur } from "./ui";

/**
 * A run as a graph instead of a list.
 *
 * Every event becomes a node on the lane of the service it belongs to —
 * iMessage, the model, tools, the browser, bookings — and the spine connects
 * them in the order they happened. So a turn that texts back reads as a flat
 * line along one lane, while one that calls research and comes back with a
 * card visibly dives into the browser lane and climbs out again. That shape is
 * the point: you see which services a turn touched without reading anything.
 *
 * X is real time, not step number, with a minimum gap so bursts stay legible.
 * A 42-second research run is therefore a long edge, which is the honest
 * picture of where a turn actually spends its time.
 */

type FitMode = "follow" | "overview";

type GraphEvent = { seq: number; ts: number; level: string; event: string; fields: Record<string, unknown> };

const LANES = [
  { id: "chat", label: "IMESSAGE" },
  { id: "model", label: "MODEL" },
  { id: "tool", label: "TOOLS" },
  { id: "browser", label: "BROWSER" },
  { id: "booking", label: "BOOKING" },
] as const;
type LaneId = (typeof LANES)[number]["id"];

/** Tools that are really a hand-off to another service belong on its lane. */
const TOOL_LANE: Record<string, LaneId> = { research: "browser", book_option: "booking" };

const LANE_H = 92;
const NODE_H = 34;
const MIN_GAP = 34;
/** Below this, node labels stop being readable. */
const MIN_K = 0.72;
const MAX_K = 1.0;
/** Lane names sit in a gutter the graph scrolls underneath. */
const GUTTER = 92;
const TIME_BUDGET = 1500; // px the whole run is spread across before min-gap kicks in

type GNode = {
  seq: number;
  lane: LaneId;
  label: string;
  sub?: string;
  ts: number;
  ms?: number;
  level: string;
  event: string;
  fields: Record<string, unknown>;
  x: number;
  y: number;
  w: number;
};

/** Which lane an event sits on, and what to call it there. */
function classify(e: GraphEvent): { lane: LaneId; label: string; sub?: string } {
  const f = e.fields;
  const n = (k: string) => (typeof f[k] === "number" ? (f[k] as number) : undefined);
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);

  if (e.event === "tool" || e.event === "tool.failed" || e.event === "dev.tool") {
    const tool = s("tool") ?? "tool";
    return { lane: TOOL_LANE[tool] ?? "tool", label: tool, sub: e.event === "tool.failed" ? "failed" : undefined };
  }
  if (e.event.startsWith("research.")) {
    const stage = e.event.slice("research.".length);
    const sub =
      stage === "finished" ? `${n("candidates") ?? 0} found` :
      stage === "read" ? s("host") :
      stage === "searched" ? `${n("hits") ?? 0} hits` :
      stage === "planned" ? `${(f.queries as string[] | undefined)?.length ?? 0} queries` : undefined;
    return { lane: "browser", label: `research ${stage}`, sub };
  }
  if (e.event.startsWith("booking.")) return { lane: "booking", label: e.event.replace(".", " "), sub: s("detail") };

  switch (e.event) {
    case "message.in": return { lane: "chat", label: "inbound", sub: s("from") };
    case "message.stored": return { lane: "chat", label: "stored", sub: "not addressed" };
    case "message.out": return { lane: "chat", label: "reply sent", sub: `${n("chars") ?? 0} chars` };
    case "ticket.out": return { lane: "chat", label: "card sent" };
    case "card.update": return { lane: "chat", label: "card redrawn", sub: `v${n("version") ?? "?"}` };
    case "vote.cast": return { lane: "chat", label: "vote", sub: s("source") };
    case "rsvp": return { lane: "chat", label: "rsvp" };
    case "turn.start": return { lane: "model", label: "turn", sub: s("llm") };
    case "turn.end": return { lane: "model", label: s("outcome") ?? "turn end", sub: n("tokens") ? `${n("tokens")} tok` : undefined };
    case "turn.crashed": return { lane: "model", label: "crashed" };
    default: return { lane: e.event.startsWith("turn.") ? "model" : "chat", label: e.event.replace(/\./g, " ") };
  }
}

const nodeWidth = (label: string, sub?: string) =>
  Math.max(104, Math.min(210, Math.max(label.length, (sub?.length ?? 0) + 1) * 7 + 30));

/** Events -> positioned nodes. Time drives x; the lane drives y. */
function layout(events: GraphEvent[]) {
  const used = new Set<LaneId>();
  const raw = events.map((e) => {
    const c = classify(e);
    used.add(c.lane);
    return { e, c };
  });
  const lanes = LANES.filter((l) => used.has(l.id));
  const laneY = new Map<LaneId, number>(lanes.map((l, i) => [l.id, i * LANE_H + LANE_H / 2]));

  const t0 = events[0]?.ts ?? 0;
  const span = Math.max(1, (events.at(-1)?.ts ?? t0) - t0);

  let cursor = 0;
  const nodes: GNode[] = raw.map(({ e, c }, i) => {
    const w = nodeWidth(c.label, c.sub);
    // Proportional to real elapsed time, but never so tight that two nodes touch.
    const wanted = ((e.ts - t0) / span) * TIME_BUDGET;
    const x = i === 0 ? 0 : Math.max(wanted, cursor + MIN_GAP);
    cursor = x + w;
    const ms = typeof e.fields.ms === "number" ? (e.fields.ms as number) : undefined;
    return { seq: e.seq, lane: c.lane, label: c.label, sub: c.sub, ts: e.ts, ms, level: e.level, event: e.event, fields: e.fields, x, y: laneY.get(c.lane)!, w };
  });

  return { nodes, lanes, height: lanes.length * LANE_H, width: cursor + 40 };
}

export function RunGraph({ run, events }: { run: RunSummary; events: GraphEvent[] }) {
  const { nodes, lanes, height, width } = useMemo(() => layout(events), [events]);
  const [picked, setPicked] = useState<number | null>(null);
  const [view, setView] = useState({ x: GUTTER + 14, y: 34, k: 1 });
  const [fitMode, setFitMode] = useState<FitMode>("follow");
  const wrap = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const running = run.ended === null;

  /**
   * Two framings, because they answer different questions.
   *
   * "follow" sizes to the lanes, not the run's length: nodes stay readable and
   * the camera tracks the newest one, which is what you want while a turn is
   * happening. A long run simply runs off to the left, the way it should.
   *
   * "overview" zooms out far enough to hold the whole run at once — the shape
   * of which services it touched, at the cost of being able to read the labels.
   */
  const fit = useCallback(
    (m: FitMode) => {
      const el = wrap.current;
      if (!el || !width || !height) return;
      const availW = el.clientWidth - GUTTER - 60;
      const availH = el.clientHeight - 80;

      if (m === "overview") {
        const k = Math.max(0.22, Math.min(MAX_K, availW / width, availH / height));
        setView({ k, x: GUTTER + 14, y: Math.max(30, (el.clientHeight - height * k) / 2) });
        return;
      }
      const k = Math.max(MIN_K, Math.min(MAX_K, availH / height));
      // Anchor left while it fits; once it does not, pin the newest node near
      // the right edge so the live end of the run is always the thing on screen.
      const last = nodes.at(-1);
      const overflow = width * k > availW;
      const x = overflow && last ? el.clientWidth - 90 - (last.x + last.w) * k : GUTTER + 14;
      setView({ k, x, y: Math.max(30, (el.clientHeight - height * k) / 2) });
    },
    [width, height, nodes],
  );

  // A new run resets the camera; panning by hand takes it back off autopilot.
  useEffect(() => {
    moved.current = false;
    setPicked(null);
    setFitMode("follow");
  }, [run.runId]);

  // Refit as the run grows, so a live turn stays framed while nodes appear.
  useEffect(() => {
    if (!moved.current) fit(fitMode);
  }, [fit, fitMode, nodes.length, run.runId]);

  useEffect(() => {
    const onResize = () => !moved.current && fit(fitMode);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fit, fitMode]);

  const toggleFit = useCallback(() => {
    moved.current = false;
    setFitMode((m) => {
      const next = m === "follow" ? "overview" : "follow";
      fit(next);
      return next;
    });
  }, [fit]);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    moved.current = true;
    const rect = wrap.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((v) => {
      const k = Math.min(2.2, Math.max(0.3, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      // Keep the point under the cursor fixed while the scale changes.
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  }, []);

  const pickedNode = picked === null ? null : nodes.find((n) => n.seq === picked);

  return (
    <div style={{ position: "relative", height: "100%", overflow: "hidden", background: COLOR.bg }}>
      <style>{CSS}</style>

      <div
        ref={wrap}
        onWheel={onWheel}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
          (e.target as Element).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          moved.current = true;
          setView((v) => ({ ...v, x: drag.current!.vx + (e.clientX - drag.current!.x), y: drag.current!.vy + (e.clientY - drag.current!.y) }));
        }}
        onPointerUp={() => (drag.current = null)}
        style={{ position: "absolute", inset: 0, cursor: drag.current ? "grabbing" : "grab", touchAction: "none" }}
      >
        <svg width="100%" height="100%" style={{ display: "block" }}>
          <defs>
            <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill={COLOR.line} />
            </pattern>
            <linearGradient id="fade" x1="0" x2="1">
              <stop offset="0" stopColor={COLOR.bg} stopOpacity="1" />
              <stop offset="1" stopColor={COLOR.bg} stopOpacity="0" />
            </linearGradient>
            <filter id="glow" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur stdDeviation="5" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <rect width="100%" height="100%" fill="url(#dots)" opacity={0.5} />

          <g
            style={{
              transform: `translate(${view.x}px,${view.y}px) scale(${view.k})`,
              transition: drag.current ? "none" : "transform .32s cubic-bezier(.3,.8,.3,1)",
            }}
          >
            {/* Lane rails, so an empty stretch still reads as "that service was idle". */}
            {lanes.map((l, i) => (
              <line key={l.id} x1={-40} x2={width} y1={i * LANE_H + LANE_H / 2} y2={i * LANE_H + LANE_H / 2} stroke={COLOR.line} strokeWidth={1} />
            ))}
            {nodes.slice(1).map((n, i) => (
              <Edge key={n.seq} from={nodes[i]} to={n} />
            ))}
            {nodes.map((n, i) => (
              <Node key={n.seq} node={n} t0={nodes[0]?.ts ?? 0} picked={n.seq === picked} live={running && i === nodes.length - 1} onPick={() => setPicked((p) => (p === n.seq ? null : n.seq))} />
            ))}
          </g>

          {/* A gutter the graph scrolls underneath, so a node panned off the
              left fades out instead of colliding with the lane names. */}
          <rect x={0} y={0} width={GUTTER} height="100%" fill={COLOR.bg} />
          <rect x={GUTTER} y={0} width={46} height="100%" fill="url(#fade)" />
          <line x1={GUTTER} x2={GUTTER} y1={0} y2="100%" stroke={COLOR.line} />
          {lanes.map((l, i) => (
            <text key={l.id} x={14} y={view.y + (i * LANE_H + LANE_H / 2) * view.k + 3} fill={COLOR.dimmer} fontSize={9} fontFamily={MONO} letterSpacing={1.4}>
              {l.label}
            </text>
          ))}
        </svg>
      </div>

      <Legend run={run} nodes={nodes.length} fitMode={fitMode} onToggleFit={toggleFit} />
      {pickedNode && <Inspector node={pickedNode} t0={nodes[0]?.ts ?? 0} onClose={() => setPicked(null)} />}
      {!events.length && (
        <p style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: COLOR.dim, fontSize: 13 }}>
          {running ? "waiting for the first step…" : "no events recorded for this run"}
        </p>
      )}
    </div>
  );
}

/** Horizontal cubic between two nodes; flat within a lane, a dive across lanes. */
function Edge({ from, to }: { from: GNode; to: GNode }) {
  const x1 = from.x + from.w;
  const x2 = to.x;
  const bend = Math.max(22, (x2 - x1) * 0.5);
  const d = `M ${x1} ${from.y} C ${x1 + bend} ${from.y}, ${x2 - bend} ${to.y}, ${x2} ${to.y}`;
  const crossing = from.lane !== to.lane;
  return (
    <path
      className="edge"
      d={d}
      fill="none"
      stroke={crossing ? COLOR.accentDim : COLOR.lineHi}
      strokeWidth={crossing ? 1.5 : 1}
      strokeDasharray={crossing ? "3 4" : undefined}
    />
  );
}

function Node({ node, t0, picked, live, onPick }: { node: GNode; t0: number; picked: boolean; live: boolean; onPick: () => void }) {
  const tone = node.level === "error" ? COLOR.error : node.level === "warn" ? COLOR.warn : live ? COLOR.accent : COLOR.text;
  const edge = node.level === "error" ? COLOR.error : node.level === "warn" ? COLOR.warn : picked || live ? COLOR.accent : COLOR.lineHi;
  return (
    <g className="node" transform={`translate(${node.x},${node.y - NODE_H / 2})`} onClick={onPick} style={{ cursor: "pointer" }}>
      {live && <rect width={node.w} height={NODE_H} rx={7} fill="none" stroke={COLOR.accent} strokeWidth={1.5} filter="url(#glow)" className="pulse" />}
      <rect width={node.w} height={NODE_H} rx={7} fill={picked ? COLOR.panelHi : COLOR.panel} stroke={edge} strokeWidth={picked || live ? 1.5 : 1} />
      <text x={11} y={14} fill={tone} fontSize={11} fontFamily={MONO}>
        {node.label}
      </text>
      <text x={11} y={26} fill={COLOR.dimmer} fontSize={9} fontFamily={MONO}>
        {[node.sub, node.ms !== undefined ? dur(node.ms) : null].filter(Boolean).join(" · ").slice(0, 28)}
      </text>
      <text x={node.w} y={-6} fill={COLOR.dimmer} fontSize={8.5} fontFamily={MONO} textAnchor="end">
        +{dur(node.ts - t0)}
      </text>
    </g>
  );
}

function Legend({ run, nodes, fitMode, onToggleFit }: { run: RunSummary; nodes: number; fitMode: FitMode; onToggleFit: () => void }) {
  const running = run.ended === null;
  return (
    <div style={{ position: "absolute", top: 14, right: 16, textAlign: "right", fontFamily: MONO, fontSize: 10, color: COLOR.dimmer, lineHeight: 1.7, background: `${COLOR.bg}D0`, borderRadius: 8, padding: "6px 10px" }}>
      <div style={{ color: running ? COLOR.accent : COLOR.dim, fontSize: 11 }}>
        {running ? "● LIVE" : (run.outcome ?? "—").toUpperCase()}
      </div>
      <div>{nodes} steps</div>
      {run.ms !== null && <div>{dur(run.ms)} in turn</div>}
      {!!run.tokens && <div>{run.tokens.toLocaleString()} tokens</div>}
      <button onClick={onToggleFit} style={{ marginTop: 8, background: "none", border: `1px solid ${COLOR.line}`, borderRadius: 5, color: COLOR.dim, fontFamily: MONO, fontSize: 9, padding: "3px 7px", cursor: "pointer" }}>
        {fitMode === "follow" ? "overview" : "follow"}
      </button>
    </div>
  );
}

/** Clicking a node opens the raw event behind it — the old timeline row. */
function Inspector({ node, t0, onClose }: { node: GNode; t0: number; onClose: () => void }) {
  return (
    <div style={{ position: "absolute", left: 16, right: 16, bottom: 16, background: COLOR.panel, border: `1px solid ${COLOR.lineHi}`, borderRadius: 10, padding: "12px 14px", maxHeight: "38%", overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 12, color: COLOR.text }}>{node.event}</span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: COLOR.dimmer, flex: 1 }}>
          +{dur(node.ts - t0)}
          {node.ms !== undefined && ` · took ${dur(node.ms)}`}
        </span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: COLOR.dim, cursor: "pointer", fontSize: 14, lineHeight: 1 }}>
          ×
        </button>
      </div>
      {Object.keys(node.fields).length ? <FieldList fields={node.fields} lines={6} /> : <p style={{ color: COLOR.dimmer, fontSize: 11, margin: "6px 0 0" }}>no fields</p>}
    </div>
  );
}

const CSS = `
.node { animation: nodeIn .34s cubic-bezier(.2,.9,.3,1) both; transform-box: fill-box; }
.node rect { transition: stroke .2s, fill .2s; }
.edge { animation: edgeIn .5s ease-out both; }
.pulse { animation: pulse 1.8s ease-in-out infinite; }
@keyframes nodeIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes edgeIn { from { opacity: 0 } to { opacity: 1 } }
@keyframes pulse { 0%,100% { opacity: .25 } 50% { opacity: .75 } }
@media (prefers-reduced-motion: reduce) {
  .node, .edge, .pulse { animation: none }
}
`;
