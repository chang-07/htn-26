/**
 * The look of every page a card opens into: the vote page (/w) and the profile
 * form (/p). It is the ticket design from src/server/card.ts carried onto a
 * page, not a separate web style — same cream ground, same ink, the one heavy
 * title face, mono for everything else, small spaced-out capitals for labels,
 * and the dotted perforation as the only ornament.
 *
 * What it deliberately has none of: boxes around things, rounded corners,
 * shadows, accent colours, gradients, pill badges. Structure comes from type
 * and space. A finished state (booked, paid, saved) flips the whole page to the
 * green of the PAID ticket rather than adding a badge.
 *
 * Shared by the Worker (profile page, as a string) and the React vote page.
 */
export const TICKET_FONTS =
  "https://fonts.googleapis.com/css2?family=Archivo:wght@800&family=IBM+Plex+Mono:wght@400;500&display=swap";

export const TICKET_CSS = `
.tk-page{
  --ground:#efe7d6; --ink:#241f17; --soft:rgba(36,31,23,.62); --rule:rgba(36,31,23,.34);
  box-sizing:border-box; min-height:100vh; margin:0;
  /* Fluid: the same page serves Safari (~520px column) and the iMessage bubble
     (~340px), so spacing and type scale with viewport width instead of assuming
     the wide case. At >=520px every clamp hits its ceiling = the old values. */
  padding:clamp(16px,5vw,30px) clamp(14px,4vw,22px) clamp(32px,12vw,72px);
  background:var(--ground); color:var(--ink);
  font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace; font-size:clamp(13px,4vw,15px); line-height:1.5;
  -webkit-text-size-adjust:100%;
}
.tk-page.is-done{ --ground:#1f5f4f; --ink:#f0ece2; --soft:rgba(240,236,226,.68); --rule:rgba(240,236,226,.36); }
.tk-page *{ box-sizing:border-box; }
.tk-wrap{ max-width:520px; margin:0 auto; }

.tk-meta{ font-size:11.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--soft); }
.tk-title{ font-family:"Archivo",system-ui,sans-serif; font-weight:800; font-size:clamp(23px,7.5vw,38px); line-height:1; letter-spacing:-.02em; margin:10px 0 0; overflow-wrap:break-word; }
.tk-soft{ color:var(--soft); }
.tk-perf{ border:0; border-top:2px dotted var(--rule); margin:24px 0; }

/* The ticket's header: title on the left, the stub's big figure on the right. */
.tk-head{ display:flex; align-items:stretch; gap:18px; }
.tk-head > div:first-child{ flex:1; min-width:0; }
.tk-stub{ display:flex; flex-direction:column; align-items:center; justify-content:center; min-width:74px; padding-left:18px; border-left:2px dotted var(--rule); text-align:center; }
.tk-stub b{ font-family:"Archivo",system-ui,sans-serif; font-weight:800; font-size:clamp(22px,7vw,34px); line-height:1; }
.tk-stub span{ margin-top:6px; }

/* Rows are lines of type, as on the card image: no borders, no fills. */
.tk-rows{ display:flex; flex-direction:column; margin:0; padding:0; list-style:none; }
.tk-row{ display:flex; align-items:baseline; gap:12px; width:100%; padding:9px 0; margin:0; background:none; border:0; border-radius:0; color:inherit; font:inherit; font-size:17px; text-align:left; }
button.tk-row{ cursor:pointer; -webkit-tap-highlight-color:transparent; }
button.tk-row:active{ opacity:.55; }
button.tk-row:disabled{ cursor:default; }
.tk-row .tk-mark{ width:24px; flex:none; }
.tk-row .tk-grow{ flex:1; min-width:0; }
.tk-row .tk-sub{ display:block; font-size:13px; color:var(--soft); }
.tk-row .tk-num{ flex:none; color:var(--soft); font-variant-numeric:tabular-nums; }
.tk-row.is-mine .tk-name{ text-decoration:underline; text-underline-offset:4px; text-decoration-thickness:2px; }
.tk-row.is-won .tk-name{ font-weight:500; }
.tk-row.is-dim{ color:var(--soft); }

/* The one filled shape: a flat ink block, square, labelled like a ticket stub. */
.tk-action{ display:block; width:100%; margin-top:14px; padding:15px 16px; background:var(--ink); color:var(--ground); border:0; border-radius:0; font:inherit; font-size:12.5px; letter-spacing:.14em; text-transform:uppercase; text-align:center; text-decoration:none; cursor:pointer; }
.tk-action:active{ opacity:.7; }
.tk-action:disabled{ opacity:.5; cursor:default; }

/* Forms: a label and a ruled line to write on. */
.tk-form{ display:flex; flex-direction:column; gap:22px; margin:0; }
.tk-field{ display:flex; flex-direction:column; gap:4px; }
.tk-field input[type=text], .tk-field textarea{ width:100%; padding:7px 0 8px; background:transparent; color:inherit; border:0; border-bottom:1.5px solid var(--ink); border-radius:0; font:inherit; font-size:16px; -webkit-appearance:none; appearance:none; }
.tk-field textarea{ min-height:64px; resize:none; }
.tk-field input::placeholder, .tk-field textarea::placeholder{ color:var(--soft); opacity:.75; }
.tk-field input:focus, .tk-field textarea:focus{ outline:none; border-bottom-width:3px; padding-bottom:6.5px; }
.tk-check{ display:flex; align-items:flex-start; gap:12px; font-size:14px; }
/* A square ruled box that fills with ink, not the platform's rounded control. */
.tk-check input{ -webkit-appearance:none; appearance:none; width:19px; height:19px; margin:2px 0 0; flex:none; background:transparent; border:1.5px solid var(--ink); border-radius:0; cursor:pointer; }
.tk-check input:checked{ background:var(--ink); box-shadow:inset 0 0 0 3px var(--ground); }
.tk-action:focus-visible, .tk-row:focus-visible, .tk-check input:focus-visible{ outline:2px solid var(--ink); outline-offset:3px; }
.tk-small{ font-size:12.5px; color:var(--soft); }
.tk-error{ margin-top:18px; font-size:13px; }

/* In-bubble fit: the same URL is loaded by the Messages extension, whose
   compact drawer strip shows ~300px of height. Everything shrinks in step so
   the title, status and first option rows land inside the strip; Safari and
   the expanded sheet are untouched above this height. */
@media (max-height: 420px){
  .tk-page{ padding:14px 16px 28px; }
  .tk-title{ font-size:25px; }
  .tk-perf{ margin:12px 0; }
  .tk-rows .tk-row{ padding:6px 0; font-size:15px; }
  .tk-row .tk-sub{ font-size:12px; }
  .tk-stub{ min-width:58px; padding-left:12px; }
  .tk-stub b{ font-size:25px; }
  .tk-action{ margin-top:10px; padding:12px 14px; }
}
`;
