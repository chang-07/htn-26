import { log } from "../log.ts";
import { pageTitle, proxiedFetch, type SourceEnv } from "./fetch.ts";
import type { Flight } from "./types.ts";

/** Currency for every quote. The demo is Canadian; Google also honours it for prices in USD markets. */
export const CURR = "CAD";
const MAX_RESULTS = 12;

export type FlightQuery = { from: string; to: string; depart: string; return?: string; adults?: number };

/**
 * Google Flights answers a plain-English `q=` with a server-rendered results
 * page (verified 2026-09-19 through a proxied fetch). The `tfs=` deep-link
 * form is not known to render server-side, so this stays with `q=`.
 */
export function flightsUrl(q: FlightQuery): string {
  const words = `Flights to ${q.to} from ${q.from} on ${q.depart}${q.return ? ` returning ${q.return}` : " one way"}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(words)}&curr=${CURR}&hl=en`;
}

const CURRENCIES: Record<string, { code: string; symbol: string }> = {
  "Canadian dollars": { code: "CAD", symbol: "CA$" },
  "US dollars": { code: "USD", symbol: "US$" },
  "British pounds": { code: "GBP", symbol: "£" },
  euros: { code: "EUR", symbol: "€" },
};

/**
 * A round-trip aria-label reads "…dollars round trip total", not just
 * "…dollars" — match by the longest known currency name the phrase starts
 * with, rather than requiring an exact match, and report the qualifier as
 * `roundTrip` rather than losing it as an unrecognized currency string.
 */
function matchCurrency(words: string): { currency: { code: string; symbol: string }; roundTrip: boolean } {
  const key = Object.keys(CURRENCIES)
    .filter((k) => words.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) return { currency: { code: words, symbol: `${words} ` }, roundTrip: false };
  return { currency: CURRENCIES[key], roundTrip: /round trip/i.test(words.slice(key.length)) };
}

// Google's aria-labels join the time and AM/PM with U+202F (narrow no-break
// space), not a plain space; normalize it (and U+00A0) so the regex below,
// and the `departs`/`arrives` strings tests compare against, use " ".
const unescape = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[  ]/g, " ");

/**
 * One aria-label per itinerary, e.g. "From 254 Canadian dollars. Nonstop flight
 * with Flair Airlines. Leaves Toronto Pearson International Airport at 1:55 PM
 * on Saturday, October 10 and arrives at Vancouver International Airport at
 * 4:05 PM on Saturday, October 10. Total duration 5 hr 10 min. Layover (1 of 1)
 * is a 1 hr 5 min layover at Calgary International Airport. …"
 */
const ROW =
  /From (\d[\d,]*) ([A-Za-z ]+?)\. (Nonstop|(\d+) stops?) flights? with (.+?)\. Leaves (.+?) at (\d{1,2}:\d{2} [AP]M) on (.+?) and arrives at (.+?) at (\d{1,2}:\d{2} [AP]M) on (.+?)\. Total duration (.+?)\.(.*)$/;
const LAYOVER = /Layover \(1 of \d+\) is a (.+?) layover at (.+?)\./;

export function parseFlights(html: string, url: string): Flight[] {
  const seen = new Set<string>();
  const flights: Flight[] = [];
  for (const m of html.matchAll(/aria-label="(From \d[^"]*)"/g)) {
    const row = ROW.exec(unescape(m[1]));
    if (!row) continue;
    const [, amount, currencyWords, stopsText, stopsN, airline, from, departs, date, to, arrives, arriveDate, duration, rest] = row;
    const { currency, roundTrip } = matchCurrency(currencyWords);
    const stops = stopsText === "Nonstop" ? 0 : Number(stopsN);
    const key = `${airline}|${departs}|${arrives}|${stops}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const layover = LAYOVER.exec(rest);
    flights.push({
      price: `${currency.symbol}${amount}`,
      currency: currency.code,
      airline,
      from,
      to,
      departs,
      arrives,
      date,
      duration,
      stops,
      ...(layover ? { layover: `${layover[1]} at ${layover[2]}` } : {}),
      ...(roundTrip ? { roundTrip: true } : {}),
      nextDay: arriveDate !== date,
      url,
    });
  }
  const cents = (f: Flight) => Number(f.price.replace(/[^\d]/g, ""));
  return flights.sort((a, b) => cents(a) - cents(b));
}

export async function searchFlights(env: SourceEnv, q: FlightQuery): Promise<Flight[]> {
  const url = flightsUrl(q);
  const page = await proxiedFetch(env, url);
  const flights = parseFlights(page.content, url).slice(0, MAX_RESULTS);
  if (!flights.length) log("warn", "source", "empty", { source: "google-flights", status: page.status, title: pageTitle(page.content) });
  return flights;
}

const shortDate = (date: string) => {
  const m = /^(\w{3})\w*, (\w{3})\w* (\d{1,2})$/.exec(date);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : date;
};

/** Shaped like a propose_plan option, so the model can pass it straight through. */
export function flightOption(f: Flight): { title: string; subtitle: string; bookingUrl: string } {
  const stops = f.stops === 0 ? "nonstop" : `${f.stops} stop${f.stops > 1 ? "s" : ""}${f.layover ? ` (${f.layover.replace(/^.* at /, "")})` : ""}`;
  return {
    title: `${f.airline} ${f.departs} → ${f.arrives}${f.nextDay ? " +1" : ""}, ${stops}`,
    subtitle: `${f.price}${f.roundTrip ? " round trip" : ""} · ${f.duration} · ${shortDate(f.date)}`,
    bookingUrl: f.url,
  };
}
