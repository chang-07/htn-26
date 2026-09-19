# Trip Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent finds flights, stays and events with browse.sh recipes over Browserbase Fetch, the group votes on them with tapbacks, the winner becomes an itinerary item with a deep link, and the agent tracks flights and deliveries into the chat.

**Architecture:** A new `src/server/sources/` folder holds one pure parser plus one fetcher per site, all over a single `proxiedFetch` helper (Browserbase Fetch API with residential proxies, no browser sessions). Five new tools in `tools/index.ts` are executed in `agent.ts` `runTool`, results are shaped as ballot options for the existing `propose_plan`, and a new `itinerary` list on `PlanState` records commitments. A scheduled `checkWatches` method diffs flight and order snapshots and posts changes as text.

**Tech Stack:** TypeScript on Cloudflare Workers (Durable Object agent via the `agents` package), zod 4, `node --test` with Node 24 type stripping for unit tests, `scripts/smoke.mjs` against the dev server on port 5174 in this worktree.

**Spec:** `docs/superpowers/specs/2026-09-19-trip-sources-design.md`

## Global Constraints

- Every lookup is HTTP through `proxiedFetch`; never open a Browserbase browser session for these features (the account's plan returns 402 for proxied sessions).
- Read-only: the agent never books or pays for flights, stays or tickets. Deep links only.
- Public `PlanState` (pushed to the vote page) holds display names only, never phone numbers.
- Response bodies are never logged. Log `source.empty` with the page title when a parser finds nothing.
- `checkWatches` never runs more often than every 15 minutes and stops scheduling itself when no watch is active.
- Currency is CAD, the constant `CURR = "CAD"` in `flights.ts`.
- Run everything from `/Users/loadedguns/Downloads/htn-26/.claude/worktrees/trip-sources`. The dev server for this worktree is `npm run dev` on `http://localhost:5174` (`PUBLIC_BASE_URL` in `.dev.vars` already points there); the smoke script takes `SMOKE_BASE=http://127.0.0.1:5174`.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Prettier-style formatting as in the surrounding files: 2-space indent, double quotes, trailing commas, 140-column lines are fine.

---

## File map

| File | Responsibility |
|---|---|
| `src/server/sources/fetch.ts` (new) | `proxiedFetch`, `SourceError`, `pageTitle` |
| `src/server/sources/types.ts` (new) | `Flight`, `Stay`, `Event`, `FlightStatus`, `OrderStatus` |
| `src/server/sources/flights.ts` (new) | `flightsUrl`, `parseFlights`, `searchFlights`, `flightOption` |
| `src/server/sources/stays.ts` (new) | `staysUrl`, `parseStays`, `searchStays`, `stayOption` |
| `src/server/sources/events.ts` (new) | `parseTicketmasterSearch`, `parseTicketmasterEvents`, `parseLuma`, `findEvents`, `eventOption` |
| `src/server/sources/flight-status.ts` (new) | `icaoIdent`, `parseFlightStatus`, `flightStatus`, `describeFlight` |
| `src/server/sources/order-status.ts` (new) | `parseOrderStatus`, `orderStatus` |
| `src/server/sources/watch.ts` (new) | `diffFlight`, `diffOrder`, `flightWatchActive`, `orderWatchActive` |
| `src/types.ts` | `ItineraryItem`, `PlanState.itinerary` |
| `src/server/card.ts` | `itineraryTicket` |
| `src/server/tools/index.ts` | five tool schemas and descriptions |
| `src/server/agent.ts` | tool cases, itinerary helpers, `checkWatches`, context line, prompt paragraph, pay/booking hooks |
| `src/server/booking.ts` | `PayResult.orderUrl` |
| `src/server/index.ts` | dev routes and the `itinerary` card preview |
| `scripts/sources.test.mjs` (new) | parser tests on fixtures |
| `scripts/watch.test.mjs` (new) | diff tests |
| `scripts/smoke.mjs` | itinerary, shipped, card and live-flights checks |
| `README.md` | "Trips" section |

---

### Task 1: `proxiedFetch` and the shared types

**Files:**
- Create: `src/server/sources/fetch.ts`
- Create: `src/server/sources/types.ts`
- Test: `scripts/sources.test.mjs`

**Interfaces:**
- Produces: `proxiedFetch(env: SourceEnv, url: string, opts?: { headers?: Record<string, string>; proxies?: boolean }): Promise<{ status: number; content: string }>`, `class SourceError extends Error { code: "no_browserbase" | "http" }`, `pageTitle(html: string): string`, and every type in `types.ts` (copied below verbatim; later tasks import them).

- [ ] **Step 1: Write the failing test**

Create `scripts/sources.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { proxiedFetch, SourceError, pageTitle } from "../src/server/sources/fetch.ts";

const env = { BROWSERBASE_API_KEY: "bb-test" };

test("proxiedFetch posts to Browserbase Fetch with proxies and the key", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.browserbase.com/v1/fetch");
    assert.equal(init.headers["X-BB-API-Key"], "bb-test");
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { url: "https://www.example.com/x", proxies: true, headers: { Accept: "text/html" } });
    return new Response(JSON.stringify({ statusCode: 200, content: "<title>Hi</title>" }), { headers: { "content-type": "application/json" } });
  });
  const out = await proxiedFetch(env, "https://www.example.com/x", { headers: { Accept: "text/html" } });
  assert.deepEqual(out, { status: 200, content: "<title>Hi</title>" });
});

test("proxiedFetch without proxies is a plain fetch", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.luma.com/x");
    assert.equal(init.method ?? "GET", "GET");
    return new Response("{}", { status: 200 });
  });
  const out = await proxiedFetch({}, "https://api.luma.com/x", { proxies: false });
  assert.deepEqual(out, { status: 200, content: "{}" });
});

test("proxiedFetch refuses a proxied fetch without a Browserbase key", async () => {
  await assert.rejects(() => proxiedFetch({}, "https://www.example.com"), (err) => err instanceof SourceError && err.code === "no_browserbase");
});

test("proxiedFetch turns a Browserbase error into SourceError(http)", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 402 }));
  await assert.rejects(() => proxiedFetch(env, "https://www.example.com"), (err) => err instanceof SourceError && err.code === "http" && /402/.test(err.message));
});

test("pageTitle reads the title or falls back", () => {
  assert.equal(pageTitle("<html><head><title>Toronto to Vancouver | Google Flights</title></head></html>"), "Toronto to Vancouver | Google Flights");
  assert.equal(pageTitle("<html></html>"), "(no title)");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/sources.test.mjs`
Expected: FAIL, "Cannot find module '../src/server/sources/fetch.ts'".

- [ ] **Step 3: Write `types.ts`**

Create `src/server/sources/types.ts`:

```ts
/**
 * What each source returns. Display strings are already formatted for the
 * chat ("CA$254", "$277"); times for flights are the local wall-clock text
 * Google shows, and epoch seconds for FlightAware, which knows the zone.
 */
export type Flight = {
  price: string;
  currency: string;
  airline: string;
  from: string;
  to: string;
  departs: string;
  arrives: string;
  date: string;
  duration: string;
  stops: number;
  layover?: string;
  nextDay: boolean;
  url: string;
};

export type Stay = {
  name: string;
  nightly: string;
  rating?: number;
  reviews?: number;
  url: string;
};

export type Event = {
  title: string;
  when: string;
  venue?: string;
  city?: string;
  url: string;
  onsale?: string;
  soldOut?: boolean;
  limited?: boolean;
  source: "ticketmaster" | "luma";
};

export type FlightStatus = {
  ident: string;
  iata: string;
  status: "scheduled" | "departed" | "landed" | "cancelled" | "unknown";
  from: string;
  to: string;
  fromTz?: string;
  toTz?: string;
  gateFrom?: string;
  terminalFrom?: string;
  gateTo?: string;
  terminalTo?: string;
  scheduledDeparture: number;
  estimatedDeparture?: number;
  actualDeparture?: number;
  scheduledArrival: number;
  estimatedArrival?: number;
  actualArrival?: number;
  delayMinutes: number;
  url: string;
};

export type OrderStatus = {
  fulfilled: boolean;
  delivered: boolean;
  carrier?: string;
  tracking?: string;
  trackingUrl?: string;
  eta?: string;
};
```

- [ ] **Step 4: Write `fetch.ts`**

Create `src/server/sources/fetch.ts`:

```ts
import { traceOperation } from "../telemetry";

export type SourceEnv = { BROWSERBASE_API_KEY?: string };

/** A source could not get a page. `code` is what the model-facing message keys on. */
export class SourceError extends Error {
  constructor(
    public code: "no_browserbase" | "http",
    message: string,
  ) {
    super(message);
  }
}

/**
 * One HTTP page through Browserbase Fetch with residential proxies: the sites
 * these sources read block datacenter IPs but serve a plain proxied request.
 * `proxies: false` is an ordinary fetch, for APIs that need neither.
 * Bodies are never logged; an upstream error can echo the request.
 */
export async function proxiedFetch(
  env: SourceEnv,
  url: string,
  opts: { headers?: Record<string, string>; proxies?: boolean } = {},
): Promise<{ status: number; content: string }> {
  const host = new URL(url).hostname;
  return traceOperation("provider.fetch", "http.client", { provider: host, proxies: opts.proxies !== false }, async () => {
    if (opts.proxies === false) {
      const res = await fetch(url, { headers: opts.headers, signal: AbortSignal.timeout(30_000) });
      return { status: res.status, content: await res.text() };
    }
    if (!env.BROWSERBASE_API_KEY) throw new SourceError("no_browserbase", "BROWSERBASE_API_KEY is required for a proxied fetch");
    const res = await fetch("https://api.browserbase.com/v1/fetch", {
      method: "POST",
      headers: { "X-BB-API-Key": env.BROWSERBASE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ url, proxies: true, ...(opts.headers ? { headers: opts.headers } : {}) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new SourceError("http", `Browserbase fetch of ${host}: HTTP ${res.status}`);
    const data = (await res.json()) as { statusCode?: number; content?: string };
    return { status: data.statusCode ?? 0, content: data.content ?? "" };
  });
}

/** For `source.empty` logs: which page came back, without the page. */
export function pageTitle(html: string): string {
  return html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() || "(no title)";
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test scripts/sources.test.mjs`
Expected: 5 passing.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no output (clean).

```bash
git add src/server/sources/fetch.ts src/server/sources/types.ts scripts/sources.test.mjs
git commit -m "Sources: one proxied fetch for the browse.sh recipes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Google Flights

**Files:**
- Create: `src/server/sources/flights.ts`
- Test: `scripts/sources.test.mjs` (append)
- Fixture: `scripts/fixtures/sources/google-flights.html` (exists)

**Interfaces:**
- Consumes: `proxiedFetch`, `pageTitle`, `SourceEnv` from Task 1; `Flight` from `types.ts`.
- Produces: `type FlightQuery = { from: string; to: string; depart: string; return?: string; adults?: number }`, `flightsUrl(q: FlightQuery): string`, `parseFlights(html: string, url: string): Flight[]`, `searchFlights(env: SourceEnv, q: FlightQuery): Promise<Flight[]>`, `flightOption(f: Flight): { title: string; subtitle: string; bookingUrl: string }`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/sources.test.mjs`:

```js
import fs from "node:fs";
import { flightsUrl, parseFlights, searchFlights, flightOption } from "../src/server/sources/flights.ts";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), "utf8");

test("flightsUrl asks Google Flights in plain words, in CAD", () => {
  assert.equal(
    flightsUrl({ from: "YYZ", to: "YVR", depart: "2026-10-10" }),
    "https://www.google.com/travel/flights?q=Flights%20to%20YVR%20from%20YYZ%20on%202026-10-10%20one%20way&curr=CAD&hl=en",
  );
  assert.match(flightsUrl({ from: "Toronto", to: "Vancouver", depart: "2026-10-10", return: "2026-10-14" }), /on%202026-10-10%20returning%202026-10-14&/);
});

test("parseFlights reads every itinerary sentence, cheapest first, without repeats", () => {
  const url = flightsUrl({ from: "YYZ", to: "YVR", depart: "2026-10-10" });
  const flights = parseFlights(fixture("google-flights.html"), url);
  assert.ok(flights.length >= 20, `only ${flights.length} flights`);
  const cheapest = flights[0];
  assert.equal(cheapest.price, "CA$254");
  assert.equal(cheapest.currency, "CAD");
  assert.equal(cheapest.airline, "Flair Airlines");
  assert.equal(cheapest.stops, 0);
  assert.equal(cheapest.from, "Toronto Pearson International Airport");
  assert.equal(cheapest.to, "Vancouver International Airport");
  assert.equal(cheapest.departs, "1:55 PM");
  assert.equal(cheapest.arrives, "4:05 PM");
  assert.equal(cheapest.date, "Saturday, October 10");
  assert.equal(cheapest.duration, "5 hr 10 min");
  assert.equal(cheapest.nextDay, false);
  assert.equal(cheapest.url, url);
  const oneStop = flights.find((f) => f.stops === 1 && f.airline === "WestJet");
  assert.ok(oneStop, "no one-stop WestJet flight");
  assert.match(oneStop.layover, /^1 hr \d+ min at Calgary/);
  const redEye = flights.find((f) => f.departs === "10:30 PM" && f.airline === "WestJet");
  assert.equal(redEye.nextDay, true);
  const keys = flights.map((f) => `${f.airline}|${f.departs}|${f.arrives}|${f.stops}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate rows");
  for (let i = 1; i < flights.length; i++) assert.ok(Number(flights[i].price.replace(/\D/g, "")) >= Number(flights[i - 1].price.replace(/\D/g, "")), "not sorted by price");
});

