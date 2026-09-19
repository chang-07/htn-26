/** Shapes shared by the Worker and the React vote page. */

/** "handoff": the agent took the booking as far as it may (payment, or a dry run) and a person finishes it. */
export type PlanStatus = "idle" | "voting" | "booking" | "booked" | "handoff" | "failed";

export type PlanOption = {
  id: string;
  title: string;
  subtitle?: string;
  /** Where the booking workflow should go for this option. */
  bookingUrl?: string;
};

export type CartSummary = {
  shop: string;
  checkoutUrl: string;
  /** Display strings, already formatted ("$36.00"). */
  total: string;
  lines: { title: string; quantity: number; price: string; imageUrl?: string }[];
};

/**
 * The agent's *public* state. Everything here is pushed over WebSocket to anyone
 * holding the vote page, so it must never contain phone numbers or the
 * transcript — those live in the agent's private SQLite tables.
 */
export type PlanState = {
  title: string;
  status: PlanStatus;
  options: PlanOption[];
  counts: Record<string, number>;
  chosenOptionId?: string;
  /** Display names only. */
  awaiting: string[];
  cart?: CartSummary;
  bookingNote?: string;
  /** Bumped on every change; used to bust the card image cache. */
  version: number;
};

export const EMPTY_PLAN: PlanState = {
  title: "",
  status: "idle",
  options: [],
  counts: {},
  awaiting: [],
  version: 0,
};

/**
 * Tapback voting. iMessage has six reaction types, so the first four map onto
 * option slots; the convention is announced alongside the card. Votes from the
 * web page carry a real option id and skip this.
 */
export const REACTION_SLOTS = ["love", "like", "laugh", "emphasize"] as const;
export const SLOT_EMOJI = ["❤️", "👍", "😂", "‼️"];
