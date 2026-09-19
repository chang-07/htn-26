import { ImageResponse, loadGoogleFont } from "workers-og";
import { SLOT_EMOJI, cartsTotal, type CartSummary, type PlanState } from "../types";

/**
 * Every card the agent posts is the same object: the ticket stub from
 * docs/card-design.md and docs/card-system-mockups.html. Three rules hold the
 * family together — the ground colour is the state (cream = still needs
 * someone, green = settled), the stub counts one thing, and the body is rows.
 *
 * Card types are builders that return a Ticket; only renderTicket draws.
 */
export type TicketRow = { lead?: string; text: string; tail?: string; dim?: boolean };

export type Ticket = {
  tone: "open" | "done";
  metaLeft: string;
  metaRight?: string;
  title: string;
  /** Four at most; the rest are dropped. */
  rows: TicketRow[];
  stub: { big: string; label: string };
  /** Initials drawn as discs above the title. */
  faces?: string[];
  photoUrl?: string;
};

const W = 1200;
const H = 800;
const STUB = 194;
const PHOTO = 320;

// workers-og does not decode entities, so an escaped "&" would be drawn as
// "&amp;". Markup characters are swapped for look-alikes instead.
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "+", "<": "‹", ">": "›", '"': "”" })[c]!);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

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

export async function renderTicket(t: Ticket): Promise<Response> {
  const done = t.tone === "done";
  const ink = done ? "#f0ece2" : "#241f17";
  const ground = done ? "#1f5f4f" : "#efe7d6";
  // Characters that fit one row of the body at 38px mono.
  const room = t.photoUrl ? 24 : 38;

  const meta = (text: string) =>
    `<div style="display:flex;font-size:31px;letter-spacing:4px;opacity:0.62;">${esc(clip(text, t.photoUrl ? 14 : 22).toUpperCase())}</div>`;

  const rows = t.rows
    .slice(0, 4)
    .map((r) => {
      const width = room - (r.lead ? 3 : 0) - (r.tail ? r.tail.length + 2 : 0);
      return `
    <div style="display:flex;align-items:center;margin-top:14px;opacity:${r.dim ? 0.5 : 1};">
      ${r.lead ? `<div style="display:flex;width:70px;font-size:38px;">${esc(r.lead)}</div>` : ""}
      <div style="display:flex;flex:1;font-size:38px;">${esc(clip(r.text, width))}</div>
      ${r.tail ? `<div style="display:flex;font-size:34px;opacity:0.62;">${esc(r.tail)}</div>` : ""}
    </div>`;
    })
    .join("");

  const faces = (t.faces ?? [])
    .slice(0, 4)
    .map(
      (f) => `<div style="display:flex;align-items:center;justify-content:center;width:96px;height:96px;margin-right:18px;
        border-radius:48px;background:${ink};color:${ground};font-family:'Archivo';font-weight:800;font-size:44px;">${esc(f.slice(0, 1).toUpperCase())}</div>`,
    )
    .join("");

  // Satori has no gradient backgrounds, so the perforation is a column of dots.
  const dot = `<div style="display:flex;width:7px;height:7px;border-radius:4px;margin-top:23px;background:${ink};"></div>`;
  const titleSize = t.title.length > 22 || t.photoUrl ? 66 : 78;
  const bigSize = t.stub.big.length > 4 ? 44 : t.stub.big.length > 2 ? 54 : 72;

  const html = `
  <div style="display:flex;width:${W}px;height:${H}px;background:${ground};color:${ink};font-family:'IBM Plex Mono';">
    ${t.photoUrl ? `<img src="${esc(t.photoUrl)}" width="${PHOTO}" height="${H}" style="object-fit:cover;" />` : ""}
    <div style="display:flex;flex-direction:column;flex:1;padding:50px 40px 54px 54px;">
      <div style="display:flex;">
        <div style="display:flex;flex:1;">${meta(t.metaLeft)}</div>
        ${t.metaRight ? meta(t.metaRight) : ""}
      </div>
      ${faces ? `<div style="display:flex;margin-top:26px;">${faces}</div>` : ""}
      <div style="display:flex;margin-top:${faces ? 20 : 14}px;font-family:'Archivo';font-weight:800;font-size:${titleSize}px;line-height:1;letter-spacing:-2px;">
        ${esc(clip(t.title, t.photoUrl ? 26 : 38))}
      </div>
      <div style="display:flex;flex:1;"></div>
      <div style="display:flex;flex-direction:column;">${rows}</div>
    </div>
    <div style="display:flex;flex-direction:column;width:7px;height:${H}px;margin-top:-12px;opacity:0.32;">${dot.repeat(27)}</div>
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:${STUB}px;">
      <div style="display:flex;font-family:'Archivo';font-weight:800;font-size:${bigSize}px;line-height:1;">${esc(t.stub.big)}</div>
      <div style="display:flex;flex-wrap:wrap;justify-content:center;width:${STUB - 40}px;margin-top:16px;font-size:26px;line-height:1.3;letter-spacing:3px;opacity:0.6;text-align:center;">${esc(clip(t.stub.label, 12).toUpperCase())}</div>
    </div>
  </div>`;

  // Twemoji supplies emoji as SVG; neither font has them.
  return new ImageResponse(html, { width: W, height: H, emoji: "twemoji", fonts: await loadFonts() });
}