test("parseFlights returns nothing on a page without results", () => {
  assert.deepEqual(parseFlights("<html><title>Google Flights</title></html>", "https://x"), []);
});

test("searchFlights fetches through the proxy and caps at 12", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.browserbase.com/v1/fetch");
    assert.match(JSON.parse(init.body).url, /^https:\/\/www\.google\.com\/travel\/flights\?q=/);
    return new Response(JSON.stringify({ statusCode: 200, content: fixture("google-flights.html") }), { headers: { "content-type": "application/json" } });
  });
  const flights = await searchFlights(env, { from: "YYZ", to: "YVR", depart: "2026-10-10" });
  assert.equal(flights.length, 12);
});

test("flightOption is one ballot line", () => {
  const f = { price: "CA$254", currency: "CAD", airline: "Flair Airlines", from: "Toronto Pearson International Airport", to: "Vancouver International Airport", departs: "1:55 PM", arrives: "4:05 PM", date: "Saturday, October 10", duration: "5 hr 10 min", stops: 0, nextDay: false, url: "https://g" };
  assert.deepEqual(flightOption(f), { title: "Flair Airlines 1:55 PM → 4:05 PM, nonstop", subtitle: "CA$254 · 5 hr 10 min · Sat Oct 10", bookingUrl: "https://g" });
  assert.equal(flightOption({ ...f, stops: 1, layover: "1 hr 5 min at Calgary International Airport", nextDay: true }).title, "Flair Airlines 1:55 PM → 4:05 PM +1, 1 stop (Calgary International Airport)");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/sources.test.mjs`
Expected: FAIL, "Cannot find module '../src/server/sources/flights.ts'".

- [ ] **Step 3: Write `flights.ts`**

Create `src/server/sources/flights.ts`:

```ts
import { log } from "../log";
import { pageTitle, proxiedFetch, type SourceEnv } from "./fetch";
import type { Flight } from "./types";

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

const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

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
    const currency = CURRENCIES[currencyWords] ?? { code: currencyWords, symbol: `${currencyWords} ` };
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
    subtitle: `${f.price} · ${f.duration} · ${shortDate(f.date)}`,
    bookingUrl: f.url,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/sources.test.mjs`
Expected: all passing. If the layover assertion fails, print `flights.find(f => f.stops === 1)` and adjust `LAYOVER` to the exact sentence in the fixture; do not loosen the test to `ok(true)`.

- [ ] **Step 5: Try it live once**

Run (needs `BROWSERBASE_API_KEY` in `.dev.vars`; this spends one proxied fetch):

```bash
node --input-type=module -e '
import { searchFlights, flightOption } from "./src/server/sources/flights.ts";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".dev.vars","utf8").split("\n").filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf("=")),l.slice(l.indexOf("=")+1).trim()]));
const f = await searchFlights(env, { from: "YYZ", to: "YVR", depart: "2026-10-10", return: "2026-10-14" });
console.log(f.length, f.slice(0,3).map(flightOption));
'
```

Expected: at least one row. If the round-trip query returns 0 rows but a one-way does, change the `return` phrasing in `flightsUrl` to `through ${q.return}` and retry; keep whichever phrasing returns rows and update the `flightsUrl` test to match. Note the outcome in the commit message.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/server/sources/flights.ts scripts/sources.test.mjs
git commit -m "Sources: Google Flights, cheapest first, as ballot options

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Google Hotels

**Files:**
- Create: `src/server/sources/stays.ts`
- Test: `scripts/sources.test.mjs` (append)
- Fixture: `scripts/fixtures/sources/google-hotels.html` (exists)

**Interfaces:**
- Consumes: Task 1.
- Produces: `type StayQuery = { where: string; checkin: string; checkout: string; adults?: number }`, `staysUrl(q: StayQuery): string`, `parseStays(html: string, q: StayQuery): Stay[]`, `searchStays(env, q): Promise<Stay[]>`, `stayOption(s: Stay): { title: string; subtitle: string; bookingUrl: string }`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/sources.test.mjs`:

```js
import { staysUrl, parseStays, searchStays, stayOption } from "../src/server/sources/stays.ts";

const stayQ = { where: "Vancouver", checkin: "2026-10-10", checkout: "2026-10-12", adults: 4 };

test("staysUrl uses the search page that does not redirect", () => {
  assert.equal(
    staysUrl(stayQ),
    "https://www.google.com/travel/search?q=hotels%20in%20Vancouver&dates=2026-10-10,2026-10-12&adults=4&curr=CAD&hl=en&gl=ca",
  );
});

test("parseStays reads name, nightly price, rating and reviews from the data blob", () => {
  const stays = parseStays(fixture("google-hotels.html"), stayQ);
  assert.ok(stays.length >= 5, `only ${stays.length} stays`);
  const rosewood = stays.find((s) => s.name === "Rosewood Hotel Georgia");
  assert.deepEqual(rosewood, {
    name: "Rosewood Hotel Georgia",
    nightly: "$467",
    rating: 4.6,
    reviews: 2631,
    url: "https://www.google.com/travel/search?q=Rosewood%20Hotel%20Georgia%20Vancouver&dates=2026-10-10,2026-10-12&adults=4&curr=CAD&hl=en&gl=ca",
  });
  assert.equal(stays[0].nightly, "$185", "not sorted by price");
  assert.equal(new Set(stays.map((s) => s.name)).size, stays.length, "duplicate names");
});

test("parseStays returns nothing without the blob", () => {
  assert.deepEqual(parseStays("<html><title>x</title></html>", stayQ), []);
});

test("searchStays caps at 10", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ statusCode: 200, content: fixture("google-hotels.html") }), { headers: { "content-type": "application/json" } }));
  const stays = await searchStays(env, stayQ);
  assert.ok(stays.length <= 10 && stays.length >= 5);
});

test("stayOption is one ballot line", () => {
  assert.deepEqual(stayOption({ name: "JW Marriott Parq Vancouver", nightly: "$277", rating: 4.2, reviews: 5186, url: "https://g" }), {
    title: "JW Marriott Parq Vancouver",
    subtitle: "$277/night · 4.2★ (5,186 reviews)",
    bookingUrl: "https://g",
  });
  assert.equal(stayOption({ name: "Inn", nightly: "$99", url: "https://g" }).subtitle, "$99/night");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/sources.test.mjs`
Expected: FAIL, cannot find `stays.ts`.

- [ ] **Step 3: Write `stays.ts`**

Create `src/server/sources/stays.ts`:

```ts
import { log } from "../log";
import { pageTitle, proxiedFetch, type SourceEnv } from "./fetch";
import { CURR } from "./flights";
import type { Stay } from "./types";

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/sources.test.mjs`
Expected: all passing. If the cheapest is not `$185`, print the parsed list and check the fixture's tuples; the test's expected value should match the true cheapest tuple in the fixture, not be softened.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/server/sources/stays.ts scripts/sources.test.mjs
git commit -m "Sources: Google Hotels from the page's data blob

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Events from Ticketmaster and Luma

**Files:**
- Create: `src/server/sources/events.ts`
- Test: `scripts/sources.test.mjs` (append)
- Fixtures: `scripts/fixtures/sources/ticketmaster-search.html`, `ticketmaster-events.json`, `luma-toronto.json` (exist)

**Interfaces:**
- Consumes: Task 1.
- Produces: `type EventQuery = { city: string; query?: string; country?: string }`, `parseTicketmasterSearch(html: string, query: string): { id: string; title: string } | undefined`, `parseTicketmasterEvents(json: string): Event[]`, `parseLuma(json: string): Event[]`, `findEvents(env, q: EventQuery, now?: Date): Promise<Event[]>`, `eventOption(e: Event): { title: string; subtitle: string; bookingUrl: string }`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/sources.test.mjs`:

```js
import { parseTicketmasterSearch, parseTicketmasterEvents, parseLuma, findEvents, eventOption } from "../src/server/sources/events.ts";

test("parseTicketmasterSearch resolves a team to its artist id", () => {
  assert.deepEqual(parseTicketmasterSearch(fixture("ticketmaster-search.html"), "Toronto Raptors"), { id: "806034", title: "Toronto Raptors" });
  assert.equal(parseTicketmasterSearch("<html></html>", "Toronto Raptors"), undefined);
});

test("parseTicketmasterEvents maps title, date, venue, on-sale and flags", () => {
  const events = parseTicketmasterEvents(fixture("ticketmaster-events.json"));
  assert.ok(events.length >= 5);
  const first = events[0];
  assert.equal(first.source, "ticketmaster");
  assert.equal(first.title, "Plus Up! Accès Terrain Après-Match - Quebec");
  assert.equal(first.when, "2026-10-03T23:00:00Z");
  assert.equal(first.venue, "Centre Videotron");
  assert.equal(first.city, "Quebec, QC");
  assert.match(first.url, /^https:\/\/www\.ticketmaster\.ca\/.+\/event\//);
  assert.equal(first.onsale, "2026-09-11T14:00:00Z");
  assert.equal(first.soldOut, false);
  const spurs = events.find((e) => /Spurs/.test(e.title));
  assert.ok(spurs, "no Spurs game");
  assert.equal(spurs.city, "Toronto, ON");
});

test("parseLuma maps the city feed", () => {
  const events = parseLuma(fixture("luma-toronto.json"));
  assert.equal(events.length, 5);
  assert.equal(events[0].source, "luma");
  assert.match(events[0].title, /^Future Legends/);
  assert.equal(events[0].when, "2026-09-19T13:00:00.000Z");
  assert.equal(events[0].venue, "William Doo Auditorium");
  assert.equal(events[0].city, "Toronto, ON");
  assert.equal(events[0].url, "https://luma.com/fl0ap8aq");
});

test("findEvents with a query goes search page → events API, city matches first, soonest first", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const target = JSON.parse(init.body).url;
    calls.push(target);
    const content = /\/search\?q=/.test(target) ? fixture("ticketmaster-search.html") : fixture("ticketmaster-events.json");
    return new Response(JSON.stringify({ statusCode: 200, content }), { headers: { "content-type": "application/json" } });
  });
  const events = await findEvents(env, { city: "Toronto", query: "Toronto Raptors" }, new Date("2026-09-20T00:00:00Z"));
  assert.equal(calls[0], "https://www.ticketmaster.ca/search?q=Toronto%20Raptors");
  assert.equal(calls[1], "https://www.ticketmaster.ca/api/search/events/artist/806034?page=0&countryCodes=CA");
  assert.ok(events.length <= 10);
  assert.ok(events.every((e) => e.city === "Toronto, ON"), "an out-of-town event came first");
  for (let i = 1; i < events.length; i++) assert.ok(events[i].when >= events[i - 1].when, "not soonest first");
});

test("findEvents without a query reads Luma directly, next 30 days only", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.luma.com/discover/get-paginated-events?slug=toronto&pagination_limit=20");
    assert.equal(init.method ?? "GET", "GET");
    return new Response(fixture("luma-toronto.json"));
  });
  const events = await findEvents(env, { city: "Toronto" }, new Date("2026-09-19T00:00:00Z"));
  assert.equal(events.length, 5);
  const none = await findEvents(env, { city: "Toronto" }, new Date("2026-12-01T00:00:00Z"));
  assert.equal(none.length, 0);
});

