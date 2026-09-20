import test from "node:test";
import assert from "node:assert/strict";
import { findLocations, getWeather, weatherArgs } from "../src/server/weather.ts";
const place = { id: 6167865, name: "Toronto", admin1: "Ontario", country: "Canada", latitude: 43.65, longitude: -79.38, timezone: "America/Toronto" };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: place.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

test("geocoding returns ambiguity rather than choosing the first location", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url.searchParams.get("name"), "Toronto, Ontario");
    assert.ok(init.signal instanceof AbortSignal);
    return json({ results: [place, { ...place, id: 2, admin1: "Other" }] });
  });
  const result = await findLocations({ query: "Toronto, Ontario" });
  assert.equal(result.locations.length, 2);
  assert.match(result.guidance, /Ask if ambiguous/);
});

test("weather resolves the place id, uses local day, carries units and missing data", async (t) => {
  const day = today();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.hostname.startsWith("geocoding")) {
      assert.equal(url.searchParams.get("id"), String(place.id));
      return json(place);
    }
    assert.equal(url.searchParams.get("timezone"), place.timezone);
    assert.equal(url.searchParams.get("start_date"), day);
    assert.equal(url.searchParams.get("end_date"), day);
    return json({ timezone: place.timezone, daily_units: { temperature_2m_max: "°C", wind_speed_10m_max: "km/h" },
      daily: { time: [day], temperature_2m_max: [21], temperature_2m_min: [12], precipitation_probability_max: [null], wind_speed_10m_max: [15], weather_code: [3] } });
  });
  const result = await getWeather({ locationId: place.id, date: day });
  assert.equal(result.status, "forecast");
  assert.equal(result.daily.precipitation_probability_max[0], null);
  assert.equal(result.daily_units.temperature_2m_max, "°C");
  assert.ok(result.checkedAt);
});

test("past and distant outings never substitute current weather", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    calls++;
    assert.equal(url.hostname, "geocoding-api.open-meteo.com");
    return json(place);
  });
  for (const date of ["2000-01-01", "2099-12-31"]) {
    assert.equal((await getWeather({ locationId: place.id, date })).status, "outside_forecast_window");
  }
  assert.equal(calls, 2);
});

test("weather rejects impossible dates and provider failures", async (t) => {
  assert.equal(weatherArgs.safeParse({ locationId: 1, date: "2026-02-30" }).success, false);
  t.mock.method(globalThis, "fetch", async () => json({ error: true }, 503));
  await assert.rejects(findLocations({ query: "Toronto" }), /HTTP 503/);
});

test("empty geocoding and malformed forecasts are not fabricated", async (t) => {
  t.mock.method(globalThis, "fetch", async () => json({}));
  assert.deepEqual((await findLocations({ query: "Missing city" })).locations, []);
  await assert.rejects(getWeather({ locationId: 1, date: today() }));
});
