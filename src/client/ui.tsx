import { useState } from "react";
import { PALETTE, TICKET_FONTS } from "../theme";

/**
 * Shared look for the run viewer: the ticket (src/theme.ts) turned into an
 * instrument. Same paper, same ink, same two faces. Night mode is the ticket
 * turned over — ink for the ground, paper for the type — rather than a grey
 * dark theme, so the projector shows the same object the phones do.
 *
 * Colours are CSS custom properties rather than a JS object, because the page
 * has two themes and inline styles cannot answer a media query. Components read
 * them as `var(--ink)`; THEME_CSS is mounted once by <Runs>.
 *
 * Each service gets one ink — stamp colours that sit on cream and on ink — and
 * that is the only colour on the page. State is carried by type and position.
 */
export const THEME_CSS = `
:root {
  --sans:'Archivo', system-ui, -apple-system, sans-serif;
  --mono:'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --ground:${PALETTE.paper}; --ink:${PALETTE.ink};
  --soft:rgba(36,31,23,.64); --faint:rgba(36,31,23,.44); --rule:rgba(36,31,23,.34); --hair:rgba(36,31,23,.16);
  --paper2:rgba(36,31,23,.05); --paper3:rgba(36,31,23,.1);
  --s-chat:#2653a8; --s-model:#6a3ea1; --s-tool:#8f4d0e; --s-browser:${PALETTE.green}; --s-booking:#a8322f; --s-shop:#9a2d6c;
  --good:${PALETTE.green}; --warn:#8f4d0e; --error:#a8322f;
  --scrim:rgba(36,31,23,.55);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground:${PALETTE.ink}; --ink:${PALETTE.paper};
    --soft:rgba(239,231,214,.66); --faint:rgba(239,231,214,.46); --rule:rgba(239,231,214,.34); --hair:rgba(239,231,214,.16);
    --paper2:rgba(239,231,214,.06); --paper3:rgba(239,231,214,.11);
    --s-chat:#9db8ff; --s-model:#c9adf7; --s-tool:#f0b26a; --s-browser:#6fc9ad; --s-booking:#f28b86; --s-shop:#f09ad0;
    --good:#6fc9ad; --warn:#f0b26a; --error:#f28b86;
    --scrim:rgba(0,0,0,.6);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --ground:${PALETTE.ink}; --ink:${PALETTE.paper};
  --soft:rgba(239,231,214,.66); --faint:rgba(239,231,214,.46); --rule:rgba(239,231,214,.34); --hair:rgba(239,231,214,.16);
  --paper2:rgba(239,231,214,.06); --paper3:rgba(239,231,214,.11);
  --s-chat:#9db8ff; --s-model:#c9adf7; --s-tool:#f0b26a; --s-browser:#6fc9ad; --s-booking:#f28b86; --s-shop:#f09ad0;
  --good:#6fc9ad; --warn:#f0b26a; --error:#f28b86;
  --scrim:rgba(0,0,0,.6);
  color-scheme: dark;
}
html, body { margin:0; background:var(--ground); }
.rv { min-height:100vh; min-height:100dvh; background:var(--ground); color:var(--ink); -webkit-text-size-adjust:100%; }
.rv * { box-sizing:border-box; }
.rv a { color:inherit; text-decoration:underline; text-underline-offset:3px; text-decoration-thickness:1.5px; }
.rv :focus-visible { outline:2px solid var(--ink); outline-offset:2px; }

/* The ticket's own devices, reused: meta row, perforation, stub. */
.rv-meta { font-family:var(--mono); font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--soft); }
.rv-perf { border:0; border-top:2px dotted var(--rule); margin:0; }
.rv-stub { display:flex; flex-direction:column; align-items:center; justify-content:center; min-width:96px; padding-left:18px; border-left:2px dotted var(--rule); text-align:center; }
.rv-stub b { font-family:var(--sans); font-weight:800; font-size:30px; line-height:1; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
.rv-stub span { margin-top:6px; }

/* Controls: flat, square, ruled in ink. On = filled. */
.rv-btn { display:inline-flex; align-items:center; gap:6px; margin:0; padding:6px 10px; background:transparent; color:var(--ink); border:0; border-radius:0; box-shadow:inset 0 0 0 1.5px var(--ink); font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; line-height:1.2; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.rv-btn.is-on, .rv-btn.is-go { background:var(--ink); color:var(--ground); }
.rv-btn.is-quiet { box-shadow:inset 0 0 0 1.5px var(--rule); color:var(--soft); }
.rv-btn:disabled { opacity:.45; cursor:default; }
.rv-btn:active:not(:disabled) { opacity:.7; }
.rv-select { position:relative; display:inline-flex; }
.rv-select select { appearance:none; -webkit-appearance:none; margin:0; padding:6px 26px 6px 10px; background:transparent; color:var(--ink); border:0; border-radius:0; box-shadow:inset 0 0 0 1.5px var(--ink); font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; line-height:1.2; cursor:pointer; max-width:150px; text-overflow:ellipsis; }
.rv-select::after { content:""; position:absolute; right:10px; top:50%; width:6px; height:6px; border-right:1.5px solid var(--ink); border-bottom:1.5px solid var(--ink); transform:translateY(-70%) rotate(45deg); pointer-events:none; }
.rv-input { margin:0; padding:6px 0 7px; background:transparent; color:var(--ink); border:0; border-bottom:1.5px solid var(--ink); border-radius:0; font-family:var(--mono); font-size:13px; -webkit-appearance:none; appearance:none; min-width:0; }
.rv-input:focus { outline:none; border-bottom-width:3px; padding-bottom:5.5px; }
.rv-input::placeholder { color:var(--soft); }

/* The rail: sessions torn apart by perforations, runs as rows beneath. */
.rv-session { display:flex; align-items:center; gap:10px; width:100%; margin:0; padding:12px 18px 10px; background:none; border:0; border-radius:0; color:inherit; font:inherit; text-align:left; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.rv-session:hover { background:var(--paper2); }
.rv-run { display:block; width:100%; margin:0; padding:9px 18px 10px 34px; background:none; border:0; border-radius:0; border-left:3px solid transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.rv-run:hover { background:var(--paper2); }
.rv-run.is-selected { border-left-color:var(--ink); background:var(--paper2); }

/* The tape: one row per step. The service mark is the margin. */
.rv-row { display:grid; grid-template-columns:58px 14px minmax(0,1fr); column-gap:12px; align-items:baseline; width:100%; margin:0; padding:9px 0 9px 4px; background:none; border:0; border-radius:0; border-left:3px solid transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.rv-row:hover { background:var(--paper2); }
.rv-row.is-selected { border-left-color:var(--ink); background:var(--paper2); }
.rv-row.is-static, .rv-row.is-static:hover { cursor:default; background:none; }
.rv-row .rv-mark { display:block; width:11px; height:11px; align-self:center; justify-self:center; background:currentColor; }
.rv-row.is-error .rv-title { color:var(--error); }
/* A step that has just printed: one short reveal, nothing slides. */
.rv-row.is-new { animation:rvPrint .26s ease-out both; }
@keyframes rvPrint { from { opacity:0 } to { opacity:1 } }
.rv-live { animation:rvPulse 1.4s ease-in-out infinite; }
@keyframes rvPulse { 0%,100% { opacity:1 } 50% { opacity:.3 } }

/* What a step produced, printed under its row at a reading width. */
.rv-media { grid-column:3; margin:6px 0 4px; max-width:560px; }
.rv-quote { margin:0; padding:10px 14px; max-width:64ch; border-left:2px solid var(--rule); font-family:var(--sans); font-size:14px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.rv-quote.is-thinking { color:var(--soft); font-style:italic; border-left-style:dotted; }
.rv-frame { display:block; width:100%; border:1.5px solid var(--rule); background:var(--paper2); }
.rv-frame img, .rv-frame iframe { display:block; width:100%; border:0; }
.rv-code { margin:0; padding:10px 12px; background:var(--paper2); font-family:var(--mono); font-size:11.5px; line-height:1.55; color:var(--soft); white-space:pre-wrap; overflow-wrap:anywhere; }
.rv-code.is-clamped { display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; cursor:pointer; }

/* Cart quantities are editable in place: a stepper drawn as a ruled cell. */
.rv-step { width:22px; height:22px; margin:0; padding:0; background:transparent; color:var(--ink); border:0; box-shadow:inset 0 0 0 1.5px var(--rule); font-family:var(--mono); font-size:14px; line-height:1; cursor:pointer; }
.rv-step:hover { box-shadow:inset 0 0 0 1.5px var(--ink); }

/* The stage on narrow screens: a sheet over the tape. */
.rv-scrim { position:fixed; inset:0; z-index:30; display:grid; align-items:end; background:var(--scrim); animation:rvFade .16s ease-out both; }
.rv-sheet { max-height:88vh; max-height:88dvh; background:var(--ground); color:var(--ink); border-top:2px dotted var(--rule); display:flex; flex-direction:column; overflow:hidden; animation:rvRise .2s ease-out both; }
@keyframes rvFade { from { opacity:0 } to { opacity:1 } }
@keyframes rvRise { from { transform:translateY(12px) } to { transform:none } }

@media (max-width: 759px) {
  .rv-row { grid-template-columns:44px 11px minmax(0,1fr); column-gap:8px; }
  .rv-stub { min-width:80px; padding-left:12px; }
  .rv-stub b { font-size:26px; }
}
@media (prefers-reduced-motion: reduce) {
  .rv-row.is-new, .rv-live, .rv-scrim, .rv-sheet { animation:none; }
}
`;