test("eventOption is one ballot line", () => {
  const e = { title: "Toronto Raptors vs. San Antonio Spurs", when: "2026-12-17T00:30:00Z", venue: "Scotiabank Arena", city: "Toronto, ON", url: "https://t", onsale: "2026-09-17T16:00:00Z", soldOut: false, limited: true, source: "ticketmaster" };
  const o = eventOption(e, "America/Toronto");
  assert.equal(o.title, "Toronto Raptors vs. San Antonio Spurs");
  assert.equal(o.subtitle, "Wed Dec 16, 7:30 PM · Scotiabank Arena · few left");
  assert.equal(o.bookingUrl, "https://t");
  assert.equal(eventOption({ ...e, soldOut: true, limited: false }, "America/Toronto").subtitle, "Wed Dec 16, 7:30 PM · Scotiabank Arena · sold out");
  assert.equal(eventOption({ ...e, onsale: "2026-12-01T16:00:00Z", limited: false }, "America/Toronto", new Date("2026-11-01T00:00:00Z")).subtitle, "Wed Dec 16, 7:30 PM · Scotiabank Arena · on sale Dec 1");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/sources.test.mjs`
Expected: FAIL, cannot find `events.ts`.

- [ ] **Step 3: Write `events.ts`**

Create `src/server/sources/events.ts`:

```ts
import { z } from "zod";
import { log } from "../log";
import { pageTitle, proxiedFetch, type SourceEnv } from "./fetch";
import type { Event } from "./types";

const MAX_RESULTS = 10;
const DAYS_AHEAD = 30;

export type EventQuery = { city: string; query?: string; country?: string };

const tld = (country?: string) => ((country ?? "CA").toUpperCase() === "CA" ? "ca" : "com");

/**
 * Ticketmaster's search page embeds its suggestion query in `__NEXT_DATA__`
 * under a key like `topSuggestions({"keyword":"Toronto Raptors"})`; the
 * attraction's numeric id is the tail of its URL.
 */
export function parseTicketmasterSearch(html: string, query: string): { id: string; title: string } | undefined {
  const raw = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
  if (!raw) return;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const Suggestion = z.object({ title: z.string(), url: z.string(), count: z.number().optional(), suggestionType: z.string().optional() });
  const found: z.infer<typeof Suggestion>[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key.startsWith("topSuggestions(")) {
        const results = (value as { data?: { results?: unknown[] } })?.data?.results ?? [];
        for (const r of results) {
          const s = Suggestion.safeParse(r);
          if (s.success) found.push(s.data);
        }
      } else walk(value);
    }
  };
  walk(data);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const candidates = found.filter((s) => (s.suggestionType ?? "ATTRACTION") === "ATTRACTION" && (s.count ?? 1) > 0 && /\/artist\/\d+/.test(s.url));
  const best = candidates.find((s) => norm(s.title) === norm(query)) ?? candidates[0];
  if (!best) return;
  return { id: /\/artist\/(\d+)/.exec(best.url)![1], title: best.title };
}

const TmEvents = z.object({
  events: z.array(
    z.object({
      title: z.string(),
      url: z.string().optional(),
      dates: z.object({ startDate: z.string().optional(), onsaleDate: z.string().optional() }).optional(),
      venue: z.object({ name: z.string().optional(), city: z.string().optional(), state: z.string().optional() }).nullish(),
      soldOut: z.boolean().optional(),
      limitedAvailability: z.boolean().optional(),
      cancelled: z.boolean().optional(),
    }),
  ),
});

export function parseTicketmasterEvents(json: string): Event[] {
  let parsed: z.infer<typeof TmEvents>;
  try {
    parsed = TmEvents.parse(JSON.parse(json));
  } catch {
    return [];
  }
  return parsed.events
    .filter((e) => e.dates?.startDate && e.url && !e.cancelled)
    .map((e) => ({
      title: e.title,
      when: e.dates!.startDate!,
      ...(e.venue?.name ? { venue: e.venue.name } : {}),
      ...(e.venue?.city ? { city: [e.venue.city, e.venue.state].filter(Boolean).join(", ") } : {}),
      url: e.url!,
      ...(e.dates?.onsaleDate ? { onsale: e.dates.onsaleDate } : {}),
      soldOut: e.soldOut === true,
      limited: e.limitedAvailability === true,
      source: "ticketmaster" as const,
    }));
}

const Luma = z.object({
  entries: z.array(
    z.object({
      event: z.object({
        name: z.string(),
        start_at: z.string(),
        url: z.string(),
        geo_address_info: z.object({ address: z.string().nullish(), city_state: z.string().nullish() }).nullish(),
      }),
    }),
  ),
});

export function parseLuma(json: string): Event[] {
  let parsed: z.infer<typeof Luma>;
  try {
    parsed = Luma.parse(JSON.parse(json));
  } catch {
    return [];
  }
  return parsed.entries.map(({ event }) => ({
    title: event.name,
    when: event.start_at,
    ...(event.geo_address_info?.address ? { venue: event.geo_address_info.address } : {}),
    ...(event.geo_address_info?.city_state ? { city: event.geo_address_info.city_state } : {}),
    url: `https://luma.com/${event.url}`,
    source: "luma" as const,
  }));
}

/**
 * With a query (a team, an artist, a show): Ticketmaster, the city's events
 * first. Without: Luma's feed for the city. Both soonest first, at most ten.
 */
export async function findEvents(env: SourceEnv, q: EventQuery, now = new Date()): Promise<Event[]> {
  const horizon = new Date(now.getTime() + DAYS_AHEAD * 86_400_000).toISOString();
  const cityKey = q.city.toLowerCase().replace(/[^a-z]/g, "");
  let events: Event[];
  if (q.query) {
    const host = `https://www.ticketmaster.${tld(q.country)}`;
    const search = await proxiedFetch(env, `${host}/search?q=${encodeURIComponent(q.query)}`);
    const artist = parseTicketmasterSearch(search.content, q.query);
    if (!artist) {
      log("warn", "source", "empty", { source: "ticketmaster-search", status: search.status, title: pageTitle(search.content) });
      return [];
    }
    const cc = (q.country ?? "CA").toUpperCase();
    const list = await proxiedFetch(env, `${host}/api/search/events/artist/${artist.id}?page=0&countryCodes=${cc}`);
    events = parseTicketmasterEvents(list.content).filter((e) => e.when >= now.toISOString());
    const inCity = (e: Event) => (e.city ?? "").toLowerCase().replace(/[^a-z]/g, "").startsWith(cityKey);
    events = [...events.filter(inCity), ...events.filter((e) => !inCity(e))];
    if (!events.length) log("warn", "source", "empty", { source: "ticketmaster-events", status: list.status, artist: artist.id });
  } else {
    const page = await proxiedFetch(env, `https://api.luma.com/discover/get-paginated-events?slug=${cityKey}&pagination_limit=20`, { proxies: false });
    events = parseLuma(page.content).filter((e) => e.when >= now.toISOString() && e.when <= horizon);
    if (!events.length) log("warn", "source", "empty", { source: "luma", status: page.status, city: cityKey });
  }
  // Within each group (city first), soonest first.
  const stable = events.map((e, i) => ({ e, i }));
  const inCity = (e: Event) => (e.city ?? "").toLowerCase().replace(/[^a-z]/g, "").startsWith(cityKey);
  stable.sort((a, b) => Number(inCity(b.e)) - Number(inCity(a.e)) || a.e.when.localeCompare(b.e.when) || a.i - b.i);
  return stable.map((s) => s.e).slice(0, MAX_RESULTS);
}

const fmtWhen = (iso: string, tz: string) =>
  new Date(iso).toLocaleString("en-CA", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/\.,? /g, " ").replace(/\s+/g, " ").replace(/ (\d)/, ", $1").replace(/ a\.m\./, " AM").replace(/ p\.m\./, " PM");

export function eventOption(e: Event, tz = "America/Toronto", now = new Date()): { title: string; subtitle: string; bookingUrl: string } {
  const when = new Date(e.when).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const status = e.soldOut
    ? "sold out"
    : e.onsale && new Date(e.onsale) > now
      ? `on sale ${new Date(e.onsale).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric" })}`
      : e.limited
        ? "few left"
        : e.source === "ticketmaster"
          ? "on sale now"
          : "free to RSVP";
  return { title: e.title, subtitle: [when, e.venue, status].filter(Boolean).join(" · "), bookingUrl: e.url };
}
void fmtWhen;
```

Then delete the unused `fmtWhen` helper and the `void fmtWhen;` line: the `en-US` locale in `eventOption` already yields "Wed, Dec 16, 7:30 PM". Change the test's expected subtitles to match the real `toLocaleString("en-US", …)` output for those instants on this machine; run the following to see it and paste exactly what it prints into the test:

```bash
node -e 'console.log(new Date("2026-12-17T00:30:00Z").toLocaleString("en-US",{timeZone:"America/Toronto",weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}))'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/sources.test.mjs`
Expected: all passing.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/server/sources/events.ts scripts/sources.test.mjs
git commit -m "Sources: events from Ticketmaster and Luma, the city's first

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Flight status, order status, and the watch diffs

**Files:**
- Create: `src/server/sources/flight-status.ts`
- Create: `src/server/sources/order-status.ts`
- Create: `src/server/sources/watch.ts`
- Test: `scripts/sources.test.mjs` (append), create `scripts/watch.test.mjs`
- Fixture: `scripts/fixtures/sources/flightaware.html` (exists)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `icaoIdent(ident: string): string`, `parseFlightStatus(html: string, url: string): FlightStatus | undefined`, `flightStatus(env, ident: string): Promise<FlightStatus | undefined>`, `describeFlight(s: FlightStatus): string`, `fmtLocal(epochSeconds: number, tz?: string): string`.
  - `parseOrderStatus(html: string): OrderStatus`, `orderStatus(env, url: string): Promise<OrderStatus>`.
  - `diffFlight(prev: FlightStatus | undefined, next: FlightStatus): string[]`, `diffOrder(prev: OrderStatus | undefined, next: OrderStatus, shop: string): string[]`, `flightWatchActive(s: FlightStatus | undefined, nowMs: number): boolean`, `orderWatchActive(startedMs: number, s: OrderStatus | undefined, nowMs: number): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/sources.test.mjs`:

```js
import { icaoIdent, parseFlightStatus, flightStatus, describeFlight, fmtLocal } from "../src/server/sources/flight-status.ts";
import { parseOrderStatus } from "../src/server/sources/order-status.ts";

test("icaoIdent turns an airline code into FlightAware's ident", () => {
  assert.equal(icaoIdent("AC123"), "ACA123");
  assert.equal(icaoIdent("ac 123"), "ACA123");
  assert.equal(icaoIdent("WS1234"), "WJA1234");
  assert.equal(icaoIdent("ACA123"), "ACA123");
  assert.equal(icaoIdent("N12345"), "N12345");
});

test("parseFlightStatus reads gates, times and delay from trackpollBootstrap", () => {
  const s = parseFlightStatus(fixture("flightaware.html"), "https://www.flightaware.com/live/flight/ACA123");
  assert.ok(s);
  assert.equal(s.ident, "ACA123");
  assert.equal(s.iata, "AC123");
  assert.equal(s.status, "scheduled");
  assert.equal(s.from, "YYZ");
  assert.equal(s.to, "YVR");
  assert.equal(s.fromTz, "America/Toronto");
  assert.equal(s.gateFrom, "D22");
  assert.equal(s.terminalFrom, "1");
  assert.equal(s.gateTo, "C41");
  assert.equal(s.scheduledDeparture, 1789857000);
  assert.equal(s.estimatedDeparture, 1789857000);
  assert.equal(s.actualDeparture, undefined);
  assert.equal(s.delayMinutes, 0);
  assert.equal(s.url, "https://www.flightaware.com/live/flight/ACA123");
  assert.equal(parseFlightStatus("<html></html>", "u"), undefined);
});

test("flightStatus fetches the www page through the proxy", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(JSON.parse(init.body).url, "https://www.flightaware.com/live/flight/ACA123");
    return new Response(JSON.stringify({ statusCode: 200, content: fixture("flightaware.html") }), { headers: { "content-type": "application/json" } });
  });
  const s = await flightStatus(env, "AC123");
  assert.equal(s.gateFrom, "D22");
});

test("describeFlight is one chat line", () => {
  const base = { ident: "ACA123", iata: "AC123", status: "scheduled", from: "YYZ", to: "YVR", fromTz: "America/Toronto", toTz: "America/Vancouver", gateFrom: "D22", terminalFrom: "1", gateTo: "C41", scheduledDeparture: 1789857000, estimatedDeparture: 1789857000, scheduledArrival: 1789875000, estimatedArrival: 1789875000, delayMinutes: 0, url: "https://fa" };
  assert.equal(describeFlight(base), `AC123 YYZ→YVR: on time, departs ${fmtLocal(1789857000, "America/Toronto")} from gate D22, terminal 1`);
  assert.equal(describeFlight({ ...base, delayMinutes: 40, estimatedDeparture: 1789857000 + 2400 }), `AC123 YYZ→YVR: delayed 40 min, now departs ${fmtLocal(1789857000 + 2400, "America/Toronto")} from gate D22, terminal 1`);
  assert.equal(describeFlight({ ...base, status: "departed", actualDeparture: 1789857000, delayMinutes: 0 }), `AC123 YYZ→YVR: in the air, lands ${fmtLocal(1789875000, "America/Vancouver")} at gate C41`);
  assert.equal(describeFlight({ ...base, status: "landed", actualArrival: 1789875000 }), `AC123 landed in YVR at ${fmtLocal(1789875000, "America/Vancouver")}, gate C41`);
  assert.equal(describeFlight({ ...base, status: "cancelled" }), "AC123 YYZ→YVR is cancelled");
});

