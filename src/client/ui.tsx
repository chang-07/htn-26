import { useState } from "react";

/**
 * Shared look for the run viewer: one palette, one type scale, and the two
 * bits of rendering both the list and the graph need.
 *
 * The palette is near-black with a single cool accent. Level colours are the
 * only saturated things on screen, so a warn or an error is visible at a
 * glance in a wall of nodes.
 */
export const COLOR = {
  bg: "#07080A",
  panel: "#0E1013",
  panelHi: "#14171C",
  line: "#1C2026",
  lineHi: "#2A2F37",
  text: "#E8EAED",
  dim: "#7C838E",
  dimmer: "#4A505A",
  accent: "#7DD3FC",
  accentDim: "#2C5A70",
  good: "#34D399",
  warn: "#FBBF24",
  error: "#F87171",
};

export const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif";
export const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace";

export const levelColor = (l: string) => (l === "error" ? COLOR.error : l === "warn" ? COLOR.warn : COLOR.dim);

export const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** 1234 -> "1.2s". Durations span microseconds to minutes, so pick a unit. */
export const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

/**
 * One `k=v  k=v` line per event. Tool arguments and research reports run long,
 * so it clamps until clicked, and any URL in there — a Browserbase session
 * replay, a checkout link — stays clickable.
 */
export function FieldList({ fields, lines = 2 }: { fields: Record<string, unknown>; lines?: number }) {
  const [open, setOpen] = useState(false);
  const text = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
  return (
    <pre
      onClick={() => setOpen((o) => !o)}
      style={{
        margin: "4px 0 0", color: COLOR.dim, fontSize: 11, lineHeight: 1.5, fontFamily: MONO,
        whiteSpace: "pre-wrap", wordBreak: "break-word", cursor: "pointer",
        ...(open ? {} : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" }),
      }}
    >
      {linkify(text)}
    </pre>
  );
}

/** Splits on URLs so they render as anchors; everything else stays plain text. */
export function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s"',\]}]+)/g).map((part, i) =>
    part.startsWith("http") ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: COLOR.accent }}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}
