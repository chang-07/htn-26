# Trip sources: flights, stays, events and tracking in the chat

Date: 2026-09-19. Status: approved design, ahead of the Hack the North demo on 2026-09-20.

## Goal

A group chat plans a whole trip or night out with the agent without leaving iMessage: the agent finds flights, a place to stay and things to do, the group votes on each with tapbacks, the winner becomes a commitment with a link to finish, and afterwards the agent tracks the flight and any deliveries and posts changes into the chat. Costs land on the existing invoice.

The recipes come from the browse.sh skill catalog. Only recipes that work from this account tonight are in scope: those served by Browserbase's Fetch API with residential proxies. Browserbase browser sessions with proxies (402 on the free plan) and its "verified" stealth mode (Enterprise only) are not available, which rules out Kayak, Skyscanner, Booking.com, Airbnb, Expedia, OpenTable and every parcel carrier.

## What was verified on 2026-09-19

| Source | URL | Parse | Result |
|---|---|---|---|
| Google Flights | `https://www.google.com/travel/flights?q=Flights to YVR from YYZ on 2026-10-10 one way&curr=CAD&hl=en` | one `aria-label` sentence per itinerary: "From 254 Canadian dollars. Nonstop flight with Flair Airlines. Leaves Toronto Pearson International Airport at 1:55 PM on Saturday, October 10 and arrives at Vancouver International Airport at 4:05 PM on Saturday, October 10. Total duration 5 hr 10 min. …" | 54 itineraries, no captcha |
| Google Hotels | `https://www.google.com/travel/search?q=hotels in Vancouver&dates=2026-10-10,2026-10-12&adults=4&curr=CAD&hl=en&gl=ca` | largest `AF_initDataCallback({...})` blob; tuples `["JW Marriott Parq Vancouver","/aclk…","$277",null,5186,4.2` (name, link, nightly price, reviews, rating) | 9 priced properties; `/travel/hotels?…` redirects (302) to `/travel/search`, so use the latter |
| Ticketmaster | `https://www.ticketmaster.ca/search?q=Toronto Raptors` then `https://www.ticketmaster.ca/api/search/events/artist/806034?page=0&countryCodes=CA` | `__NEXT_DATA__` JSON, key containing `topSuggestions(` → `data.results[]` with `url` ending `/artist/<id>`; events API returns `{total, events:[{title,id,dates:{startDate,onsaleDate},venue,…}]}` | works with proxies; datacenter IPs get `403 Tm-Bl` |
| Luma | `https://api.luma.com/discover/get-paginated-events?slug=toronto&pagination_limit=20` | `{entries:[{event:{name,start_at,url,geo_address_info}}], has_more, next_cursor}` | works with no proxy and no key |
| FlightAware | `https://www.flightaware.com/live/flight/ACA123` (ICAO ident, `www.` host) | `var trackpollBootstrap = {…}` brace-matched; `flights[first].{flightStatus, origin.gate, origin.terminal, destination.gate, gateDepartureTimes.{scheduled,estimated,actual}, gateArrivalTimes, altitude, groundspeed, activityLog.flights[]}` | AC123 with gates D22 and C41 |
| Shopify order status | the URL `payCheckout` lands on after paying (`/orders/<token>` or a thank-you page) | page text: "Fulfilled", carrier name, tracking number, "Track shipment" link, delivery estimate | checkout already reaches it; the URL is currently discarded in `booking.ts` |

Fixtures from these fetches are saved under `scripts/fixtures/sources/` for parser tests.

## Architecture

```
model turn ─▶ tool (search_flights | search_stays | find_events | watch_flight | add_to_itinerary)
                 │
                 ▼
          src/server/sources/*.ts      pure: params → proxiedFetch → parse → rows
                 │
                 ▼
          ballot options (existing propose_plan) ─▶ tapback vote ─▶ add_to_itinerary
                                                                        │
                                                    itinerary item (handoff) + itinerary ticket + deep link
                                                                        │
                                              confirmation text ─▶ watch_flight / confirm ─▶ scheduled checkWatches
                                                                        │
                                                          change lines into the chat (delay, gate, landed, shipped, delivered)
```

Everything is HTTP. No browser sessions, no model calls inside a source. A lookup takes 2 to 6 seconds, so the tools are synchronous and the model sees results in the same turn. This is different from `research`, which runs for minutes and reports back.

## `src/server/sources/`

### `fetch.ts`

```ts
export async function proxiedFetch(env, url: string, opts?: { headers?: Record<string,string>; proxies?: boolean }): Promise<{ status: number; content: string }>
```