test("parseOrderStatus reads a Shopify order page's text", () => {
  assert.deepEqual(parseOrderStatus("<html><body><h2>Thank you, Maya!</h2><p>Your order is confirmed</p></body></html>"), { fulfilled: false, delivered: false });
  const shipped = parseOrderStatus(`<html><body><h2>Your order is on its way</h2>
    <p>Tracking number: <a href="https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=7023210000000001">7023210000000001</a></p>
    <p>Canada Post · Estimated delivery: Tuesday, September 22</p></body></html>`);
  assert.deepEqual(shipped, { fulfilled: true, delivered: false, carrier: "Canada Post", tracking: "7023210000000001", trackingUrl: "https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=7023210000000001", eta: "Tuesday, September 22" });
  assert.equal(parseOrderStatus("<html><body><h2>Delivered</h2><p>Your package was delivered.</p></body></html>").delivered, true);
});
```

Create `scripts/watch.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { diffFlight, diffOrder, flightWatchActive, orderWatchActive } from "../src/server/sources/watch.ts";
import { fmtLocal } from "../src/server/sources/flight-status.ts";

const T0 = 1789857000;
const base = { ident: "ACA123", iata: "AC123", status: "scheduled", from: "YYZ", to: "YVR", fromTz: "America/Toronto", toTz: "America/Vancouver", gateFrom: "D22", terminalFrom: "1", gateTo: "C41", scheduledDeparture: T0, estimatedDeparture: T0, scheduledArrival: T0 + 18000, estimatedArrival: T0 + 18000, delayMinutes: 0, url: "https://fa" };

test("diffFlight: nothing for no change or a small delay", () => {
  assert.deepEqual(diffFlight(base, base), []);
  assert.deepEqual(diffFlight(base, { ...base, delayMinutes: 10, estimatedDeparture: T0 + 600 }), []);
});

test("diffFlight: a delay of 15 minutes or more, then only when it moves by 15 more", () => {
  const late = { ...base, delayMinutes: 20, estimatedDeparture: T0 + 1200 };
  assert.deepEqual(diffFlight(base, late), [`AC123 is delayed 20 min, now departs ${fmtLocal(T0 + 1200, "America/Toronto")}`]);
  assert.deepEqual(diffFlight(late, { ...late, delayMinutes: 25, estimatedDeparture: T0 + 1500 }), []);
  assert.deepEqual(diffFlight(late, { ...late, delayMinutes: 40, estimatedDeparture: T0 + 2400 }), [`AC123 is delayed 40 min, now departs ${fmtLocal(T0 + 2400, "America/Toronto")}`]);
  assert.deepEqual(diffFlight(late, { ...late, delayMinutes: 0, estimatedDeparture: T0 }), ["AC123 is back on time"]);
});

test("diffFlight: gate and terminal changes", () => {
  assert.deepEqual(diffFlight(base, { ...base, gateFrom: "D30" }), ["AC123 now leaves from gate D30, terminal 1"]);
  assert.deepEqual(diffFlight(base, { ...base, gateTo: "C50" }), ["AC123 now arrives at gate C50"]);
});

test("diffFlight: departed, landed, cancelled", () => {
  assert.deepEqual(diffFlight(base, { ...base, status: "departed", actualDeparture: T0 + 300 }), [`AC123 is in the air, lands ${fmtLocal(T0 + 18000, "America/Vancouver")} at gate C41`]);
  assert.deepEqual(diffFlight({ ...base, status: "departed" }, { ...base, status: "landed", actualArrival: T0 + 17900 }), [`AC123 landed in YVR at ${fmtLocal(T0 + 17900, "America/Vancouver")}, gate C41`]);
  assert.deepEqual(diffFlight(base, { ...base, status: "cancelled" }), ["AC123 is cancelled"]);
  // First sight of a flight that is already flying still says so once.
  assert.equal(diffFlight(undefined, { ...base, status: "departed" }).length, 1);
  assert.deepEqual(diffFlight(undefined, base), []);
});

test("diffOrder: shipped once, delivered once", () => {
  const none = { fulfilled: false, delivered: false };
  const shipped = { fulfilled: true, delivered: false, carrier: "Canada Post", tracking: "7023", trackingUrl: "https://cp/7023", eta: "Tuesday" };
  assert.deepEqual(diffOrder(undefined, none, "partycity.com"), []);
  assert.deepEqual(diffOrder(none, shipped, "partycity.com"), ["partycity.com shipped: Canada Post 7023, arriving Tuesday. https://cp/7023"]);
  assert.deepEqual(diffOrder(shipped, shipped, "partycity.com"), []);
  assert.deepEqual(diffOrder(none, { fulfilled: true, delivered: false }, "partycity.com"), ["partycity.com shipped"]);
  assert.deepEqual(diffOrder(shipped, { ...shipped, delivered: true }, "partycity.com"), ["partycity.com delivered"]);
});

test("watches are active in a window", () => {
  const ms = T0 * 1000;
  assert.equal(flightWatchActive(base, ms - 40 * 3600_000), false);
  assert.equal(flightWatchActive(base, ms - 30 * 3600_000), true);
  assert.equal(flightWatchActive(base, ms + 18000_000 + 5 * 3600_000), true);
  assert.equal(flightWatchActive(base, ms + 18000_000 + 7 * 3600_000), false);
  assert.equal(flightWatchActive({ ...base, status: "landed" }, ms), false);
  assert.equal(flightWatchActive({ ...base, status: "cancelled" }, ms), false);
  assert.equal(flightWatchActive(undefined, ms), true);
  assert.equal(orderWatchActive(ms, undefined, ms + 86_400_000), true);
  assert.equal(orderWatchActive(ms, { fulfilled: true, delivered: true }, ms + 86_400_000), false);
  assert.equal(orderWatchActive(ms, undefined, ms + 15 * 86_400_000), false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/sources.test.mjs scripts/watch.test.mjs`
Expected: FAIL, cannot find the three new modules.

- [ ] **Step 3: Write `flight-status.ts`**

Create `src/server/sources/flight-status.ts`:

```ts
import { log } from "../log";
import { pageTitle, proxiedFetch, type SourceEnv } from "./fetch";
import type { FlightStatus } from "./types";

/** IATA airline code → ICAO, for the carriers a Canadian demo meets. Unknown two-letter codes pass through. */
const ICAO: Record<string, string> = { AC: "ACA", WS: "WJA", PD: "POE", F8: "FLE", TS: "TSC", UA: "UAL", AA: "AAL", DL: "DAL", WN: "SWA", B6: "JBU", AS: "ASA", BA: "BAW", LH: "DLH", AF: "AFR", KL: "KLM", EK: "UAE", QR: "QTR" };
const IATA = Object.fromEntries(Object.entries(ICAO).map(([iata, icao]) => [icao, iata]));

export function icaoIdent(ident: string): string {
  const s = ident.replace(/\s+/g, "").toUpperCase();
  const m = /^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(s);
  if (m && ICAO[m[1]]) return `${ICAO[m[1]]}${m[2]}`;
  return s;
}

export const flightUrl = (ident: string) => `https://www.flightaware.com/live/flight/${icaoIdent(ident)}`;

type Times = { scheduled?: number | null; estimated?: number | null; actual?: number | null };
type Airport = { iata?: string; icao?: string; gate?: string | null; terminal?: string | null; TZ?: string | null };
type Boot = {
  flights?: Record<string, { ident?: string; iataIdent?: string; flightStatus?: string; cancelled?: boolean; origin?: Airport; destination?: Airport; gateDepartureTimes?: Times; gateArrivalTimes?: Times; altitude?: number | null }>;
};

/** `var trackpollBootstrap = {…}` inside a script: brace-matched, since the object holds nested braces in strings too. */
function bootstrap(html: string): Boot | undefined {
  const marker = "var trackpollBootstrap = ";
  const start = html.indexOf(marker);
  if (start < 0) return;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start + marker.length; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start + marker.length, i + 1)) as Boot;
        } catch {
          return;
        }
      }
    }
  }
}

const tz = (a?: Airport) => (a?.TZ ? a.TZ.replace(/^:/, "") : undefined);

export function parseFlightStatus(html: string, url: string): FlightStatus | undefined {
  const boot = bootstrap(html);
  const flight = boot?.flights ? Object.values(boot.flights)[0] : undefined;
  if (!flight?.origin?.iata || !flight.destination?.iata || !flight.gateDepartureTimes?.scheduled || !flight.gateArrivalTimes?.scheduled) return;
  const text = (flight.flightStatus ?? "").toLowerCase();
  const dep = flight.gateDepartureTimes;
  const arr = flight.gateArrivalTimes;
  const status: FlightStatus["status"] = flight.cancelled || /cancel/.test(text)
    ? "cancelled"
    : arr.actual || /arrived|landed/.test(text)
      ? "landed"
      : dep.actual || /en route|departed|airborne|taxiing/.test(text)
        ? "departed"
        : text === "" || /scheduled|on time|delayed/.test(text)
          ? "scheduled"
          : "unknown";
  const ref = status === "departed" ? arr : dep;
  const delayMinutes = ref.estimated && ref.scheduled ? Math.max(0, Math.round((ref.estimated - ref.scheduled) / 60)) : 0;
  const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);
  return {
    ident: flight.ident ?? "",
    iata: flight.iataIdent ?? (flight.ident && IATA[flight.ident.slice(0, 3)] ? `${IATA[flight.ident.slice(0, 3)]}${flight.ident.slice(3)}` : flight.ident ?? ""),
    status,
    from: flight.origin.iata,
    to: flight.destination.iata,
    fromTz: tz(flight.origin),
    toTz: tz(flight.destination),
    gateFrom: opt(flight.origin.gate),
    terminalFrom: opt(flight.origin.terminal),
    gateTo: opt(flight.destination.gate),
    terminalTo: opt(flight.destination.terminal),
    scheduledDeparture: dep.scheduled,
    estimatedDeparture: opt(dep.estimated),
    actualDeparture: opt(dep.actual),
    scheduledArrival: arr.scheduled,
    estimatedArrival: opt(arr.estimated),
    actualArrival: opt(arr.actual),
    delayMinutes,
    url,
  };
}

export async function flightStatus(env: SourceEnv, ident: string): Promise<FlightStatus | undefined> {
  const url = flightUrl(ident);
  const page = await proxiedFetch(env, url);
  const status = parseFlightStatus(page.content, url);
  if (!status) log("warn", "source", "empty", { source: "flightaware", ident: icaoIdent(ident), status: page.status, title: pageTitle(page.content) });
  return status;
}

/** "1:55 PM" in the airport's zone. */
export function fmtLocal(epochSeconds: number, tz = "UTC"): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

const gateLine = (gate?: string, terminal?: string) => (gate ? ` from gate ${gate}${terminal ? `, terminal ${terminal}` : ""}` : terminal ? ` from terminal ${terminal}` : "");

/** One line for the chat, as `watch_flight` answers. */
export function describeFlight(s: FlightStatus): string {
  const route = `${s.iata} ${s.from}→${s.to}`;
  if (s.status === "cancelled") return `${route} is cancelled`;
  if (s.status === "landed") return `${s.iata} landed in ${s.to} at ${fmtLocal(s.actualArrival ?? s.estimatedArrival ?? s.scheduledArrival, s.toTz)}${s.gateTo ? `, gate ${s.gateTo}` : ""}`;
  if (s.status === "departed") return `${route}: in the air, lands ${fmtLocal(s.estimatedArrival ?? s.scheduledArrival, s.toTz)}${s.gateTo ? ` at gate ${s.gateTo}` : ""}`;
  const departs = fmtLocal(s.estimatedDeparture ?? s.scheduledDeparture, s.fromTz);
  return s.delayMinutes >= 15
    ? `${route}: delayed ${s.delayMinutes} min, now departs ${departs}${gateLine(s.gateFrom, s.terminalFrom)}`
    : `${route}: on time, departs ${departs}${gateLine(s.gateFrom, s.terminalFrom)}`;
}
```

- [ ] **Step 4: Write `order-status.ts`**

Create `src/server/sources/order-status.ts`:

```ts
import { proxiedFetch, type SourceEnv } from "./fetch";
import type { OrderStatus } from "./types";

const CARRIERS = ["Canada Post", "Purolator", "FedEx", "UPS", "USPS", "DHL", "Intelcom", "GLS", "Amazon"];

/**
 * A Shopify order status page says "on its way" once fulfilled and shows the
 * carrier's tracking number as a link. This is a text heuristic over that
 * page: everything past `fulfilled` is optional.
 */
export function parseOrderStatus(html: string): OrderStatus {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const delivered = /\bdelivered\b/i.test(text) && !/not (yet )?delivered|will be delivered/i.test(text);
  const fulfilled = delivered || /\b(fulfilled|shipped|on its way|out for delivery|in transit)\b/i.test(text);
  const out: OrderStatus = { fulfilled, delivered };
  if (!fulfilled) return out;
  const carrier = CARRIERS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
  if (carrier) out.carrier = carrier;
  const tracking = /tracking (?:number|#|no\.?)[:\s]+([A-Z0-9]{8,35})/i.exec(text)?.[1];
  if (tracking) out.tracking = tracking;
  const link = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).find((href) => /track/i.test(href) && (!tracking || href.includes(tracking)));
  if (link) out.trackingUrl = link.replace(/&amp;/g, "&");
  const eta = /(?:estimated delivery|arriving|expected)[:\s]+([A-Z][a-z]+(?:day)?,? [A-Z][a-z]+ \d{1,2}(?:,? \d{4})?|[A-Z][a-z]+ \d{1,2}(?: – [A-Z][a-z]+ \d{1,2})?)/.exec(text)?.[1];
  if (eta) out.eta = eta;
  return out;
}

