import test from "node:test";
import assert from "node:assert/strict";
import { proxiedFetch, SourceError, pageTitle } from "../src/server/sources/fetch.ts";
import { icaoIdent, parseFlightStatus, flightStatus, describeFlight, fmtLocal } from "../src/server/sources/flight-status.ts";
import { parseOrderStatus } from "../src/server/sources/order-status.ts";

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
  // The fixture's genuine cheapest fare is a 1-stop overnight WestJet via
  // Saskatoon (CA$198), not the nonstop — pinned to what the fixture holds.
  const cheapest = flights[0];
  assert.equal(cheapest.price, "CA$198");
  assert.equal(cheapest.currency, "CAD");
  assert.equal(cheapest.airline, "WestJet");
  assert.equal(cheapest.stops, 1);
  assert.equal(cheapest.from, "Toronto Pearson International Airport");
  assert.equal(cheapest.to, "Vancouver International Airport");
  assert.equal(cheapest.departs, "10:55 PM");
  assert.equal(cheapest.arrives, "8:25 AM");
  assert.equal(cheapest.date, "Saturday, October 10");
  assert.equal(cheapest.duration, "12 hr 30 min");
  assert.equal(cheapest.nextDay, true);
  assert.equal(cheapest.url, url);
  assert.match(cheapest.layover, /^6 hr \d+ min at Saskatoon/);
  const nonstopCheapest = flights.find((f) => f.stops === 0);
  assert.equal(nonstopCheapest.price, "CA$254");
  assert.equal(nonstopCheapest.airline, "Flair Airlines");
  assert.equal(nonstopCheapest.departs, "1:55 PM");
  assert.equal(nonstopCheapest.arrives, "4:05 PM");
  const oneStop = flights.find((f) => f.stops === 1 && f.airline === "WestJet" && f.layover.includes("Calgary"));
  assert.ok(oneStop, "no Calgary-layover WestJet flight");
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

test("parseFlights reads a round-trip total, not just an exact currency match", () => {
  // A real one-way aria-label from the fixture, with the currency phrase
  // edited to the "round trip total" form Google uses for round trips
  // (confirmed live in Step 5): "From 368 Canadian dollars round trip total. …"
  const label =
    "From 368 Canadian dollars round trip total. Nonstop flight with Flair Airlines. Leaves Toronto Pearson International Airport at 1:55 PM on Saturday, October 10 and arrives at Vancouver International Airport at 4:05 PM on Saturday, October 10. Total duration 5 hr 10 min.   0 carry-on bags included. 0 checked bags included.  Select flight";
  const html = `<div aria-label="${label}"></div>`;
  const flights = parseFlights(html, "https://x");
  assert.equal(flights.length, 1);
  assert.equal(flights[0].price, "CA$368");
  assert.equal(flights[0].currency, "CAD");
  assert.equal(flights[0].roundTrip, true);
  assert.equal(flightOption(flights[0]).subtitle, "CA$368 round trip · 5 hr 10 min · Sat Oct 10");
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
  const dollars = (s) => Number(s.nightly.replace(/[^\d]/g, ""));
  for (let i = 1; i < stays.length; i++) assert.ok(dollars(stays[i]) >= dollars(stays[i - 1]), "not sorted by price");
  assert.equal(new Set(stays.map((s) => s.name)).size, stays.length, "duplicate names");
});

test("parseStays returns nothing without the blob", () => {
  assert.deepEqual(parseStays("<html><title>x</title></html>", stayQ), []);
});

