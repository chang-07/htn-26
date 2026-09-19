import { ImageResponse, loadGoogleFont } from "workers-og";
import { SLOT_EMOJI, type CartSummary, type PlanState } from "../types";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STATUS_LABEL: Record<PlanState["status"], string> = {
  idle: "",
  voting: "Voting",
  booking: "Booking…",
  booked: "Booked",
  failed: "Booking failed",
};

/**
 * The ticket stub from docs/card-design.md, drawn at 3:2. Cream while the plan
 * is open, deep green once it is booked: the ground colour carries the state.
 */
const W = 1200;
const H = 800;
const STUB = 194;

// Fetched once per isolate. Without these the ticket falls back to the bundled
// sans, which loses the whole look.
let fonts: Promise<{ name: string; data: ArrayBuffer; weight: 500 | 800; style: "normal" }[]> | undefined;
const loadFonts = () =>
  (fonts ??= Promise.all([
    loadGoogleFont({ family: "Archivo", weight: 800 }),
    loadGoogleFont({ family: "IBM Plex Mono", weight: 500 }),
  ])
    .then(([archivo, plex]) => [
      { name: "Archivo", data: archivo, weight: 800 as const, style: "normal" as const },
      { name: "IBM Plex Mono", data: plex, weight: 500 as const, style: "normal" as const },
    ])
    .catch((err) => {
      fonts = undefined; // try again on the next render rather than caching the failure
      throw err;
    }));

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export async function renderCard(plan: PlanState): Promise<Response> {
  const booked = plan.status === "booked";
  const ink = booked ? "#f0ece2" : "#241f17";
  const ground = booked ? "#1f5f4f" : "#efe7d6";
  const winner = plan.options.find((o) => o.id === plan.chosenOptionId);
  const votes = Object.values(plan.counts).reduce((a, b) => a + b, 0);

  const meta = (text: string) =>
    `<div style="display:flex;font-size:31px;letter-spacing:4px;opacity:0.62;">${esc(text.toUpperCase())}</div>`;
  const row = (lead: string, text: string, tail = "") => `
    <div style="display:flex;align-items:center;margin-top:14px;">
      ${lead ? `<div style="display:flex;width:64px;font-size:40px;">${lead}</div>` : ""}
      <div style="display:flex;flex:1;font-size:38px;">${esc(clip(text, 30))}</div>
      ${tail ? `<div style="display:flex;font-size:34px;opacity:0.62;">${esc(tail)}</div>` : ""}
    </div>`;

  const rows = booked
    ? [winner?.subtitle, plan.bookingNote].filter((t): t is string => Boolean(t)).map((t) => row("", t)).join("")
    : plan.options.map((o, i) => row(SLOT_EMOJI[i] ?? "", o.title, plan.counts[o.id] ? `x${plan.counts[o.id]}` : "")).join("");

  // Satori has no gradient backgrounds, so the perforation is a column of dots.
  const dot = `<div style="display:flex;width:7px;height:7px;border-radius:4px;margin-top:23px;background:${ink};"></div>`;

  const html = `
  <div style="display:flex;width:${W}px;height:${H}px;background:${ground};color:${ink};font-family:'IBM Plex Mono';">
    <div style="display:flex;flex-direction:column;flex:1;padding:50px 40px 54px 54px;">
      <div style="display:flex;">
        <div style="display:flex;flex:1;">${meta(booked ? "Confirmed" : plan.status === "voting" ? "React to vote" : STATUS_LABEL[plan.status] || "Plan")}</div>
        ${meta(booked ? "See you there" : `${plan.options.length} options`)}
      </div>
      <div style="display:flex;margin-top:14px;font-family:'Archivo';font-weight:800;font-size:${booked ? 84 : 78}px;line-height:1;letter-spacing:-2px;">
        ${esc(clip(booked ? (winner?.title ?? plan.title) : plan.title || "No plan yet", 34))}
      </div>
      <div style="display:flex;flex:1;"></div>
      <div style="display:flex;flex-direction:column;">${rows}</div>
    </div>
    <div style="display:flex;flex-direction:column;width:7px;height:${H}px;margin-top:-12px;opacity:0.32;">${dot.repeat(27)}</div>
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:${STUB}px;">
      <div style="display:flex;font-family:'Archivo';font-weight:800;font-size:${booked ? 58 : 72}px;line-height:1;">${booked ? "GO" : votes}</div>
      <div style="display:flex;margin-top:16px;font-size:27px;letter-spacing:3px;opacity:0.6;">${booked ? "BOOKED" : votes === 1 ? "VOTE" : "VOTES"}</div>
    </div>
  </div>`;

  // Twemoji supplies the tapback emoji as SVG; neither font has them.
  return new ImageResponse(html, { width: W, height: H, emoji: "twemoji", fonts: await loadFonts() });
}

const CART_ROWS = 3;

/** Shopify's CDN resizes on request; a full-size product PNG can be megabytes. */
const thumb = (url: string) => {
  try {
    const u = new URL(url);
    if (u.hostname === "cdn.shopify.com") u.searchParams.set("width", "200");
    return u.toString();
  } catch {
    return url;
  }
};

/** The cart card: what's in it, what it costs, where it's from. Same frame as the plan card. */
export function renderCartCard(cart: CartSummary): Response {
  const shown = cart.lines.slice(0, CART_ROWS);
  const hidden = cart.lines.length - shown.length;

  const rows = shown
    .map(
      (l) => `
      <div style="display:flex;align-items:center;padding:16px 28px;margin-top:16px;border-radius:20px;background:#15151C;">
        ${
          l.imageUrl
            ? `<img src="${esc(thumb(l.imageUrl))}" width="88" height="88" style="border-radius:14px;margin-right:24px;" />`
            : `<div style="display:flex;width:88px;height:88px;border-radius:14px;margin-right:24px;background:#1E1E26;"></div>`
        }
        <div style="display:flex;flex-direction:column;flex:1;">
          <div style="display:flex;font-size:32px;font-weight:600;">${esc(l.title.length > 44 ? `${l.title.slice(0, 43)}…` : l.title)}</div>
          <div style="display:flex;font-size:24px;color:#9C9CAC;">${esc(l.price)}</div>
        </div>
        <div style="display:flex;font-size:32px;color:#9C9CAC;">x${l.quantity}</div>
      </div>`,
    )
    .join("");

  const html = `
  <div style="display:flex;flex-direction:column;width:1200px;height:628px;padding:48px 64px;
              background:#0B0B0F;color:#FAFAFA;font-family:sans-serif;">
    <div style="display:flex;align-items:center;">
      <div style="display:flex;flex-direction:column;flex:1;">
        <div style="display:flex;font-size:48px;font-weight:700;">Cart</div>
        <div style="display:flex;font-size:26px;color:#9C9CAC;">${esc(cart.shop)}${hidden > 0 ? ` · +${hidden} more` : ""}</div>
      </div>
      <div style="display:flex;font-size:48px;font-weight:700;color:#7DE2B0;">${esc(cart.total)}</div>
    </div>
    <div style="display:flex;flex-direction:column;margin-top:12px;">${rows}</div>
  </div>`;

  return new ImageResponse(html, { width: 1200, height: 628 });
}