// ------------------------------------------------------------------ builders

const STATUS_META: Record<PlanState["status"], string> = {
  idle: "Plan",
  voting: "React to vote",
  booking: "Booking…",
  booked: "Confirmed",
  failed: "Booking failed",
};

export function planTicket(plan: PlanState): Ticket {
  const winner = plan.options.find((o) => o.id === plan.chosenOptionId);
  const votes = Object.values(plan.counts).reduce((a, b) => a + b, 0);
  if (plan.status === "booked") {
    return {
      tone: "done",
      metaLeft: STATUS_META.booked,
      metaRight: "See you there",
      title: winner?.title ?? plan.title,
      rows: [winner?.subtitle, plan.bookingNote].filter((x): x is string => Boolean(x)).map((text) => ({ text })),
      stub: { big: "GO", label: "Booked" },
    };
  }
  return {
    tone: "open",
    metaLeft: STATUS_META[plan.status],
    metaRight: `${plan.options.length} options`,
    title: plan.title || "No plan yet",
    rows: plan.options.map((o, i) => ({
      lead: SLOT_EMOJI[i],
      text: o.title,
      tail: plan.counts[o.id] ? `x${plan.counts[o.id]}` : undefined,
    })),
    stub: { big: String(votes), label: votes === 1 ? "Vote" : "Votes" },
  };
}

/** `people` is the headcount to split across; a paid cart flips the ticket to green. */
export function cartTicket(cart: CartSummary, people = 0, paidBy: string | undefined = cart.paidBy): Ticket {
  const items = cart.lines.reduce((n, l) => n + l.quantity, 0);
  const total = Number(cart.total.replace(/[^0-9.]/g, ""));
  const symbol = cart.total.replace(/[0-9.,\s]/g, "") || "$";
  const each = people > 1 && total ? `${symbol}${(total / people).toFixed(2)} each` : undefined;
  // The stub has room for about five characters, so drop the cents there.
  const short = total ? `${symbol.slice(-1)}${Math.round(total)}` : cart.total;

  if (paidBy) {
    return {
      tone: "done",
      metaLeft: "Ordered",
      metaRight: cart.shop,
      title: cart.lines.length === 1 ? cart.lines[0].title : `${items} items from ${cart.shop.replace(/\.[a-z.]+$/, "")}`,
      rows: [{ text: `${paidBy} paid · ${cart.total}` }, ...(each ? [{ text: `Everyone owes ${each.replace(" each", "")}` }] : [])],
      stub: { big: "PAID", label: short },
    };
  }
  const shown = cart.lines.slice(0, each ? 3 : 4);
  return {
    tone: "open",
    metaLeft: cart.shop,
    metaRight: `${items} item${items === 1 ? "" : "s"}`,
    title: cart.lines.length === 1 ? cart.lines[0].title : `Order from ${cart.shop.replace(/\.[a-z.]+$/, "")}`,
    rows: [
      ...shown.map((l) => ({ lead: `${l.quantity}×`, text: l.title, tail: l.price })),
      ...(each ? [{ text: `Split ${people} ways`, tail: each }] : []),
    ],
    // A photo cannot be tapped; the pay card sits directly under it.
    stub: { big: short, label: "Total" },
  };
}

/**
 * Every store's order on one ticket. An event shops in several places, and the
 * per-store tickets alone never show what the whole thing costs or what is
 * still unpaid. Totals are summed only when the stores share a currency.
 */
