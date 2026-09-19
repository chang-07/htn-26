import { useState } from "react";

/**
 * Shared look for the run viewer.
 *
 * Colours are CSS custom properties rather than a JS object, because the page
 * has two themes and inline styles cannot answer a media query. Components read
 * them as `var(--ink)`; THEME_CSS below is mounted once by <Runs>.
 *
 * Light is the default. Neutrals carry a slight cyan bias toward the accent, so
 * nothing reads as unconsidered grey, and each service gets its own hue —
 * muted enough that a page of cards still reads as one system.
 */
export const THEME_CSS = `
:root {
  --paper:#EEF1F4; --card:#FFFFFF; --card-2:#F7F9FA;
  --rule:#DCE2E7; --rule-2:#C5CED6;
  --ink:#0C1418; --muted:#55636E; --faint:#8996A2;
  --accent:#0E7490; --accent-soft:#D6EEF5;
  --good:#047857; --warn:#B45309; --error:#BE123C; --wire:#B9C4CD;
  --s-chat:#0E7490; --s-model:#6D28D9; --s-tool:#B45309;
  --s-browser:#047857; --s-booking:#BE123C; --s-shop:#3730A3;
  --scrim:rgba(12,20,24,.34);
  --shadow:0 1px 2px rgba(12,20,24,.05), 0 6px 16px -8px rgba(12,20,24,.14);
  --shadow-lift:0 2px 4px rgba(12,20,24,.07), 0 14px 32px -12px rgba(12,20,24,.26);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper:#0B1013; --card:#141B20; --card-2:#1A2228;
    --rule:#263139; --rule-2:#35434D;
    --ink:#E9EEF1; --muted:#9AA8B4; --faint:#6B7883;
    --accent:#4FC3DE; --accent-soft:#10323D;
    --good:#34D399; --warn:#FBBF24; --error:#FB7185; --wire:#33424D;
    --s-chat:#4FC3DE; --s-model:#A78BFA; --s-tool:#FBBF24;
    --s-browser:#34D399; --s-booking:#FB7185; --s-shop:#818CF8;
    --scrim:rgba(0,0,0,.58);
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 6px 16px -8px rgba(0,0,0,.6);
    --shadow-lift:0 2px 4px rgba(0,0,0,.5), 0 14px 32px -12px rgba(0,0,0,.75);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper:#0B1013; --card:#141B20; --card-2:#1A2228;
  --rule:#263139; --rule-2:#35434D;
  --ink:#E9EEF1; --muted:#9AA8B4; --faint:#6B7883;
  --accent:#4FC3DE; --accent-soft:#10323D;
  --good:#34D399; --warn:#FBBF24; --error:#FB7185; --wire:#33424D;
  --s-chat:#4FC3DE; --s-model:#A78BFA; --s-tool:#FBBF24;
  --s-browser:#34D399; --s-booking:#FB7185; --s-shop:#818CF8;
  --scrim:rgba(0,0,0,.58);
  --shadow:0 1px 2px rgba(0,0,0,.4), 0 6px 16px -8px rgba(0,0,0,.6);
  --shadow-lift:0 2px 4px rgba(0,0,0,.5), 0 14px 32px -12px rgba(0,0,0,.75);
  color-scheme: dark;
}

.rg-card { animation: rgIn .3s cubic-bezier(.2,.9,.3,1) both; }
.rg-card:hover { box-shadow: var(--shadow-lift); transform: translateY(-1px); }
.rg-scrim { animation: rgFade .16s ease-out both; }
.rg-sheet { animation: rgPop .2s cubic-bezier(.2,.9,.3,1) both; }
.rg-run:hover { background: var(--card-2); }
.rg-btn:hover { color: var(--ink); border-color: var(--rule-2); }
.rg-step:hover { background: var(--accent-soft); color: var(--accent); }
@keyframes rgIn { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:none } }
@keyframes rgFade { from { opacity:0 } to { opacity:1 } }
@keyframes rgPop { from { opacity:0; transform:translateY(8px) scale(.985) } to { opacity:1; transform:none } }
@media (prefers-reduced-motion: reduce) {
  .rg-card, .rg-scrim, .rg-sheet { animation: none; }
  .rg-card:hover { transform: none; }
}
`;

export const UI_FONT = "'Archivo', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
export const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
export const FONT_LINK = "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap";

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

export const btn: React.CSSProperties = {
  fontFamily: MONO, fontSize: 11, background: "var(--card)", color: "var(--muted)",
  border: "1px solid var(--rule)", borderRadius: 7, padding: "5px 10px", cursor: "pointer",
};

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
      onClick={() => setOpen((o) => !o)}
      style={{
        margin: 0, padding: "10px 12px", background: "var(--card-2)", border: "1px solid var(--rule)",
        borderRadius: 9, fontFamily: MONO, fontSize: 11, lineHeight: 1.55, color: "var(--muted)",
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
      <a key={i} href={part} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: "var(--accent)" }}>
        {part}
      </a>
    ) : (
      part
    ),
  );
}