/** The store's own page needs no proxy. */
export async function orderStatus(env: SourceEnv, url: string): Promise<OrderStatus> {
  const page = await proxiedFetch(env, url, { proxies: false });
  return parseOrderStatus(page.content);
}
```

- [ ] **Step 5: Write `watch.ts`**

Create `src/server/sources/watch.ts`:

```ts
import { fmtLocal } from "./flight-status";
import type { FlightStatus, OrderStatus } from "./types";

const DELAY_STEP = 15;
const BEFORE_MS = 36 * 3600_000;
const AFTER_MS = 6 * 3600_000;
const ORDER_MS = 14 * 86_400_000;

/**
 * What changed, as chat lines. Nothing for small movements: a delay is worth a
 * line at 15 minutes and again each time it moves 15 more, so a flight that
 * creeps does not fill the chat.
 */
export function diffFlight(prev: FlightStatus | undefined, next: FlightStatus): string[] {
  const lines: string[] = [];
  const was = prev?.status ?? "scheduled";
  if (next.status === "cancelled" && was !== "cancelled") return [`${next.iata} is cancelled`];
  if (next.status === "landed" && was !== "landed") {
    return [`${next.iata} landed in ${next.to} at ${fmtLocal(next.actualArrival ?? next.estimatedArrival ?? next.scheduledArrival, next.toTz)}${next.gateTo ? `, gate ${next.gateTo}` : ""}`];
  }
  if (next.status === "departed" && was !== "departed") {
    lines.push(`${next.iata} is in the air, lands ${fmtLocal(next.estimatedArrival ?? next.scheduledArrival, next.toTz)}${next.gateTo ? ` at gate ${next.gateTo}` : ""}`);
  }
  if (next.status === "scheduled" && prev) {
    const before = prev.delayMinutes >= DELAY_STEP ? prev.delayMinutes : 0;
    const now = next.delayMinutes >= DELAY_STEP ? next.delayMinutes : 0;
    if (now && Math.abs(now - before) >= DELAY_STEP) lines.push(`${next.iata} is delayed ${now} min, now departs ${fmtLocal(next.estimatedDeparture ?? next.scheduledDeparture, next.fromTz)}`);
    else if (!now && before) lines.push(`${next.iata} is back on time`);
    if (next.gateFrom && (next.gateFrom !== prev.gateFrom || next.terminalFrom !== prev.terminalFrom)) {
      lines.push(`${next.iata} now leaves from gate ${next.gateFrom}${next.terminalFrom ? `, terminal ${next.terminalFrom}` : ""}`);
    }
  }
  if (prev && next.status !== "landed" && next.gateTo && next.gateTo !== prev.gateTo) lines.push(`${next.iata} now arrives at gate ${next.gateTo}`);
  return lines;
}

export function diffOrder(prev: OrderStatus | undefined, next: OrderStatus, shop: string): string[] {
  if (next.delivered && !prev?.delivered) return [`${shop} delivered`];
  if (next.fulfilled && !prev?.fulfilled) {
    const via = [next.carrier, next.tracking].filter(Boolean).join(" ");
    const eta = next.eta ? `, arriving ${next.eta}` : "";
    return [`${shop} shipped${via ? `: ${via}` : ""}${eta}${next.trackingUrl ? `. ${next.trackingUrl}` : ""}`];
  }
  return [];
}

/** Worth checking: from 36 hours before departure until landed, cancelled, or 6 hours past scheduled arrival. */
export function flightWatchActive(s: FlightStatus | undefined, nowMs: number): boolean {
  if (!s) return true; // never read yet: find out
  if (s.status === "landed" || s.status === "cancelled") return false;
  return nowMs >= s.scheduledDeparture * 1000 - BEFORE_MS && nowMs <= s.scheduledArrival * 1000 + AFTER_MS;
}

export function orderWatchActive(startedMs: number, s: OrderStatus | undefined, nowMs: number): boolean {
  if (s?.delivered) return false;
  return nowMs - startedMs <= ORDER_MS;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test scripts/sources.test.mjs scripts/watch.test.mjs`
Expected: all passing. If `describeFlight`'s expected string differs only in the `fmtLocal` rendering, the test already computes it with `fmtLocal`, so a mismatch is a real wording bug: fix the implementation.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/server/sources/flight-status.ts src/server/sources/order-status.ts src/server/sources/watch.ts scripts/sources.test.mjs scripts/watch.test.mjs
git commit -m "Sources: FlightAware status, Shopify order status, and what a change is worth saying

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The itinerary in state, its ticket, and the card preview

**Files:**
- Modify: `src/types.ts` (after `PlanOption`, and inside `PlanState` before `version`)
- Modify: `src/server/card.ts` (append after `matchTicket`)
- Modify: `src/server/index.ts` (the `tickets` map in `/api/dev/card`, around line 262-296, and the route comment near line 197)
- Test: `scripts/smoke.mjs` (append a card render check)

**Interfaces:**
- Produces: `ItineraryItem` (below), `PlanState.itinerary?: ItineraryItem[]`, `itineraryTicket(items: ItineraryItem[], title: string): Ticket`, `ITEM_EMOJI: Record<ItineraryItem["kind"], string>`.

- [ ] **Step 1: Add the type**

In `src/types.ts`, after the `PlanOption` type, add:

```ts
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
```

In `PlanState`, before `version`, add:

```ts
  /** The trip so far, one entry per settled segment. Display names only. */
  itinerary?: ItineraryItem[];
```

And in `EMPTY_PLAN`, after `going: [],`, add `itinerary: [],`.

- [ ] **Step 2: Add the ticket**

In `src/server/card.ts`, change the import from `../types` to include `ITEM_EMOJI` and `type ItineraryItem`, then append after `matchTicket`:

```ts
const ITEM_STATUS: Record<ItineraryItem["status"], string> = { handoff: "yours to finish", confirmed: "booked", watching: "watching", done: "done" };

/**
 * The trip so far. Cream while anyone still has something to finish or the
 * agent is still watching; green once every item is booked or done.
 */
export function itineraryTicket(items: ItineraryItem[], title: string): Ticket {
  const open = items.some((i) => i.status === "handoff" || i.status === "watching");
  const settled = items.filter((i) => i.status === "confirmed" || i.status === "done").length;
  return {
    tone: open ? "open" : "done",
    metaLeft: "Itinerary",
    metaRight: `${settled}/${items.length} set`,
    title: title || "The trip",
    rows: items.slice(0, 4).map((i) => ({
      lead: ITEM_EMOJI[i.kind],
      text: i.title,
      tail: i.lastUpdate?.slice(0, 24) ?? ITEM_STATUS[i.status],
      dim: i.status === "done",
    })),
    stub: { big: String(items.length), label: items.length === 1 ? "Stop" : "Stops" },
  };
}
```

- [ ] **Step 3: Add the preview**

In `src/server/index.ts`, import `itineraryTicket` from `./card` (extend the existing import line), and add to the `tickets` map in `/api/dev/card`, after `invoice:`:

```ts
      // state=open: a flight to book and an order on its way · done: everything landed
      itinerary: itineraryTicket(
        [
          { id: "i1", kind: "flight", title: "Flair YYZ→YVR Oct 10", status: done ? "done" : "confirmed", note: "F8 227", lastUpdate: done ? "landed 4:01 PM" : undefined },
          { id: "i2", kind: "stay", title: "JW Marriott Parq", status: done ? "confirmed" : "handoff", price: "$277/night" },
          { id: "i3", kind: "event", title: "Raptors vs Spurs Dec 17", status: "confirmed" },
          { id: "i4", kind: "order", title: "partycity.com", status: done ? "done" : "watching", lastUpdate: done ? "delivered" : "shipped, arriving Tue" },
        ],
        "Vancouver weekend",
      ),
```

Update the route comment `GET /api/dev/card?kind=plan|cart|list|venue|rsvp|match|invoice&state=open|done` to include `itinerary`.

- [ ] **Step 4: Add the smoke check**

In `scripts/smoke.mjs`, find the check named `every ticket design renders` (search for that string) and add `"itinerary"` to the list of kinds it loops over. If it loops over an array literal of kinds, append the string; if it derives kinds elsewhere, add a sibling check:

```js
await check("the itinerary ticket renders in both states", async () => {
  for (const state of ["open", "done"]) {
    const res = await get(`/api/dev/card?kind=itinerary&state=${state}`);
    expect(res.headers.get("content-type") === "image/png", `itinerary ${state}: ${res.status}`);
  }
});
```

- [ ] **Step 5: Typecheck, run the dev server, smoke**

Run: `npm run typecheck` (expected clean), then in the background `npm run dev` (port 5174; leave it running for the rest of the plan), then:

```bash
SMOKE_BASE=http://127.0.0.1:5174 npm run smoke 2>&1 | grep -E "itinerary|ticket design|FAILED|passed"
open 'http://localhost:5174/api/dev/card?kind=itinerary&state=open'
```

Expected: the itinerary checks PASS; the PNG shows four rows with emoji leads and a "4 Stops" stub. Look at it.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/server/card.ts src/server/index.ts scripts/smoke.mjs
git commit -m "Itinerary: the trip so far on the plan, and its ticket

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: The tools, the itinerary helpers, the context and the prompt

**Files:**
- Modify: `src/server/tools/index.ts` (schemas before `} as const;` and descriptions before the closing `};`)
- Modify: `src/server/agent.ts` (imports; `CREATE TABLE` block near line 217; new private helpers next to `carts()` around line 1100; new cases in `runTool` after `case "get_votes"` around line 1704; the `think()` context around line 1330; `SYSTEM` prompt)
- Test: `scripts/smoke.mjs` (append)

**Interfaces:**
- Consumes: `searchFlights`/`flightOption` (Task 2), `searchStays`/`stayOption` (Task 3), `findEvents`/`eventOption` (Task 4), `flightStatus`/`describeFlight` (Task 5), `ItineraryItem`/`ITEM_EMOJI` (Task 6), `itineraryTicket` (Task 6), `SourceError` (Task 1).
- Produces on `PlanAgent`: `private itinerary(): ItineraryItem[]`, `private saveItinerary(items: ItineraryItem[])`, `private async addItineraryItem(item: Omit<ItineraryItem, "id">): Promise<ItineraryItem>`, `private async postItinerary()`, `private itineraryContext(): string`, `private sourceFailure(err: unknown, what: string): string`. Task 8 calls `addItineraryItem` and reads `itinerary()`.

- [ ] **Step 1: Add the schemas**

In `src/server/tools/index.ts`, before `} as const;`, add:

```ts
  search_flights: z.object({
    from: z.string().min(2).max(40).describe("Airport code or city, e.g. YYZ or Toronto"),
    to: z.string().min(2).max(40),
    depart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
    return: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; omit for one way"),
    adults: z.number().int().min(1).max(9).optional(),
  }),
  search_stays: z.object({
    where: z.string().min(2).max(60).describe("City or neighbourhood, e.g. downtown Vancouver"),
    checkin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    checkout: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    adults: z.number().int().min(1).max(9).optional(),
  }),
  find_events: z.object({
    city: z.string().min(2).max(60),
    query: z.string().max(80).optional().describe("A team, artist or show for ticketed events. Omit for what's on in the city."),
    country: z.string().length(2).optional().describe("ISO country, default CA"),
  }),
  add_to_itinerary: z.object({
    optionId: z.string().optional().describe("The winning ballot option"),
    item: z
      .object({
        kind: z.enum(["flight", "stay", "event", "venue"]),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().optional(),
        price: z.string().optional(),
      })
      .optional()
      .describe("Something settled without a vote, e.g. the one flight everyone agreed on in text"),
    kind: z.enum(["flight", "stay", "event", "venue"]).optional().describe("What the winning option is, when it is a ballot option"),
  }),
  watch_flight: z.object({
    ident: z.string().min(3).max(8).describe("Airline code and number, e.g. AC123"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    itemId: z.string().optional().describe("The itinerary item this flight is, if any"),
  }),
  confirm_item: z.object({
    itemId: z.string(),
    note: z.string().max(60).optional().describe("Confirmation number or what they said"),
    price: z.string().optional().describe("What was paid, as they said it, e.g. 'CA$254'"),
    paidBy: z.string().optional().describe("Who paid, as they are shown in the transcript"),
  }),
```

And the descriptions, before the closing `};` of `descriptions`:

```ts
  search_flights:
    "Real flights from Google Flights, cheapest first, back in this turn. Each result is shaped as a ballot option with its price: put 2-4 on propose_plan. The link opens the airline's own checkout on their phone: you never book flights. Dates as YYYY-MM-DD; ask if the group has not said when.",
  search_stays:
    "Real hotels from Google Hotels for a city and dates, cheapest first, back in this turn, shaped as ballot options with nightly prices. Same rules as flights: propose, never book.",
  find_events:
    "What's on: with a query (a team, an artist, a show) it reads Ticketmaster for real dates, venues and on-sale status; without one it lists the city's upcoming events from Luma. Back in this turn, shaped as ballot options.",
  add_to_itinerary:
    "Once a vote has clearly settled (check get_votes), record the winner as a stop on the trip. It posts the itinerary ticket, gives the group the link to finish it, and clears the ballot so the next segment (the hotel, the game) can open. Say kind for a ballot option, or pass item for something agreed in text.",
  watch_flight:
    "When someone gives a flight number (AC123), read its live status now and keep watching: gate, delay, departed, landed are posted on their own from 36 hours before departure. Pass itemId when it is a stop on the itinerary.",
  confirm_item:
    "When a person says they booked or paid for an itinerary stop, mark it confirmed. With price and paidBy it also logs the expense so the invoice splits it.",