Calls `POST https://api.browserbase.com/v1/fetch` with `{ url, proxies: opts.proxies ?? true, headers }`, `X-BB-API-Key`, a 30 second `AbortSignal.timeout`, and wraps it in `traceOperation("provider.fetch", "http.client", { provider: hostname })` like `research-sources.ts`. Throws `SourceError("no_browserbase")` when the key is missing. Never logs response bodies. Luma passes `proxies: false`.

### Shared shapes (`types.ts` in the folder)

```ts
export type Flight = { price: string; currency: string; airline: string; departs: string; arrives: string; from: string; to: string; duration: string; stops: number; layover?: string; nextDay: boolean; url: string };
export type Stay = { name: string; nightly: string; rating?: number; reviews?: number; url: string };
export type Event = { title: string; when: string; venue?: string; city?: string; url: string; onsale?: string; soldOut?: boolean; limited?: boolean; source: "ticketmaster" | "luma" };
export type FlightStatus = { ident: string; iata: string; status: "scheduled" | "departed" | "landed" | "cancelled" | "unknown"; from: string; to: string; gateFrom?: string; terminalFrom?: string; gateTo?: string; terminalTo?: string; scheduledDeparture: number; estimatedDeparture?: number; actualDeparture?: number; scheduledArrival: number; estimatedArrival?: number; actualArrival?: number; delayMinutes: number; url: string };
export type OrderStatus = { fulfilled: boolean; delivered: boolean; carrier?: string; tracking?: string; trackingUrl?: string; eta?: string };
```

Every parser is `parseX(html: string): X[]` (pure, tested on fixtures) and every source is `searchX(env, params): Promise<X[]>` (fetch then parse). A parser that finds nothing returns `[]`; the source logs `source.empty` with the reason and the page title, so a layout change shows up in the run viewer instead of as a silent "no flights".

### `flights.ts`

`searchFlights(env, { from, to, depart, return?, adults? })`. `from`/`to` are IATA codes or city names as the group said them: Google's `q=` accepts both. Query: `Flights to ${to} from ${from} on ${depart}` plus ` returning ${return}` or ` one way`, plus `&curr=CAD&hl=en` (CAD is a constant in `flights.ts`; the demo is Canadian). Parse each `aria-label` that starts with `From <n> <currency>`: price, stops ("Nonstop" or "N stop"), airline ("flight with X" or "flights with X and Y"), leaves/arrives airport and time, "+1"/next-day when the arrival date differs, total duration, first layover. Dedupe on airline+departs+arrives (rows repeat in the DOM). Sort by price, return at most 12. `url` is the search URL, which opens the same results with a Book button on the phone.

### `stays.ts`

`searchStays(env, { where, checkin, checkout, adults? })`. URL: `/travel/search?q=hotels in ${where}&dates=${checkin},${checkout}&adults=${n}&curr=CAD&hl=en&gl=ca`. Take the largest `AF_initDataCallback` blob and match `["<name>","<link>","$<price>",null,<reviews>,<rating>`; also accept `null` link for organic rows. Dedupe on name, sort by price, return at most 10. `url` is `/travel/search?q=${name} ${where}&dates=…`, which opens that property's rates.

### `events.ts`

`findEvents(env, { query?, city, country? })`.
- With `query`: Ticketmaster. Fetch `https://www.ticketmaster.${tld}/search?q=${query}` (tld `ca` for Canada, `com` otherwise), parse `__NEXT_DATA__`, find the `topSuggestions(` entry, take results with `suggestionType: "ATTRACTION"` and `count > 0`, prefer an exact title match, read the artist id from `url`. Then fetch `/api/search/events/artist/${id}?page=0&countryCodes=${CC}` and map events. Stop at one page (20 events) unless fewer than 3 match the city.
- Without `query`: Luma `slug=${citySlug}` (lowercase, spaces removed) for the next 20 events, filtered to the next 30 days.
- Both: at most 10 rows, soonest first.

### `flight-status.ts`

`flightStatus(env, { ident, date? })`. Normalize the ident: `AC123` → `ACA123` via a small IATA→ICAO map for the carriers a Canadian demo will meet (AC→ACA, WS→WJA, PD→POE, F8→FLE, UA→UAL, AA→AAL, DL→DAL, WN→SWA, B6→JBU, AS→ASA, BA→BAW, LH→DLH, AF→AFR); anything already three letters passes through. Fetch `https://www.flightaware.com/live/flight/${ident}`, brace-match `trackpollBootstrap`, take the first flight. Map `flightStatus` text: empty or "Scheduled" → scheduled, contains "En Route"/"Departed" → departed, "Arrived"/"Landed" → landed, "Cancelled" → cancelled. `delayMinutes = (estimated − scheduled)/60` on departure when not departed, on arrival otherwise. Times are epoch seconds; the airport `TZ` (`:America/Toronto`, leading colon stripped) is used to format them for the chat.

