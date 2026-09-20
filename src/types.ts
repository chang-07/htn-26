/** Shapes shared by the Worker and the React vote page. */

import type { EventDocument } from "./shared/events";
import type { Expense } from "./invoice";

/** "handoff": the agent took the booking as far as it may (payment, or a dry run) and a person finishes it. */
export type PlanStatus = "idle" | "voting" | "booking" | "booked" | "handoff" | "failed";

export type PlanOption = {
  id: string;
  title: string;
  subtitle?: string;
  /** Where the booking workflow should go for this option. */
  bookingUrl?: string;
  /** Open times read off the venue's own booking page, e.g. "open Fri: 6:40 PM, 9:20 PM". */
  availability?: string;
};

/**
 * One commitment on the trip: the flight the group picked, the hotel, the
 * game, the venue the pilot booked, a paid order on its way. `handoff` means
 * a person finishes it at `url`; `watching` means the agent is checking on it.
 */
export type ItineraryItem = {
  id: string;
  kind: "flight" | "stay" | "event" | "venue" | "order";
  title: string;
  subtitle?: string;
  url?: string;
  /** Display string, e.g. "CA$254". */
  price?: string;
  status: "handoff" | "confirmed" | "watching" | "done";
  /** Confirmation number, flight number, tracking number. */
  note?: string;
  /** Display name. */
  paidBy?: string;
  watch?: { flight: { ident: string; date?: string } } | { order: { url: string; shop: string } };
  /** The last line posted about it. */
  lastUpdate?: string;
};

export const ITEM_EMOJI: Record<ItineraryItem["kind"], string> = { flight: "✈️", stay: "🏨", event: "🎟️", venue: "📍", order: "📦" };

export type CartSummary = {
  shop: string;
  checkoutUrl: string;
  /** Display strings, already formatted ("$36.00"). */
  total: string;
  lines: { variantId?: string; title: string; quantity: number; price: string; imageUrl?: string }[];
  /** Display name of whoever said they paid. Cleared when the cart is edited. */
  paidBy?: string;
};

/**
 * The agent's *public* state. Everything here is pushed over WebSocket to anyone
 * holding the vote page, so it must never contain phone numbers or the
 * transcript — those live in the agent's private SQLite tables.
 */
export type PlanMedia = {
  title: string;
  cover?: { url: string; generated?: boolean; source?: string; credit?: string; attributionFree?: boolean };
  logos: Record<string, string>;
};

export type PlanState = {
  event?: EventDocument;
  media?: PlanMedia;
  title: string;
  /** One emoji for the outing, picked by the model with the ballot. Badges the chat once it is booked. */
  emoji?: string;
  status: PlanStatus;
  options: PlanOption[];
  counts: Record<string, number>;
  chosenOptionId?: string;
  /** Display names only. */
  awaiting: string[];
  /**
   * One cart per store, keyed by `shop`. An event usually shops in several
   * places (cake here, balloons there), and editing one must not disturb another.
   */
  carts?: CartSummary[];
  /** @deprecated Pre-multi-store state. Read through cartsOf(); never written. */
  cart?: CartSummary;
  /** The group playlist, oldest first. Lives here so the music page gets it over the same socket. */
  playlist?: Track[];
  bookingNote?: string;
  /**
   * Money paid outside any cart and logged from the conversation (the bill,
   * a deposit, paying someone back). With the carts, the whole invoice.
   */
  expenses?: Expense[];
  /**
   * Display names every cost is split across: those who said they are in, or
   * everyone in the chat until anyone has answered. Same footing as `awaiting`.
   */
  going?: string[];
  /** The trip so far, one entry per settled segment. Display names only. */
  itinerary?: ItineraryItem[];
  /** Bumped on every change; used to bust the card image cache. */
  version: number;
};

/** One song on the group playlist. Preview and art come from the iTunes Search API. */
export type Track = {
  title: string;
  artist: string;
  artUrl?: string;
  /** 30-second m4a preview; some tracks have none. */
  previewUrl?: string;
  /** Display name of whoever asked for it. */
  addedBy?: string;
};

export const EMPTY_PLAN: PlanState = {
  title: "",
  status: "idle",
  options: [],
  counts: {},
  awaiting: [],
  carts: [],
  expenses: [],
  going: [],
  itinerary: [],
  version: 0,
};

/**
 * Every cart in the plan. Durable Objects created before carts were per-store
 * still hold a single `cart`; it is read as a one-store list so nothing breaks,
 * and disappears the first time any cart is written.
 */
export function cartsOf(plan: Pick<PlanState, "carts" | "cart">): CartSummary[] {
  if (plan.carts?.length) return plan.carts;
  return plan.cart ? [plan.cart] : [];
}

/** "https://www.PartyCity.com/x" and "partycity.com" are the same store. */
export function shopKey(shop: string) {
  return shop.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/**
 * Sum of cart totals, which are display strings ("$36.00", "CA$128.00"). Null
 * when the stores charge in different currencies: adding those would be a lie.
 */
export function cartsTotal(carts: CartSummary[]): { symbol: string; amount: number } | null {
  const symbols = new Set(carts.map((c) => c.total.replace(/[0-9.,\s]/g, "") || "$"));
  if (symbols.size !== 1) return null;
  const amount = carts.reduce((n, c) => n + (Number(c.total.replace(/[^0-9.]/g, "")) || 0), 0);
  return { symbol: [...symbols][0], amount };
}

/**
 * Tapback voting. iMessage has six reaction types, so the first four map onto
 * option slots; the convention is announced alongside the card. Votes from the
 * web page carry a real option id and skip this.
 */
export const REACTION_SLOTS = ["love", "like", "laugh", "emphasize"] as const;
export const SLOT_EMOJI = ["❤️", "👍", "😂", "‼️"];
