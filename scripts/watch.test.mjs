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