test("parseStays skips a tuple with a malformed escape instead of dropping the whole page", () => {
  const blob = `AF_initDataCallback({data:[["Bad \\x Hotel","/aclk?1","$150",null,10,4.0,["Good Hotel","/aclk?2","$200",null,20,4.5,]]});</script>`;
  const html = `<html><head><title>x</title></head><body><script>${blob}</script></body></html>`;
  const stays = parseStays(html, stayQ);
  assert.equal(stays.length, 1);
  assert.equal(stays[0].name, "Good Hotel");
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

import { parseTicketmasterSearch, parseTicketmasterEvents, parseLuma, findEvents, eventOption, cityKey, cityTz } from "../src/server/sources/events.ts";

test("parseTicketmasterSearch resolves a team to its artist id", () => {
  assert.deepEqual(parseTicketmasterSearch(fixture("ticketmaster-search.html"), "Toronto Raptors"), { id: "806034", title: "Toronto Raptors" });
  assert.equal(parseTicketmasterSearch("<html></html>", "Toronto Raptors"), undefined);
});

test("parseTicketmasterEvents maps title, date, venue, on-sale and flags", () => {
  const events = parseTicketmasterEvents(fixture("ticketmaster-events.json"));
  assert.ok(events.length >= 5);
  const first = events[0];
  assert.equal(first.source, "ticketmaster");
  assert.ok(first.title.length > 3);
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
  assert.equal(events[0].city, "Toronto, ON", "an out-of-town event came first");
  const firstAway = events.findIndex((e) => e.city !== "Toronto, ON");
  if (firstAway >= 0) assert.ok(events.slice(firstAway).every((e) => e.city !== "Toronto, ON"), "Toronto events are not all first");
  const toronto = events.filter((e) => e.city === "Toronto, ON");
  for (let i = 1; i < toronto.length; i++) assert.ok(toronto[i].when >= toronto[i - 1].when, "not soonest first");
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
  // The same formatter the source uses, so the test pins the words around the date, not the locale's punctuation.
  const when = new Date(e.when).toLocaleString("en-US", { timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  assert.match(when, /Dec 16/);
  const o = eventOption(e, "America/Toronto");
  assert.equal(o.title, "Toronto Raptors vs. San Antonio Spurs");
  assert.equal(o.subtitle, `${when} · Scotiabank Arena · few left`);
  assert.equal(o.bookingUrl, "https://t");
  assert.equal(eventOption({ ...e, soldOut: true, limited: false }, "America/Toronto").subtitle, `${when} · Scotiabank Arena · sold out`);
  assert.equal(eventOption({ ...e, onsale: "2026-12-01T16:00:00Z", limited: false }, "America/Toronto", new Date("2026-11-01T00:00:00Z")).subtitle, `${when} · Scotiabank Arena · on sale Dec 1`);
  assert.equal(eventOption({ ...e, onsale: undefined, limited: false, source: "luma" }, "America/Toronto").subtitle, `${when} · Scotiabank Arena · free to RSVP`);
});

test("cityKey folds accents and drops punctuation", () => {
  assert.equal(cityKey("Montréal"), "montreal");
  assert.equal(cityKey("St. John's"), "stjohns");
});

test("cityTz maps a known city to its zone and defaults elsewhere", () => {
  assert.equal(cityTz("Vancouver"), "America/Vancouver");
  assert.equal(cityTz("Québec"), "America/Toronto");
  assert.equal(cityTz("Nowhere"), "America/Toronto");
});

test("findEvents requests an accent-folded Luma slug for a French city name", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ entries: [] }));
  });
  await findEvents(env, { city: "Québec" }, new Date("2026-09-19T00:00:00Z"));
  assert.equal(calls[0], "https://api.luma.com/discover/get-paginated-events?slug=quebec&pagination_limit=20");
});

test("parseTicketmasterEvents skips a malformed event instead of dropping the whole batch", () => {
  const json = JSON.stringify({
    events: [
      { title: "Good Show", url: "https://www.ticketmaster.ca/good/event/1", dates: { startDate: "2026-10-01T00:00:00Z" } },
      { url: "https://www.ticketmaster.ca/bad/event/2", dates: { startDate: "2026-10-02T00:00:00Z" } }, // missing title
    ],
  });
  const events = parseTicketmasterEvents(json);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Good Show");
});

test("parseLuma skips a malformed entry instead of dropping the whole batch", () => {
  const json = JSON.stringify({
    entries: [
      { event: { name: "Good Meetup", start_at: "2026-10-01T00:00:00.000Z", url: "good-slug" } },
      { event: { start_at: "2026-10-02T00:00:00.000Z", url: "bad-slug" } }, // missing name
    ],
  });
  const events = parseLuma(json);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "Good Meetup");
});

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
  assert.equal(parseOrderStatus("<html><body><p>Your order hasn't shipped yet</p></body></html>").fulfilled, false);
});