### `order-status.ts`

`orderStatus(env, url)` fetches the store's order status page (no proxies) and reads its text: `fulfilled` when "Fulfilled", "Shipped" or "On its way" appears; `delivered` when "Delivered" appears; carrier and tracking from a "Tracking number" line or a link whose host is a known carrier; `eta` from "Estimated delivery" or "Arriving". Everything optional. This is a text heuristic, so the dev route can also inject a fixture.

## Tools (`src/server/tools/index.ts`, executed in `agent.ts` `runTool`)

| Tool | Args | Returns to the model |
|---|---|---|
| `search_flights` | `from`, `to`, `depart` (YYYY-MM-DD), `return?`, `adults?` | up to 12 flights, each shaped as a ballot option `{ title: "Flair YYZ→YVR 1:55 PM–4:05 PM, nonstop", subtitle: "CA$254 · 5 hr 10 min", bookingUrl }`, plus the raw fields |
| `search_stays` | `where`, `checkin`, `checkout`, `adults?` | up to 10 stays as options `{ title: name, subtitle: "$277/night · 4.2★ (5,186)", bookingUrl }` |
| `find_events` | `city`, `query?`, `country?` | up to 10 events as options `{ title, subtitle: "Thu Dec 17 7:30 PM · Scotiabank Arena · on sale now", bookingUrl }` |
| `add_to_itinerary` | `optionId?` or `item: { kind, title, subtitle?, url?, price? }`, `paidBy?` | records the commitment (below) |
| `watch_flight` | `ident`, `date?`, `itemId?` | immediate status line, and starts the watch |
| `confirm_item` | `itemId`, `note?`, `price?`, `paidBy?` | marks an itinerary item confirmed; with a price and payer it also logs the expense through the existing expense path |

Descriptions tell the model: results arrive in this turn (unlike `research`); post them with `propose_plan` and keep the ballot to 2 to 4 options; the links open the site's own checkout, so the agent never books flights, stays or tickets itself; only call `add_to_itinerary` once a vote has clearly settled; and never say something is booked until a person confirms.

Validation: dates must parse and be today or later; `adults` 1 to 9; `from`/`to` 2 to 40 characters. A source error returns a short model-facing string ("Google Flights did not answer; try again or ask them to check the link") and logs the cause.

## State: the itinerary

`PlanState` gains:

```ts
export type ItineraryItem = {
  id: string;                       // "i" + 4 hex
  kind: "flight" | "stay" | "event" | "venue" | "order";
  title: string;
  subtitle?: string;
  url?: string;
  price?: string;                   // display string
  status: "handoff" | "confirmed" | "watching" | "done";
  note?: string;                    // confirmation number, "AC123 on Oct 10", tracking number
  paidBy?: string;                  // display name
  watch?: { flight: { ident: string; date?: string } } | { order: { url: string } };
  lastUpdate?: string;              // one line, what was last posted about it
};
itinerary?: ItineraryItem[];
```

It is public state (pushed to the vote page) so it holds display names only, like `going` and `awaiting`.

`add_to_itinerary` with an `optionId` copies the winning option's title, subtitle and `bookingUrl`, pushes the item with `status: "handoff"`, posts the itinerary ticket, says one line with the link ("flights: Flair YYZ→YVR Oct 10, CA$254 each. Book it here: <url>. Tell me the flight number once it's booked and I'll watch it."), then resets the ballot (`options: []`, `counts: {}`, `chosenOptionId` cleared, `status: "idle"`) so the next segment can open. The plan `title` is kept. With an inline `item`, the same without touching the ballot.

A paid cart becomes an `order` item automatically in `payFinished`: `booking.ts` keeps `done.url` on `PayResult` as `orderUrl`, and the agent pushes `{ kind: "order", title: shop, status: "watching", watch: { order: { url } }, paidBy }`.

`bookingFinished` for a venue on the ballot also pushes a `venue` item (confirmed or handoff), so a venue booked with the existing pilot appears on the same itinerary. Plan status semantics do not change for venues.

## Tracking

`checkWatches` is a scheduled method on `PlanAgent`. It is scheduled 15 minutes out whenever a watch is added, and reschedules itself while any watch is active. A flight watch is active from 36 hours before scheduled departure until landed or cancelled, or 6 hours after scheduled arrival; an order watch is active until delivered or 14 days after the purchase.