export function shoppingListTicket(carts: CartSummary[], people = 0): Ticket {
  const storeName = (shop: string) => shop.replace(/\.[a-z.]+$/, "");
  const items = carts.reduce((n, c) => n + c.lines.reduce((m, l) => m + l.quantity, 0), 0);
  const sum = cartsTotal(carts);
  const unpaid = carts.filter((c) => !c.paidBy);
  const allPaid = carts.length > 0 && unpaid.length === 0;
  const each = sum && people > 1 && sum.amount ? `${sum.symbol}${(sum.amount / people).toFixed(2)} each` : undefined;
  const short = sum ? `${sum.symbol.slice(-1)}${Math.round(sum.amount)}` : String(carts.length);

  // Four rows at most: stores first, then the split when there is room.
  const shown = carts.slice(0, each ? 3 : 4);
  const hidden = carts.length - shown.length;
  return {
    tone: allPaid ? "done" : "open",
    metaLeft: allPaid ? "All ordered" : "Shopping list",
    metaRight: `${carts.length} store${carts.length === 1 ? "" : "s"} · ${items} item${items === 1 ? "" : "s"}`,
    title: allPaid ? "Everything's paid" : unpaid.length === carts.length ? "What we're ordering" : `${unpaid.length} left to pay`,
    rows: [
      ...shown.map((c, i) => ({
        lead: c.paidBy ? "✅" : "🛒",
        text: storeName(c.shop) + (i === shown.length - 1 && hidden > 0 ? ` +${hidden} more` : ""),
        tail: c.paidBy ? `${c.paidBy} paid` : c.total,
        dim: Boolean(c.paidBy) && !allPaid,
      })),
      ...(each ? [{ text: `Split ${people} ways`, tail: each }] : []),
    ],
    stub: allPaid ? { big: "PAID", label: sum ? short : "All stores" } : { big: short, label: sum ? "Total" : "Stores" },
  };
}

export type Venue = { name: string; kind?: string; price?: string; why?: string; address?: string; caveat?: string; photoUrl?: string };

/** `slot` is this venue's position among the plan's options, when it is one. */
export function venueTicket(v: Venue, slot: number, votes: number): Ticket {
  const onBallot = slot >= 0 && slot < SLOT_EMOJI.length;
  return {
    tone: "open",
    metaLeft: [v.kind, v.price].filter(Boolean).join(" · ") || "Venue",
    title: v.name,
    rows: [v.why, v.address, v.caveat].filter((x): x is string => Boolean(x)).map((text) => ({ text })),
    stub: onBallot
      ? { big: SLOT_EMOJI[slot], label: votes ? `${votes} so far` : "To pick" }
      : { big: v.price && v.price.length <= 4 ? v.price : "?", label: v.price && v.price.length <= 4 ? "Price" : "Ask me" },
    photoUrl: v.photoUrl,
  };
}

export type Rsvps = { title: string; when?: string; going: string[]; out: string[]; waiting: string[]; locked: boolean };

export function rsvpTicket(r: Rsvps): Ticket {
  const total = r.going.length + r.out.length + r.waiting.length;
  if (r.locked) {
    return {
      tone: "done",
      metaLeft: "Headcount locked",
      metaRight: r.when,
      title: r.going.length ? `Table for ${r.going.length}` : "Nobody's in",
      rows: [
        ...(r.going.length ? [{ lead: "👍", text: r.going.join(", ") }] : []),
        ...(r.out.length ? [{ lead: "👎", text: r.out.join(", "), dim: true }] : []),
      ],
      stub: { big: String(r.going.length), label: "Going" },
    };
  }
  return {
    tone: "open",
    metaLeft: "👍 in · 👎 out",
    metaRight: r.when,
    title: r.title || "Who's in?",
    rows: [
      ...(r.going.length ? [{ lead: "👍", text: r.going.join(", ") }] : []),
      ...(r.out.length ? [{ lead: "👎", text: r.out.join(", ") }] : []),
      ...(r.waiting.length ? [{ lead: "…", text: r.waiting.join(", "), tail: "no reply", dim: true }] : []),
    ],
    stub: { big: `${r.going.length}/${total}`, label: "In" },
  };
}

export function matchTicket(a: string, b: string, common: { emoji?: string; text: string }[]): Ticket {
  return {
    tone: "open",
    metaLeft: "You two should meet",
    metaRight: "Both opted in",
    title: `${a} + ${b}`,
    rows: common.slice(0, 3).map((c) => ({ lead: c.emoji, text: c.text })),
    stub: { big: String(Math.min(common.length, 3)), label: "In common" },
    faces: [a, b],
  };
}

// The two cards Linq's layout.image_url points at.
export const renderCard = (plan: PlanState) => renderTicket(planTicket(plan));
export const renderCartCard = (cart: CartSummary) => renderTicket(cartTicket(cart));
