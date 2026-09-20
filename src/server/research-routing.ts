/**
 * Flights and places to stay have tools that answer in this turn with real
 * prices (search_flights, search_stays). Research is for venues: it reads
 * guides and listings for minutes, cannot read booking sites, and ends in
 * "nothing found" for a hotel ask. A model that sends a hotel or flight brief
 * to research therefore tells the group it is "checking" and then, minutes
 * later, that the search "came up empty", which is what happened on a real
 * phone on 2026-09-19. This is the code-level backstop for that routing: the
 * research tool refuses such a brief and names the tool to use instead.
 *
 * It is deliberately narrow. A brief about venues that merely mentions a
 * hotel ("hotel bars", "near the hotel") or a flight ("after our flight
 * lands") is still research.
 */
export type TravelKind = "flight" | "stay";

const FLIGHT = /\b(flights?|airfares?|plane tickets?)\b/i;
const STAY = /\b(hotels?|hotel rooms?|motels?|hostels?|airbnbs?|accommodations?|places? to stay|somewhere to stay|lodging)\b/i;
/** "hotel bars", "near the hotel": the hotel is scenery, the brief is about something else. */
const HOTEL_AS_SCENERY = /\b(near|by|at|around|next to|close to|in|from|to)\s+(the|our|my|their)\s+(hotel|flight|airport)\b|\bhotels?\s+(bars?|restaurants?|lobby|lobbies|brunch|pools?|spas?|rooftops?|gyms?)\b/i;
/** "after our flight lands", "before the flight": the flight is a time, not the ask. */
const FLIGHT_AS_TIME = /\b(after|before|until|once|when)\b[^.]{0,30}\bflights?\b/i;

/** The same-turn tool a brief belongs to, or undefined when research is the right call. */
export function travelKindOf(brief: string): TravelKind | undefined {
  const text = brief.trim();
  if (HOTEL_AS_SCENERY.test(text)) return undefined;
  if (STAY.test(text)) return "stay";
  if (FLIGHT_AS_TIME.test(text)) return undefined;
  if (FLIGHT.test(text)) return "flight";
  return undefined;
}

/** What the model is told instead of a research run, so it goes straight to the right tool. */
export function redirectFor(kind: TravelKind): string {
  return kind === "flight"
    ? "Not started: research reads guides and listings, not airlines, and takes minutes. Flights come back in THIS turn from search_flights, with prices and links: call it now (from, to, depart as YYYY-MM-DD; return for a round trip). Ask for the date if it was not given."
    : "Not started: research reads guides and listings, not booking sites, and takes minutes. Places to stay come back in THIS turn from search_stays, with nightly prices and links: call it now (where, checkin and checkout as YYYY-MM-DD, adults). Ask for the dates if they were not given.";
}