Per item it fetches the status, compares to the last snapshot stored in the agent's private SQLite (`watches(item_id, snapshot_json, checked_at)`), and posts a line only for:

- flight: delay crosses 15 minutes or changes by 15 or more since last posted; gate or terminal changes; departed; landed (with the arrival gate); cancelled;
- order: fulfilled (with carrier, tracking number and link); delivered.

Lines are plain text via `say`, not tickets, so they arrive in a second. Landed and delivered mark the item `done`, update `lastUpdate`, and post the itinerary ticket once more. A fetch failure is logged and retried at the next tick; three consecutive failures on an item post one line ("I can't reach FlightAware for AC123 right now, here's the link") and back off to hourly.

`watch_flight` runs one immediate check and posts the current status ("AC123 YYZ→YVR: on time, departs 1:55 PM from gate D22, terminal 1").

## Cards

`itineraryTicket(items, title)` in `card.ts`: tone `open` while anything is `handoff` or `watching`, `done` once every item is `confirmed` or `done`; `metaLeft` "Itinerary", `metaRight` the count; up to four rows, one per item in order, "✈︎ Flair YYZ→YVR Oct 10 · booked" / "🏨 JW Marriott Parq · yours to finish" / "🎟 Raptors vs Spurs Dec 17 · watching"; stub `TRIP` / the plan title. The existing plan ticket is unchanged.

## Prompt

`SYSTEM` gains a short "trips" paragraph: for a trip, work in segments, flights first, then where to stay, then things to do, one ballot at a time; use `search_flights`, `search_stays` and `find_events` for real options and quote their prices; the links open the site's own checkout, so hand off and ask for the confirmation; once someone gives a flight number, watch it; log what people paid so the split is right. The context block the model sees each turn adds an `itinerary:` line listing items and statuses, and a `watching:` line when checks are scheduled.

## Dev routes (`index.ts`, localhost only like the rest of `/api/dev/*`)

- `GET /api/dev/source?kind=flights|stays|events|flight|order&…params` runs one source and returns the rows: the way to check a recipe without the model.
- `POST /api/dev/watch {"chat","force":true}` runs `checkWatches` now.
- `POST /api/dev/shipped {"chat","itemId","carrier","tracking","trackingUrl"}` injects an order snapshot as if the store had shipped, then runs the check, so the demo shows the "shipped" line without waiting for a real parcel.
- `POST /api/dev/flight-snapshot {"chat","itemId","status":{…}}` likewise for a flight, so a delay or a gate change can be demonstrated on cue.

## Tests

- `scripts/sources.test.mjs` (node --test, with `--experimental-strip-types` like `research-sources.test.mjs`): `parseFlights` on `google-flights.html` yields 50+ rows with the cheapest CA$254 Flair nonstop; `parseStays` on `google-hotels.html` yields the five named hotels with prices; `parseTicketmasterSearch` resolves Toronto Raptors to artist 806034 and `parseTicketmasterEvents` maps the Spurs game with its on-sale date; `parseLuma` maps the Toronto entries; `parseFlightStatus` on `flightaware.html` yields YYZ→YVR, gate D22, terminal 1, delay 0; `parseOrderStatus` on inline snippets for unfulfilled, fulfilled with a tracking link, and delivered.
- `scripts/watch.test.mjs`: `diffFlight(prev, next)` and `diffOrder(prev, next)` produce exactly the lines above and nothing for unchanged or sub-threshold changes.
- Smoke (`scripts/smoke.mjs`), no network: `add_to_itinerary` via `/api/dev/tool` pushes an item, clears the ballot and posts one itinerary ticket; `/api/dev/shipped` posts one "shipped" line and marks the item; the itinerary ticket renders as a PNG in both tones via `/api/dev/card?kind=itinerary&state=open|done`. When `BROWSERBASE_API_KEY` is set, one live `search_flights` for YYZ→YVR next month must return at least one row; otherwise the check is skipped and says so.
- `npm run typecheck` clean.

## Out of scope

Booking or paying for flights, stays or tickets; parcel carriers (needs a carrier API account or the Browserbase stealth tier); Kayak, Skyscanner, Booking.com, Airbnb, Expedia, OpenTable; any generic runtime skill loader; hotel availability per room type; multi-city flights; currencies other than the configured one.

## Risks

Google can change its markup; the parsers log `source.empty` with the page title and the fixtures pin tonight's shape. Google Flights results are server-rendered for the URL form used here; a different query form (`tfs=` deep links) may not be, so stay with `q=`. Proxied Fetch is metered per request on the free plan, so `checkWatches` never fires more often than every 15 minutes and stops when nothing is active.
