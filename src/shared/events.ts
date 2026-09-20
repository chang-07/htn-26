import { z } from "zod";
import { cartsOf, type PlanState } from "../types.ts";

const text = z.string().trim().min(1).max(300);
const url = z.string().url().max(2048).refine(v => /^https?:\/\//.test(v), "Use an HTTP(S) link");
const date = z.string().datetime({ offset: true });
// Keep recursive JSON validation without making Cloudflare RPC types recurse infinitely.
const jsonValue: z.ZodType<unknown> = z.json();
export const eventItemSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.string().trim().min(1).max(60),
  title: text,
  description: z.string().max(2000).optional(),
  status: z.enum(["idea", "saved", "needs_confirmation", "in_progress", "booked", "completed", "cancelled", "failed"]).default("saved"),
  startsAt: date.optional(), endsAt: date.optional(),
  timeLabel: z.string().max(100).optional(),
  location: z.string().max(300).optional(),
  provider: z.object({ name: text, url: url.optional(), logoUrl: url.optional() }).optional(),
  links: z.array(z.object({ label: z.string().min(1).max(80), url, kind: z.enum(["booking", "checkout", "tracking", "info"]).default("info") })).max(12).default([]),
  price: z.string().max(100).optional(),
  details: z.record(z.string().max(80), jsonValue).default({}),
  source: z.enum(["agent", "itinerary", "option", "cart"]).default("agent"),
}).refine(v => !v.startsAt || !v.endsAt || Date.parse(v.endsAt) >= Date.parse(v.startsAt), "End must follow start");
export const eventInputSchema = z.object({
  title: text,
  description: z.string().max(2000).optional(),
  startsAt: date.optional(), endsAt: date.optional(),
  timeZone: z.string().max(80).optional().refine(v => { try { if (v) new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "Use an IANA time zone"),
  location: z.string().max(300).optional(),
  status: z.enum(["planning", "confirmed", "completed", "cancelled"]).default("planning"),
  items: z.array(eventItemSchema).max(150).default([]),
}).refine(v => new Set(v.items.map(i => i.id)).size === v.items.length, "Item IDs must be unique")
  .refine(v => JSON.stringify(v).length <= 100_000, "Event too large")
  .refine(v => !v.startsAt || !v.endsAt || Date.parse(v.endsAt) >= Date.parse(v.startsAt), "End must follow start");
export type EventItem = z.infer<typeof eventItemSchema>;
export type EventInput = z.infer<typeof eventInputSchema>;
export type EventDocument = EventInput & {
  schemaVersion: 1; id: string; groupId: string; createdAt: number; updatedAt: number; revision: number;
  people: string[]; coverUrl?: string;
};
const http = (value?: string) => value && url.safeParse(value).success ? value : undefined;
const link = (value?: string, kind: "booking" | "checkout" = "booking") => http(value) ? [{ label: kind === "checkout" ? "Open checkout" : "Open booking", url: value!, kind }] : [];
const provider = (value?: string) => { try { return { name: new URL(value!).hostname.replace(/^www\./, "") }; } catch { return undefined; } };

/** Preserve generic items while adapting existing agent data into the same contract. */
export function eventFromPlan(state: PlanState, groupId: string, id: string, now = Date.now()): EventDocument {
  const previous = state.event;
  const items: EventItem[] = (previous?.items ?? []).filter(i => i.source === "agent");
  for (const item of state.itinerary ?? []) items.push({
    id: `itinerary:${item.id}`, kind: item.kind, title: item.title, description: item.subtitle,
    status: item.status === "handoff" ? "needs_confirmation" : item.status === "done" ? "completed" : item.status === "confirmed" ? "booked" : "in_progress",
    provider: provider(item.url), links: link(item.url), price: item.price,
    details: { ...(item.note ? { Note: item.note } : {}), ...(item.lastUpdate ? { Update: item.lastUpdate } : {}), ...(item.paidBy ? { "Paid by": item.paidBy } : {}) }, source: "itinerary",
  });
  const included = new Set(items.flatMap(i => i.links.map(l => l.url)));
  for (const option of state.options) {
    if (option.bookingUrl && included.has(option.bookingUrl)) continue;
    const chosen = state.chosenOptionId === option.id;
    items.push({ id: `option:${option.id}`, kind: "activity", title: option.title, description: option.subtitle,
      status: !chosen ? "idea" : state.status === "booked" ? "booked" : state.status === "booking" ? "in_progress" : state.status === "failed" ? "failed" : "needs_confirmation",
      provider: provider(option.bookingUrl), links: link(option.bookingUrl), source: "option",
      details: { ...(option.availability ? { Availability: option.availability } : {}), ...(chosen && state.bookingNote ? { Note: state.bookingNote } : {}) },
    });
  }
  for (const cart of cartsOf(state)) {
    if (included.has(cart.checkoutUrl)) continue;
    items.push({ id: `cart:${cart.shop}`, kind: "food_or_shopping", title: `Order from ${cart.shop}`,
      status: "needs_confirmation", provider: { name: cart.shop }, links: link(cart.checkoutUrl, "checkout"), price: cart.total,
      details: { Items: cart.lines.map(l => `${l.quantity} × ${l.title} · ${l.price}`), ...(cart.paidBy ? { Payment: `${cart.paidBy} marked paid; fulfillment not confirmed` } : {}) }, source: "cart",
    });
  }
  return {
    schemaVersion: 1, id, groupId,
    title: state.title || previous?.title || "Your event", description: previous?.description,
    startsAt: previous?.startsAt, endsAt: previous?.endsAt, timeZone: previous?.timeZone, location: previous?.location,
    status: previous?.status ?? "planning", items: items.map(item => {
      const domain = provider(item.provider?.url || item.links[0]?.url)?.name;
      const logo = state.media?.logos[domain || item.provider?.name || ""];
      return logo ? { ...item, provider: { name: item.provider?.name || domain || item.kind, ...item.provider, logoUrl: logo } } : item;
    }), people: state.going ?? [],
    createdAt: previous?.createdAt ?? now, updatedAt: now, revision: state.version,
    coverUrl: state.media?.title === state.title && state.media.cover?.generated ? state.media.cover.url : undefined,
  };
}
