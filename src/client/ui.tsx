import { useState } from "react";
import { TICKET_FONTS } from "../theme";

/**
 * Shared look for the run viewer: the ticket's two faces and its flat, square,
 * ruled devices, on a plain white ground. The tickets and the pages behind them
 * stay cream (src/theme.ts); this page is an instrument and gets read for hours,
 * so it is white with near-black type, and night is the same thing inverted.
 *
 * Colours are CSS custom properties rather than a JS object, because the page
 * has two themes. White is the default whatever the OS says; night is a choice.
 * Components read them as `var(--ink)`; THEME_CSS is mounted once by <Runs>.
 *
 * Each service gets one hue, and that is the only colour on the page.
 */
export const THEME_CSS = `
:root {
  --sans:'Archivo', system-ui, -apple-system, sans-serif;
  --mono:'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --ground:#ffffff; --ink:#0c1418;
  --soft:rgba(12,20,24,.64); --faint:rgba(12,20,24,.44); --rule:rgba(12,20,24,.26); --hair:rgba(12,20,24,.12);
  --paper2:rgba(12,20,24,.04); --paper3:rgba(12,20,24,.085);
  --s-chat:#0e7490; --s-model:#6d28d9; --s-tool:#b45309; --s-browser:#047857; --s-booking:#be123c; --s-shop:#3730a3;
  --good:#047857; --warn:#b45309; --error:#be123c;
  --scrim:rgba(12,20,24,.4);
  color-scheme: light;
}
:root[data-theme="dark"] {
  --ground:#0b1013; --ink:#e9eef1;
  --soft:rgba(233,238,241,.66); --faint:rgba(233,238,241,.44); --rule:rgba(233,238,241,.26); --hair:rgba(233,238,241,.13);
  --paper2:rgba(233,238,241,.055); --paper3:rgba(233,238,241,.11);
  --s-chat:#4fc3de; --s-model:#a78bfa; --s-tool:#fbbf24; --s-browser:#34d399; --s-booking:#fb7185; --s-shop:#818cf8;
  --good:#34d399; --warn:#fbbf24; --error:#fb7185;
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
.rv-row .rv-mark { display:block; width:11px; height:11px; border-radius:50%; align-self:center; justify-self:center; background:currentColor; }
.rv-row.is-error .rv-title { color:var(--error); }
/* A step that has just printed: one short reveal, nothing slides. */
.rv-row.is-new { animation:rvPrint .26s ease-out both; }
@keyframes rvPrint { from { opacity:0 } to { opacity:1 } }
.rv-live { animation:rvPulse 1.4s ease-in-out infinite; }
.rv-typing { display:inline-flex; align-items:center; gap:4px; padding:7px 10px; background:var(--paper3); border-radius:12px; }
.rv-typing i { display:block; width:6px; height:6px; border-radius:50%; background:currentColor; animation:rvType 1.2s ease-in-out infinite; }
.rv-typing i:nth-child(2) { animation-delay:.16s; }
.rv-typing i:nth-child(3) { animation-delay:.32s; }
@keyframes rvType { 0%,60%,100% { transform:none; opacity:.35 } 30% { transform:translateY(-3px); opacity:1 } }
@keyframes rvPulse { 0%,100% { opacity:1 } 50% { opacity:.3 } }

/* What a step produced, printed under its row at a reading width. */
.rv-media { grid-column:3; margin:6px 0 4px; max-width:560px; }
.rv-quote { margin:0; padding:10px 14px; max-width:64ch; border-left:2px solid var(--rule); font-family:var(--sans); font-size:14px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.rv-quote.is-thinking { color:var(--soft); font-style:italic; border-left-style:dotted; }
.rv-frame { display:block; width:100%; border:1.5px solid var(--rule); background:var(--paper2); }
.rv-frame img, .rv-frame iframe { display:block; width:100%; border:0; }
.rv-code { margin:0; padding:10px 12px; background:var(--paper2); font-family:var(--mono); font-size:11.5px; line-height:1.55; color:var(--soft); white-space:pre-wrap; overflow-wrap:anywhere; }
.rv-code.is-clamped { display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; cursor:pointer; }

/* A run is several acts — a turn, the research it asked for, the turn that used it. Each gets a head. */
.rv-phase { display:flex; align-items:baseline; gap:12px; width:100%; margin:14px 0 2px; padding:10px 8px 6px 7px; background:none; border:0; border-top:2px dotted var(--rule); border-radius:0; color:inherit; font:inherit; text-align:left; cursor:pointer; -webkit-tap-highlight-color:transparent; }
.rv-phase:first-child { margin-top:0; border-top:0; }
.rv-phase:hover { background:var(--paper2); }
.rv-phase.is-selected { background:var(--paper2); box-shadow:inset 3px 0 0 var(--ink); }
.rv-phase b { font-family:var(--mono); font-size:11px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; white-space:nowrap; }
.rv-phase span { font-family:var(--mono); font-size:11.5px; color:var(--soft); font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }

/* Pages the browser read, as a contact sheet rather than a column of full-width captures. */
.rv-pages { display:grid; grid-template-columns:repeat(auto-fill, minmax(148px, 1fr)); gap:10px; max-width:none; }
.rv-page { display:block; min-width:0; margin:0; padding:0; background:none; border:0; border-radius:0; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.rv-page .rv-thumb { display:block; aspect-ratio:16/10; overflow:hidden; background:var(--paper2); box-shadow:inset 0 0 0 1.5px var(--rule); }
.rv-page .rv-thumb img { display:block; width:100%; height:100%; object-fit:cover; object-position:top; }
.rv-page:hover .rv-thumb { box-shadow:inset 0 0 0 1.5px var(--ink); }
.rv-page.is-selected .rv-thumb { outline:2px solid var(--ink); outline-offset:1px; }
.rv-page .rv-cap { display:flex; gap:8px; margin-top:5px; font-family:var(--mono); font-size:11px; color:var(--soft); white-space:nowrap; }
.rv-page .rv-cap span:first-child { overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1; color:var(--ink); }
.rv-page.is-empty { opacity:.55; }

/* Diagnostics: one line until opened. */
.rv-diag { display:flex; align-items:baseline; gap:14px; width:100%; margin:0; padding:9px 14px; background:none; border:0; border-radius:0; color:inherit; font-family:var(--mono); font-size:12px; text-align:left; cursor:pointer; font-variant-numeric:tabular-nums; }
.rv-bar { display:flex; gap:12px; width:100%; margin:2px 0 0; padding:5px 8px; border:0; border-radius:0; background:none; color:inherit; font-family:var(--mono); font-size:12px; text-align:left; cursor:pointer; font-variant-numeric:tabular-nums; }
.rv-bar:hover { box-shadow:inset 0 0 0 1.5px var(--rule); }

/* What was said, either way, on the overview. */
.rv-say { display:block; width:100%; margin:0 0 6px; padding:9px 12px; background:var(--paper2); border:0; border-left:2px solid var(--s-chat); border-radius:0; color:inherit; font-family:var(--sans); font-size:13.5px; line-height:1.5; text-align:left; white-space:pre-wrap; overflow-wrap:anywhere; cursor:pointer; }
.rv-say.is-out { border-left-color:var(--ink); }
.rv-say:hover { background:var(--paper3); }

.rv-clamp2 { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }

/* Cart quantities are editable in place: a stepper drawn as a ruled cell. */
.rv-step { width:22px; height:22px; margin:0; padding:0; background:transparent; color:var(--ink); border:0; box-shadow:inset 0 0 0 1.5px var(--rule); font-family:var(--mono); font-size:14px; line-height:1; cursor:pointer; }
.rv-step:hover { box-shadow:inset 0 0 0 1.5px var(--ink); }

/* A picked step: a panel over the middle of the page. */
.rv-scrim { position:fixed; inset:0; z-index:30; display:grid; place-items:center; padding:24px 16px; background:var(--scrim); animation:rvFade .14s ease-out both; }
.rv-sheet { width:min(720px, 100%); max-height:min(86vh, 900px); max-height:min(86dvh, 900px); background:var(--ground); color:var(--ink); box-shadow:0 0 0 1.5px var(--ink), 0 24px 60px -20px rgba(0,0,0,.45); display:flex; flex-direction:column; overflow:hidden; animation:rvRise .16s ease-out both; }
@keyframes rvFade { from { opacity:0 } to { opacity:1 } }
@keyframes rvRise { from { transform:translateY(12px) } to { transform:none } }

@media (max-width: 759px) {
  .rv-scrim { place-items:end stretch; padding:0; }
  .rv-sheet { max-height:88dvh; }
  .rv-row { grid-template-columns:44px 11px minmax(0,1fr); column-gap:8px; }
  .rv-stub { min-width:80px; padding-left:12px; }
  .rv-stub b { font-size:26px; }
}
@media (prefers-reduced-motion: reduce) {
  .rv-row.is-new, .rv-live, .rv-scrim, .rv-sheet, .rv-typing i { animation:none; }
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
