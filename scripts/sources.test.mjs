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