export const FONT_LINK = TICKET_FONTS;

/** One hue per service. The key is the lane an event was classified into. */
export const SERVICES = {
  chat: { label: "iMessage", v: "--s-chat" },
  model: { label: "Model", v: "--s-model" },
  tool: { label: "Tools", v: "--s-tool" },
  browser: { label: "Browser", v: "--s-browser" },
  booking: { label: "Booking", v: "--s-booking" },
  shop: { label: "Shop", v: "--s-shop" },
} as const;
export type ServiceId = keyof typeof SERVICES;

/** Which services a run touched, from its tool list. Every run has both of these. */
export function servicesForTools(tools: string[]): ServiceId[] {
  const map: Record<string, ServiceId> = {
    research: "browser", book_option: "booking", check_availability: "booking",
    shop_search: "shop", shop_build_cart: "shop", shop_drop_cart: "shop",
  };
  const out = new Set<ServiceId>(["chat", "model"]);
  for (const t of tools) out.add(map[t] ?? "tool");
  return [...out];
}

export const levelColor = (l: string) =>
  l === "error" ? "var(--error)" : l === "warn" ? "var(--warn)" : "var(--good)";

export const clock = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** 1234 -> "1.2s". Durations span microseconds to minutes, so pick a unit. */
export const dur = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;

/**
 * One `k=v` line per field. Tool arguments and research reports run long, so it
 * clamps until clicked, and any URL — a Browserbase replay, a checkout link —
 * stays clickable.
 */
export function FieldList({ fields, lines = 3 }: { fields: Record<string, unknown>; lines?: number }) {
  const [open, setOpen] = useState(false);
  const text = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
  return (
    <pre
      className={`rv-code${open ? "" : " is-clamped"}`}
      onClick={() => setOpen((o) => !o)}
      style={open ? undefined : { WebkitLineClamp: lines }}
      title={open ? undefined : "Show all"}
    >
      {linkify(text)}
    </pre>
  );
}

/** Splits on URLs so they render as anchors; everything else stays plain text. */
export function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s"',\]}]+)/g).map((part, i) =>
    part.startsWith("http") ? (
      <a key={i} href={part} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}
