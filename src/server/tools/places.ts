import { log } from "../log";

/**
 * Venue search. Swap the body for a real provider (Google Places, Yelp, ...) —
 * the agent only depends on this shape.
 */
export type Place = {
  name: string;
  address?: string;
  category?: string;
  bookingUrl?: string;
};

export async function searchPlaces(query: string, near: string, limit = 5): Promise<Place[]> {
  // TODO: replace with a real provider before the demo.
  log("warn", "tools", "places.stub", { query, near });
  return Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
    name: `${query} spot ${i + 1}`,
    address: near,
    category: query,
    bookingUrl: "https://resy.com/",
  }));
}
