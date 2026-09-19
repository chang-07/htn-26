import { log } from "../log.ts";
import { pageTitle, proxiedFetch, type SourceEnv } from "./fetch.ts";
import { CURR } from "./flights.ts";
import type { Stay } from "./types.ts";

const MAX_RESULTS = 10;

export type StayQuery = { where: string; checkin: string; checkout: string; adults?: number };

/** `/travel/hotels?…` answers 302 to this page, so this is the page. */
export function staysUrl(q: StayQuery, name?: string): string {
  const words = name ? `${name} ${q.where}` : `hotels in ${q.where}`;
  return `https://www.google.com/travel/search?q=${encodeURIComponent(words)}&dates=${q.checkin},${q.checkout}&adults=${q.adults ?? 2}&curr=${CURR}&hl=en&gl=ca`;
}

/**
 * The results are not in the DOM of a fetched page but in the largest
 * `AF_initDataCallback({...})` blob, as tuples
 *   ["JW Marriott Parq Vancouver","/aclk?…","$277",null,5186,4.2,
 * (name, link, nightly price, null, review count, rating). Verified 2026-09-19.
 */
const TUPLE = /\["((?:[^"\\]|\\.){3,80})",(?:"[^"]*"|null),"(\$[\d,]+)",null,(\d+),(\d(?:\.\d)?)/g;

export function parseStays(html: string, q: StayQuery): Stay[] {
  const blobs = [...html.matchAll(/AF_initDataCallback\((\{[\s\S]*?\})\);<\/script>/g)].map((m) => m[1]);
  if (!blobs.length) return [];
  const blob = blobs.reduce((a, b) => (b.length > a.length ? b : a));
  const seen = new Set<string>();
  const stays: Stay[] = [];
  for (const m of blob.matchAll(TUPLE)) {
    const name = JSON.parse(`"${m[1]}"`) as string; // the blob is JSON text: & and friends
    if (seen.has(name)) continue;
    seen.add(name);
    stays.push({ name, nightly: m[2], rating: Number(m[4]), reviews: Number(m[3]), url: staysUrl(q, name) });
  }
  const cents = (s: Stay) => Number(s.nightly.replace(/[^\d]/g, ""));
  return stays.sort((a, b) => cents(a) - cents(b));
}

export async function searchStays(env: SourceEnv, q: StayQuery): Promise<Stay[]> {
  const page = await proxiedFetch(env, staysUrl(q));
  const stays = parseStays(page.content, q).slice(0, MAX_RESULTS);
  if (!stays.length) log("warn", "source", "empty", { source: "google-hotels", status: page.status, title: pageTitle(page.content) });
  return stays;
}

export function stayOption(s: Stay): { title: string; subtitle: string; bookingUrl: string } {
  const rating = s.rating ? ` · ${s.rating.toFixed(1)}★${s.reviews ? ` (${s.reviews.toLocaleString("en-CA")} reviews)` : ""}` : "";
  return { title: s.name, subtitle: `${s.nightly}/night${rating}`, bookingUrl: s.url };
}