```

- [ ] **Step 2: Add the imports and the table**

In `src/server/agent.ts`, add imports:

```ts
import { ITEM_EMOJI, type ItineraryItem } from "../types";
import { itineraryTicket } from "./card";
import { SourceError } from "./sources/fetch";
import { flightOption, searchFlights } from "./sources/flights";
import { searchStays, stayOption } from "./sources/stays";
import { eventOption, findEvents } from "./sources/events";
import { describeFlight, flightStatus } from "./sources/flight-status";
```

(Merge into the existing `../types` and `./card` import lines rather than duplicating them.)

In the `CREATE TABLE` block (after the `events` table), add:

```ts
    this.sql`CREATE TABLE IF NOT EXISTS watches (item_id TEXT PRIMARY KEY, snapshot TEXT, failures INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL, checked INTEGER)`;
```

- [ ] **Step 3: Add the helpers**

Next to `private carts()` (around line 1100), add:

```ts
  private itinerary(): ItineraryItem[] {
    return this.state.itinerary ?? [];
  }

  private saveItinerary(items: ItineraryItem[]) {
    this.publish({ itinerary: items });
  }

  private async addItineraryItem(item: Omit<ItineraryItem, "id">): Promise<ItineraryItem> {
    const taken = new Set(this.itinerary().map((i) => i.id));
    let id = "";
    do id = `i${crypto.randomUUID().slice(0, 4)}`;
    while (taken.has(id));
    const added: ItineraryItem = { id, ...item };
    this.saveItinerary([...this.itinerary(), added]);
    this.note("info", "itinerary.added", { id, kind: item.kind, status: item.status, title: item.title.slice(0, 60) });
    return added;
  }

  private async postItinerary() {
    const items = this.itinerary();
    if (!items.length) return;
    await this.postTicket("itinerary", itineraryTicket(items, this.state.title));
  }

  /** One line per stop for the model. */
  private itineraryContext(): string {
    const items = this.itinerary();
    if (!items.length) return "nothing settled yet";
    return items.map((i) => `${i.id} ${ITEM_EMOJI[i.kind]} ${i.title} — ${i.status}${i.note ? ` (${i.note})` : ""}${i.price ? `, ${i.price}` : ""}${i.lastUpdate ? `; ${i.lastUpdate}` : ""}`).join(" | ");
  }

  /** A source failed: log the cause, tell the model something it can say. */
  private sourceFailure(err: unknown, what: string): string {
    this.note("warn", "source.failed", { what, ...errorFields(err) });
    if (err instanceof SourceError && err.code === "no_browserbase") return `${what} needs BROWSERBASE_API_KEY, which is not set here. Say you can't look that up right now.`;
    return `${what} did not answer this time. Say so in one line and offer to try again.`;
  }
```

- [ ] **Step 4: Add the tool cases**

In `runTool`, after the `case "get_votes"` block, add:

```ts
      case "search_flights": {
        const args = parseToolArgs("search_flights", rawArgs);
        if (args.depart < today()) return `${args.depart} is in the past. Ask for the date.`;
        try {
          const flights = await searchFlights(this.env, args);
          this.note("info", "source.flights", { from: args.from, to: args.to, depart: args.depart, found: flights.length });
          if (!flights.length) return `Google Flights showed nothing for ${args.from} to ${args.to} on ${args.depart}. Check the airports and date with the group.`;
          return JSON.stringify({ options: flights.map(flightOption), note: "Each option's bookingUrl opens Google Flights with a Book button; never say a flight is booked until someone confirms." });
        } catch (err) {
          return this.sourceFailure(err, "Google Flights");
        }
      }

      case "search_stays": {
        const args = parseToolArgs("search_stays", rawArgs);
        if (args.checkin < today() || args.checkout <= args.checkin) return "Check-in must be today or later and before check-out. Ask for the dates.";
        try {
          const stays = await searchStays(this.env, args);
          this.note("info", "source.stays", { where: args.where, checkin: args.checkin, found: stays.length });
          if (!stays.length) return `Google Hotels showed nothing in ${args.where} for those dates.`;
          return JSON.stringify({ options: stays.map(stayOption) });
        } catch (err) {
          return this.sourceFailure(err, "Google Hotels");
        }
      }

      case "find_events": {
        const args = parseToolArgs("find_events", rawArgs);
        try {
          const events = await findEvents(this.env, args);
          this.note("info", "source.events", { city: args.city, query: args.query ?? "", found: events.length });
          if (!events.length) return args.query ? `Ticketmaster has no upcoming ${args.query} dates in ${args.city}.` : `Luma lists nothing in ${args.city} for the next month.`;
          return JSON.stringify({ options: events.map((e) => eventOption(e)) });
        } catch (err) {
          return this.sourceFailure(err, args.query ? "Ticketmaster" : "Luma");
        }
      }

      case "add_to_itinerary": {
        const args = parseToolArgs("add_to_itinerary", rawArgs);
        let item: Omit<ItineraryItem, "id">;
        if (args.optionId) {
          const option = this.state.options.find((o) => o.id === args.optionId);
          if (!option) return "No such option";
          if (!args.kind) return "Say what kind of stop the winner is: flight, stay, event or venue.";
          item = { kind: args.kind, title: option.title, subtitle: option.subtitle, url: option.bookingUrl, price: option.subtitle?.match(/(?:CA|US)?\$[\d,]+(?:\.\d\d)?/)?.[0], status: option.bookingUrl ? "handoff" : "confirmed" };
        } else if (args.item) {
          item = { ...args.item, status: args.item.url ? "handoff" : "confirmed" };
        } else {
          return "Pass the winning optionId (with kind) or an item.";
        }
        const added = await this.addItineraryItem(item);
        if (args.optionId) {
          this.sql`DELETE FROM votes`;
          this.publish({ options: [], counts: {}, chosenOptionId: undefined, status: "idle", bookingNote: undefined });
          this.setMeta("ballot_id", "");
        }
        await this.postItinerary();
        const finish = added.url ? ` Finish it here: ${added.url}` : "";
        const ask = added.kind === "flight" ? " Tell me the flight number once it's booked and I'll watch it." : added.kind === "stay" || added.kind === "event" ? " Tell me once it's booked and I'll mark it." : "";
        await this.say(`${ITEM_EMOJI[added.kind]} ${added.title}${added.price ? `, ${added.price}` : ""}.${finish}${ask}`);
        return `Added ${added.id}. The ticket and the link are posted; the ballot is clear for the next segment. Itinerary: ${this.itineraryContext()}`;
      }

      case "watch_flight": {
        const args = parseToolArgs("watch_flight", rawArgs);
        let item = args.itemId ? this.itinerary().find((i) => i.id === args.itemId) : undefined;
        if (args.itemId && !item) return `No itinerary item ${args.itemId}. Itinerary: ${this.itineraryContext()}`;
        if (!item) item = await this.addItineraryItem({ kind: "flight", title: args.ident.toUpperCase(), status: "watching", watch: { flight: { ident: args.ident, date: args.date } } });
        else this.saveItinerary(this.itinerary().map((i) => (i.id === item!.id ? { ...i, status: "watching", note: args.ident.toUpperCase(), watch: { flight: { ident: args.ident, date: args.date } } } : i)));
        this.sql`INSERT OR REPLACE INTO watches (item_id, snapshot, failures, started, checked) VALUES (${item.id}, NULL, 0, ${Date.now()}, NULL)`;
        try {
          const status = await flightStatus(this.env, args.ident);
          if (!status) return `FlightAware has no ${args.ident.toUpperCase()}. Check the flight number with them.`;
          this.sql`UPDATE watches SET snapshot = ${JSON.stringify(status)}, checked = ${Date.now()} WHERE item_id = ${item.id}`;
          const line = describeFlight(status);
          this.saveItinerary(this.itinerary().map((i) => (i.id === item!.id ? { ...i, lastUpdate: line.replace(/^\S+ /, "") } : i)));
          await this.scheduleWatches();
          return `${line}. Watching it: changes are posted on their own, so say this once and stop.`;
        } catch (err) {
          await this.scheduleWatches();
          return this.sourceFailure(err, "FlightAware");
        }
      }

      case "confirm_item": {
        const args = parseToolArgs("confirm_item", rawArgs);
        const item = this.itinerary().find((i) => i.id === args.itemId);
        if (!item) return `No itinerary item ${args.itemId}. Itinerary: ${this.itineraryContext()}`;
        const paidBy = args.paidBy ? this.nameOf(args.paidBy) : undefined;
        this.saveItinerary(this.itinerary().map((i) => (i.id === item.id ? { ...i, status: i.status === "watching" ? "watching" : "confirmed", note: args.note ?? i.note, price: args.price ?? i.price, paidBy: paidBy ?? i.paidBy } : i)));
        this.note("info", "itinerary.confirmed", { id: item.id, paid: Boolean(args.price && paidBy) });
        let expense = "";
        if (args.price && paidBy) {
          expense = await this.runTool("add_expense", JSON.stringify({ who: args.paidBy, amount: args.price, what: item.title.slice(0, 60) }));
        }
        await this.postItinerary();
        return `${item.id} confirmed.${expense ? ` ${expense}` : ""} Itinerary: ${this.itineraryContext()}`;
      }
```

Add a module-level helper near the other small helpers at the top of `agent.ts` (after the `SYSTEM` constant):

```ts
/** Today as YYYY-MM-DD in Toronto, the demo's zone; date-only comparisons use it. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
```

`scheduleWatches` is defined in Task 8. To keep this task compiling on its own, add this stub now and replace it in Task 8:

```ts
  /** Replaced in Task 8: schedules checkWatches while any watch is active. */
  private async scheduleWatches() {}
```

- [ ] **Step 5: Add the context line and the prompt paragraph**

In `think()`, after the `Invoice: ${this.invoiceContext()}` line of the user message, add:

```
Itinerary: ${this.itineraryContext()}
```

In `SYSTEM`, after the bullet that starts `- To find real places, call research.`, add:

```
- For a trip or a night out, work in segments and open one ballot at a time:
  flights first, then where to stay, then what to do. search_flights,
  search_stays and find_events return real options in this turn with their
  prices: put 2-4 on propose_plan and quote the prices exactly. Their links
  open the site's own checkout, so you never book those yourself: once a vote
  settles, call add_to_itinerary, which posts the link, then move to the next
  segment. When someone says they booked it, call confirm_item (with what they
  paid and who paid, so the split is right); when they give a flight number,
  call watch_flight. Never say a flight, room or ticket is booked until a
  person says so. The Itinerary below is the trip so far.
```

- [ ] **Step 6: Smoke checks**

Append to `scripts/smoke.mjs`, before the final summary (find the line that prints `check(s) FAILED`; add a section above the run-history section):

```js
console.log("\nitinerary (no network; the sources are not called)");
const it = chat("it");
await check("add_to_itinerary takes the winner, posts one ticket, clears the ballot", async () => {
  await tool(it, "propose_plan", { title: "Vancouver weekend", options: [{ title: "Flair 1:55 PM → 4:05 PM, nonstop", subtitle: "CA$254 · 5 hr 10 min · Sat Oct 10", bookingUrl: "https://www.google.com/travel/flights?q=x" }, { title: "WestJet 10:30 PM → 12:44 AM +1, nonstop", subtitle: "CA$261 · 5 hr 14 min · Sat Oct 10", bookingUrl: "https://www.google.com/travel/flights?q=y" }] });
  const before = await dump(it);
  const out = await tool(it, "add_to_itinerary", { optionId: before.state.options[0].id, kind: "flight" });
  expect(/^Added i[0-9a-f]{4}\./.test(out), `unexpected reply: ${out}`);
  const { state } = await dump(it);
  expect(state.itinerary.length === 1, `${state.itinerary.length} items`);
  expect(state.itinerary[0].kind === "flight" && state.itinerary[0].status === "handoff" && state.itinerary[0].price === "CA$254", JSON.stringify(state.itinerary[0]));
  expect(state.options.length === 0 && state.status === "idle", "ballot not cleared");
  const text = await logs(it);
  expect(count(text, "itinerary.added") === 1, "itinerary.added fired " + count(text, "itinerary.added"));
  expect(/ticket\.out.*"kind":"itinerary"/.test(text), "no itinerary ticket posted");
  expect(/Finish it here: https:\/\/www\.google\.com/.test(text), "the deep link was not said");
});
await check("confirm_item marks it booked and logs the expense", async () => {
  const { state } = await dump(it);
  const out = await tool(it, "confirm_item", { itemId: state.itinerary[0].id, note: "F8 227", price: "CA$254", paidBy: "+15550001111" });
  expect(/confirmed\./.test(out), out);
  const after = await dump(it);
  expect(after.state.itinerary[0].status === "confirmed" && after.state.itinerary[0].note === "F8 227", JSON.stringify(after.state.itinerary[0]));
  expect(after.state.expenses.length === 1 && after.state.expenses[0].amount === "CA$254", "expense not logged");
});
await check("add_to_itinerary refuses a ballot option without a kind", async () => {
  await tool(it, "propose_plan", { title: "Vancouver weekend", options: [{ title: "A" }, { title: "B" }] });
  const { state } = await dump(it);
  const out = await tool(it, "add_to_itinerary", { optionId: state.options[0].id });
  expect(/Say what kind/.test(out), out);
});
await check("search_flights refuses a date in the past without calling anything", async () => {
  const out = await tool(it, "search_flights", { from: "YYZ", to: "YVR", depart: "2020-01-01" });
  expect(/in the past/.test(out), out);
});
if (env.BROWSERBASE_API_KEY) {
  await check("search_flights returns real options (one proxied fetch)", async () => {
    const d = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const out = JSON.parse(await tool(it, "search_flights", { from: "YYZ", to: "YVR", depart: d }));
    expect(out.options?.length >= 1, "no flights");
    expect(/CA\$\d/.test(out.options[0].subtitle), out.options[0].subtitle);
  });
} else {
  console.log("  PASS  search_flights live check  (skipped: no BROWSERBASE_API_KEY in .env)");
}
```

Note `.env` in this worktree: the smoke script reads `.env`, so run `ln -sfn .dev.vars .env` once in the worktree.

- [ ] **Step 7: Typecheck, smoke**

Run: `npm run typecheck` (clean), then with the dev server still running:

```bash
SMOKE_BASE=http://127.0.0.1:5174 npm run smoke 2>&1 | tail -20
```

Expected: the itinerary section PASSes, and the total line says all checks passed. If the live flights check fails on network, re-run once; if it still fails, look at `curl 'localhost:5174/api/dev/logs?chat=<chat>'` for `source.empty` and its title.

- [ ] **Step 8: Commit**

```bash
git add src/server/tools/index.ts src/server/agent.ts scripts/smoke.mjs
git commit -m "Trips: search flights, stays and events, vote, and add the winner to the itinerary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Watching flights and orders, and the dev routes

**Files:**
- Modify: `src/server/agent.ts` (replace the `scheduleWatches` stub; add `checkWatches`, dev methods; hook `payFinished` and `bookingFinished`)
- Modify: `src/server/booking.ts` (`PayResult.orderUrl`, set at line 188)
- Modify: `src/server/index.ts` (dev routes after `/api/dev/booked`, the `/api/dev/fire` callbacks map, route comments)
- Test: `scripts/smoke.mjs` (append)

**Interfaces:**
- Consumes: `orderStatus`, `flightStatus`, `describeFlight`, `diffFlight`, `diffOrder`, `flightWatchActive`, `orderWatchActive`, `addItineraryItem`, `itinerary()`, `saveItinerary`, `postItinerary`.
- Produces on `PlanAgent`: `async checkWatches()`, `private async scheduleWatches()`, `async devShipped(itemId: string, snap: OrderStatus)`, `async devFlightSnapshot(itemId: string, snap: FlightStatus)`, `async devWatch()`.

- [ ] **Step 1: Keep the order URL**

In `src/server/booking.ts`, add to `PayResult` after `confirmation?: string;`:

```ts
  /** The store's order status page, which later says when it ships. */
  orderUrl?: string;
```

and change the paid return at line 188 to:

```ts
      return { ...base, status: "paid", total: priced.line, confirmation: done.confirmation, orderUrl: done.url, shotId: await shoot() };
```

- [ ] **Step 2: Replace the stub and add `checkWatches`**

In `src/server/agent.ts`, add imports:

```ts
import { orderStatus } from "./sources/order-status";
import { diffFlight, diffOrder, flightWatchActive, orderWatchActive } from "./sources/watch";
import type { FlightStatus, OrderStatus } from "./sources/types";
```

Replace the `scheduleWatches` stub with:

```ts
  private static WATCH_SECONDS = 15 * 60;

  /** One timer at a time: a watch added while one is pending does not add a second. */
  private async scheduleWatches() {
    if (!this.activeWatches().length) return;
    if (this.getMeta("watch_timer") === "1") return;
    this.setMeta("watch_timer", "1");
    await this.schedule(PlanAgent.WATCH_SECONDS, "checkWatches");
  }

  private activeWatches(): { item: ItineraryItem; row: { snapshot: string | null; failures: number; started: number } }[] {
    const now = Date.now();
    const out: { item: ItineraryItem; row: { snapshot: string | null; failures: number; started: number } }[] = [];
    for (const item of this.itinerary()) {
      if (!item.watch || item.status === "done") continue;
      const row = this.sql<{ snapshot: string | null; failures: number; started: number }>`SELECT snapshot, failures, started FROM watches WHERE item_id = ${item.id}`[0];
      if (!row) continue;
      const snap = row.snapshot ? (JSON.parse(row.snapshot) as FlightStatus | OrderStatus) : undefined;
      const active = "flight" in item.watch ? flightWatchActive(snap as FlightStatus | undefined, now) : orderWatchActive(row.started, snap as OrderStatus | undefined, now);
      if (active) out.push({ item, row });
    }
    return out;
  }

  /**
   * Scheduled: read every active watch, post only what changed, reschedule
   * while anything is still worth watching. Three failures in a row on one
   * item say so once and back off to hourly for it.
   */
  async checkWatches() {
    this.setMeta("watch_timer", "");
    const watches = this.activeWatches();
    this.note("info", "watch.check", { active: watches.length });
    for (const { item, row } of watches) {
      if (row.failures >= 3 && row.failures % 4 !== 3) {
        this.sql`UPDATE watches SET failures = ${row.failures + 1} WHERE item_id = ${item.id}`;
        continue; // hourly, in 15-minute ticks
      }
      try {
        const prev = row.snapshot ? JSON.parse(row.snapshot) : undefined;
        let next: FlightStatus | OrderStatus | undefined;
        let lines: string[];
        if ("flight" in item.watch!) {
          next = await flightStatus(this.env, item.watch.flight.ident);
          if (!next) throw new Error("no status");
          lines = diffFlight(prev, next);
        } else {
          next = await orderStatus(this.env, item.watch!.order.url);
          lines = diffOrder(prev, next, item.watch!.order.shop);
        }
        await this.applyWatch(item, next, lines);
      } catch (err) {
        const failures = row.failures + 1;
        this.sql`UPDATE watches SET failures = ${failures}, checked = ${Date.now()} WHERE item_id = ${item.id}`;
        this.note("warn", "watch.failed", { id: item.id, failures, ...errorFields(err) });
        if (failures === 3) await this.say(`I can't reach ${"flight" in item.watch! ? "FlightAware" : item.watch!.order.shop} for ${item.title} right now${item.url ? `: ${item.url}` : ""}`);
      }
    }
    await this.scheduleWatches();
  }

  /** Store the snapshot, say the lines, and settle the item once it is over. */
  private async applyWatch(item: ItineraryItem, next: FlightStatus | OrderStatus, lines: string[]) {
    this.sql`UPDATE watches SET snapshot = ${JSON.stringify(next)}, failures = 0, checked = ${Date.now()} WHERE item_id = ${item.id}`;
    const over = "delivered" in next ? next.delivered : next.status === "landed" || next.status === "cancelled";
    if (lines.length || over) {
      const last = lines.at(-1);
      this.saveItinerary(this.itinerary().map((i) => (i.id === item.id ? { ...i, ...(over ? { status: "done" as const } : {}), ...(last ? { lastUpdate: last.replace(/^\S+ (is |now )?/, "").replace(/\.\s*https?:\/\/\S+$/, "") } : {}) } : i)));
    }
    for (const line of lines) {
      this.note("info", "watch.posted", { id: item.id, line: line.slice(0, 80) });
      await this.say(line);
    }
    if (over) await this.postItinerary();
  }

  /** Simulator: the store shipped (or delivered) this order. */
  async devShipped(itemId: string, snap: OrderStatus) {
    const item = this.itinerary().find((i) => i.id === itemId);
    if (!item || !item.watch || !("order" in item.watch)) return { error: `no order item ${itemId}` };
    const row = this.sql<{ snapshot: string | null }>`SELECT snapshot FROM watches WHERE item_id = ${itemId}`[0];
    const prev = row?.snapshot ? (JSON.parse(row.snapshot) as OrderStatus) : undefined;
    await this.applyWatch(item, snap, diffOrder(prev, snap, item.watch.order.shop));
    return { ok: true };
  }

  /** Simulator: FlightAware now says this about the flight. */
  async devFlightSnapshot(itemId: string, snap: FlightStatus) {
    const item = this.itinerary().find((i) => i.id === itemId);
    if (!item || !item.watch || !("flight" in item.watch)) return { error: `no flight item ${itemId}` };
    const row = this.sql<{ snapshot: string | null }>`SELECT snapshot FROM watches WHERE item_id = ${itemId}`[0];
    const prev = row?.snapshot ? (JSON.parse(row.snapshot) as FlightStatus) : undefined;
    await this.applyWatch(item, snap, diffFlight(prev, snap));
    return { ok: true };
  }

  /** Simulator: an order item to watch, without a real purchase. */
  async devSeedOrder(shop: string, url: string) {
    const item = await this.addItineraryItem({ kind: "order", title: shop, status: "watching", watch: { order: { url, shop } } });
    this.sql`INSERT OR REPLACE INTO watches (item_id, snapshot, failures, started, checked) VALUES (${item.id}, NULL, 0, ${Date.now()}, NULL)`;
    return { id: item.id };
  }
```

- [ ] **Step 3: Hook a paid cart and a booked venue**

In `payFinished`, inside `if (result.status === "paid" && cart) {` after `this.saveCarts(...)`, add:

```ts
      if (result.orderUrl) {
        const item = await this.addItineraryItem({ kind: "order", title: result.shop, status: "watching", paidBy: who, url: result.orderUrl, watch: { order: { url: result.orderUrl, shop: result.shop } } });
        this.sql`INSERT OR REPLACE INTO watches (item_id, snapshot, failures, started, checked) VALUES (${item.id}, NULL, 0, ${Date.now()}, NULL)`;
        await this.scheduleWatches();
      }
```

In `bookingFinished`, inside `if (onBallot) {` after `await this.syncCard();`, add:

```ts
      if (result.ok || handedOff) {
        await this.addItineraryItem({ kind: "venue", title: name, status: result.ok ? "confirmed" : "handoff", note: result.ok ? result.confirmation : undefined, url: option?.bookingUrl });
      }
```

- [ ] **Step 4: Dev routes**

In `src/server/index.ts`, after the `/api/dev/booked` block, add:

```ts
  if (url.pathname === "/api/dev/watch") {
    // Run the watch check now: {"chat":"demo"}
    await agent.checkWatches();
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/seedorder") {
    // An order item to watch without buying anything: {"chat":"demo","shop":"partycity.com","url":"https://…/orders/abc"}
    return Response.json(await agent.devSeedOrder(String(body.shop), String(body.url)));
  }
  if (url.pathname === "/api/dev/shipped") {
    // The store shipped: {"chat":"demo","itemId":"i1a2b","carrier":"Canada Post","tracking":"7023…","trackingUrl":"https://…","eta":"Tuesday","delivered":false}
    const b = body as unknown as { itemId: string; carrier?: string; tracking?: string; trackingUrl?: string; eta?: string; delivered?: boolean };
    return Response.json(await agent.devShipped(b.itemId, { fulfilled: true, delivered: b.delivered === true, carrier: b.carrier, tracking: b.tracking, trackingUrl: b.trackingUrl, eta: b.eta }));
  }
  if (url.pathname === "/api/dev/flight") {
    // FlightAware now says: {"chat":"demo","itemId":"i1a2b","status":{…a FlightStatus…}}
    const b = body as unknown as { itemId: string; status: FlightStatus };
    return Response.json(await agent.devFlightSnapshot(b.itemId, b.status));
  }
  if (url.pathname === "/api/dev/source") {
    // One source, no model: ?kind=flights&from=YYZ&to=YVR&depart=2026-10-10 | kind=stays&where=Vancouver&checkin=…&checkout=… | kind=events&city=Toronto&query=Raptors | kind=flight&ident=AC123 | kind=order&url=…
    const q = Object.fromEntries(url.searchParams) as Record<string, string>;
    const rows =
      q.kind === "flights" ? await searchFlights(env, { from: q.from, to: q.to, depart: q.depart, return: q.return || undefined, adults: q.adults ? Number(q.adults) : undefined })
      : q.kind === "stays" ? await searchStays(env, { where: q.where, checkin: q.checkin, checkout: q.checkout, adults: q.adults ? Number(q.adults) : undefined })
      : q.kind === "events" ? await findEvents(env, { city: q.city, query: q.query || undefined, country: q.country || undefined })
      : q.kind === "flight" ? await flightStatus(env, q.ident)
      : q.kind === "order" ? await orderStatus(env, q.url)
      : { error: "kind must be flights, stays, events, flight or order" };
    return Response.json(rows ?? null);
  }
```

Add the imports at the top of `index.ts`:

```ts
import { searchFlights } from "./sources/flights";
import { searchStays } from "./sources/stays";
import { findEvents } from "./sources/events";
import { flightStatus } from "./sources/flight-status";
import { orderStatus } from "./sources/order-status";
import type { FlightStatus } from "./sources/types";
```

Add `checkWatches: () => agent.checkWatches()` to the `callbacks` map in `/api/dev/fire`. Add the new routes to the comment block above `samplePlan`:

```
 *   GET  /api/dev/source?kind=flights|stays|events|flight|order&…   run one browse.sh recipe, no model
 *   POST /api/dev/watch     {"chat":"demo"}                          run the flight/order watch check now
 *   POST /api/dev/seedorder {"chat":"demo","shop":"…","url":"…"}     an order item to watch, without buying
 *   POST /api/dev/shipped   {"chat":"demo","itemId":"…","carrier":"…","tracking":"…","trackingUrl":"…","eta":"…"}   the store shipped
 *   POST /api/dev/flight    {"chat":"demo","itemId":"…","status":{…}}   FlightAware now says this
```

- [ ] **Step 5: Smoke checks**

Append to `scripts/smoke.mjs` after the itinerary section:

```js
console.log("\nwatching (snapshots injected; nothing fetched)");
const w = chat("watch");
await check("a shipped order is said once, with the tracking link, then delivered once", async () => {
  const { id } = await (await post("/api/dev/seedorder", { chat: w, shop: "partycity.com", url: "https://partycity.com/orders/abc" })).json();
  await post("/api/dev/shipped", { chat: w, itemId: id, carrier: "Canada Post", tracking: "7023210000000001", trackingUrl: "https://www.canadapost-postescanada.ca/track?x=7023210000000001", eta: "Tuesday" });
  await post("/api/dev/shipped", { chat: w, itemId: id, carrier: "Canada Post", tracking: "7023210000000001", trackingUrl: "https://www.canadapost-postescanada.ca/track?x=7023210000000001", eta: "Tuesday" });
  let text = await logs(w);
  expect(count(text, "watch.posted") === 1, `watch.posted fired ${count(text, "watch.posted")} times`);
  expect(/partycity\.com shipped: Canada Post 7023210000000001, arriving Tuesday\. https:/.test(text), "shipped line wrong");
  let { state } = await dump(w);
  expect(state.itinerary[0].status === "watching" && /^shipped/.test(state.itinerary[0].lastUpdate ?? ""), JSON.stringify(state.itinerary[0]));
  await post("/api/dev/shipped", { chat: w, itemId: id, delivered: true });
  text = await logs(w);
  expect(count(text, "watch.posted") === 2, "delivered not posted once");
  ({ state } = await dump(w));
  expect(state.itinerary[0].status === "done", "item not done after delivery");
  expect(count(text, '"kind":"itinerary"') >= 1, "no itinerary ticket after delivery");
});
await check("a flight delay and a gate change are said; a 10 minute creep is not", async () => {
  await tool(w, "add_to_itinerary", { item: { kind: "flight", title: "AC123 YYZ→YVR Oct 10", url: "https://www.google.com/travel/flights?q=z" } });
  const { state } = await dump(w);
  const item = state.itinerary.find((i) => i.kind === "flight");
  // watch_flight would fetch; seed the watch row through the same path the tool uses, with a snapshot injected instead.
  const T0 = Math.floor(Date.now() / 1000) + 3600;
  const base = { ident: "ACA123", iata: "AC123", status: "scheduled", from: "YYZ", to: "YVR", fromTz: "America/Toronto", toTz: "America/Vancouver", gateFrom: "D22", terminalFrom: "1", gateTo: "C41", scheduledDeparture: T0, estimatedDeparture: T0, scheduledArrival: T0 + 18000, estimatedArrival: T0 + 18000, delayMinutes: 0, url: "https://fa" };
  await post("/api/dev/seedflight", { chat: w, itemId: item.id, ident: "AC123" });
  await post("/api/dev/flight", { chat: w, itemId: item.id, status: base });
  await post("/api/dev/flight", { chat: w, itemId: item.id, status: { ...base, delayMinutes: 10, estimatedDeparture: T0 + 600 } });
  await post("/api/dev/flight", { chat: w, itemId: item.id, status: { ...base, delayMinutes: 30, estimatedDeparture: T0 + 1800, gateFrom: "D30" } });
  const text = await logs(w);
  const posted = text.split("\n").filter((l) => l.includes("watch.posted") && l.includes(item.id));
  expect(posted.length === 2, `${posted.length} lines posted for the flight`);
  expect(/delayed 30 min/.test(text) && /gate D30, terminal 1/.test(text), "delay or gate line missing");
});
```

This needs one more dev route, `/api/dev/seedflight`, which turns an existing item into a flight watch without fetching. Add to `agent.ts`:

```ts
  /** Simulator: watch this item as a flight without reading FlightAware. */
  async devSeedFlight(itemId: string, ident: string) {
    const item = this.itinerary().find((i) => i.id === itemId);
    if (!item) return { error: `no item ${itemId}` };
    this.saveItinerary(this.itinerary().map((i) => (i.id === itemId ? { ...i, status: "watching" as const, note: ident.toUpperCase(), watch: { flight: { ident } } } : i)));
    this.sql`INSERT OR REPLACE INTO watches (item_id, snapshot, failures, started, checked) VALUES (${itemId}, NULL, 0, ${Date.now()}, NULL)`;
    return { ok: true };
  }
```

and to `index.ts` next to the other dev routes:

```ts
  if (url.pathname === "/api/dev/seedflight") {
    // Watch an itinerary item as a flight without reading FlightAware: {"chat":"demo","itemId":"…","ident":"AC123"}
    return Response.json(await agent.devSeedFlight(String(body.itemId), String(body.ident)));
  }
```

- [ ] **Step 6: Typecheck, smoke, and one real check**

Run: `npm run typecheck` (clean), then:

```bash
SMOKE_BASE=http://127.0.0.1:5174 npm run smoke 2>&1 | tail -25
curl -s 'localhost:5174/api/dev/source?kind=flight&ident=AC123' | head -c 400
curl -s 'localhost:5174/api/dev/source?kind=events&city=Toronto&query=Toronto%20Raptors' | head -c 400
```

Expected: all smoke checks pass; the flight status JSON shows YYZ→YVR with gates; the events list starts with Toronto games.

- [ ] **Step 7: Commit**

```bash
git add src/server/agent.ts src/server/booking.ts src/server/index.ts scripts/smoke.mjs
git commit -m "Watch the flight and the parcel: delays, gates, landed, shipped, delivered, said once each

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: README, a model-driven run, and the final check

**Files:**
- Modify: `README.md` (new section after "Booking and availability — the browser pilot", before "LLM usage sources"; update the `/api/dev/*` listing in "Drive it without a phone")

- [ ] **Step 1: Write the README section**

Insert before `### LLM usage sources`:

````markdown
### Trips — flights, stays, events, and what happens after

The same chat plans a weekend away. Three tools read real options over
Browserbase Fetch (residential proxies, no browser) using recipes from the
[browse.sh](https://browse.sh) skill catalog, and return them in the same turn,
shaped as ballot options:

| Tool | Source | What comes back |
|---|---|---|
| `search_flights` | Google Flights (`/travel/flights?q=…`, server-rendered) | airline, times, stops, duration, price, a link with a Book button |
| `search_stays` | Google Hotels (`/travel/search`, the page's data blob) | hotel, nightly price, rating, reviews, a link to its rates |
| `find_events` | Ticketmaster's internal artist-events API, or Luma's city feed | title, date, venue, on-sale window, sold-out flags, a link |

The group votes with tapbacks as always. Once a vote settles the model calls
`add_to_itinerary`: the winner becomes a stop on the **itinerary** (a list on
the plan), the itinerary ticket is posted, the chat gets the link to finish the
booking themselves, and the ballot clears for the next segment. The agent never
books or pays for flights, rooms or tickets: those links open the site's own
checkout. `confirm_item` marks a stop booked when a person says so, and logs
what they paid so the invoice splits it. A venue booked by the pilot and an
order paid through a cart appear on the same itinerary.

**Watching.** `watch_flight AC123` reads FlightAware now and every 15 minutes
from 36 hours before departure until it lands, posting only changes: a delay of
15 minutes or more (and each further 15), a gate or terminal change, departed,
landed, cancelled. A paid order is watched through the store's order status
page until it is delivered: "shipped" with the carrier and tracking link, then
"delivered". Each is said once, as a text line.

```sh
curl 'localhost:5173/api/dev/source?kind=flights&from=YYZ&to=YVR&depart=2026-10-10'   # one recipe, no model
curl 'localhost:5173/api/dev/source?kind=events&city=Toronto&query=Toronto%20Raptors'
curl 'localhost:5173/api/dev/source?kind=flight&ident=AC123'
curl -X POST localhost:5173/api/dev/watch -H 'content-type: application/json' -d '{"chat":"demo"}'   # check now
curl -X POST localhost:5173/api/dev/shipped -H 'content-type: application/json' \
  -d '{"chat":"demo","itemId":"i1a2b","carrier":"Canada Post","tracking":"7023…","trackingUrl":"https://…","eta":"Tuesday"}'   # demo a delivery
open 'http://localhost:5173/api/dev/card?kind=itinerary&state=open'
```

Only recipes that work from this account are wired: Browserbase's "verified"
stealth mode is Enterprise-only and proxied browser sessions are not on the free
plan, which rules out Kayak, Skyscanner, Booking.com, Airbnb, Expedia, OpenTable
and every parcel carrier's own page. The parsers are pinned by fixtures in
`scripts/fixtures/sources/`; when Google changes its markup, `source.empty` in
the run viewer names the page that came back.
````

Add these lines to the `/api/dev/*` listing under "Drive it without a phone":

```sh
curl 'localhost:5173/api/dev/source?kind=flights&from=YYZ&to=YVR&depart=2026-10-10'   # one browse.sh recipe, no model
```

- [ ] **Step 2: One model-driven turn**

With the dev server (5174) and the Claude proxy (`npm run llm`, port 11435, already running from the main checkout) up:

```bash
curl -X POST localhost:5174/api/dev/message -H 'content-type: application/json' \
  -d '{"chat":"trip1","from":"+15550001111","text":"weekend in vancouver oct 10 to 12, 4 of us from toronto. find flights"}'
sleep 20; curl -s 'localhost:5174/api/dev/logs?chat=trip1' | grep -E "source\.|tool|message.out|dry\." | cut -c1-200
```

Expected: a `source.flights` line with `found` above 0, a `propose_plan` tool call with 2 to 4 options carrying `CA$` prices, and a `dry.card`. If the model narrates instead of calling `search_flights`, tighten its description (Task 7 Step 1) and retry; do not add a second message to the prompt.

Then vote and settle:

```bash
curl -X POST localhost:5174/api/dev/react -H 'content-type: application/json' -d '{"chat":"trip1","from":"+15550001111","reaction":"love"}'
curl -X POST localhost:5174/api/dev/message -H 'content-type: application/json' -d '{"chat":"trip1","from":"+15550001111","text":"go with the first one"}'
sleep 15; curl -s 'localhost:5174/api/dev/dump?chat=trip1' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['state']['itinerary'], d['state']['status'])"
```

Expected: one flight item with `status: handoff` and a Google Flights URL; plan status `idle`.

- [ ] **Step 3: Full verification**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
npm run typecheck
SMOKE_BASE=http://127.0.0.1:5174 npm run smoke 2>&1 | tail -3
```

Expected: fail 0; typecheck clean; "all checks passed".

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "README: trips, the itinerary, and watching flights and parcels

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then push the branch and open the PR against `main` per the repo's workflow (rebase on `origin/main` first, PR via `gh`, staging deploy before merge).
