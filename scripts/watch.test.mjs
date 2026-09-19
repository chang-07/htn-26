import test from "node:test";
import assert from "node:assert/strict";
import { baselineFor, diffFlight, diffOrder, flightWatchActive, orderWatchActive } from "../src/server/sources/watch.ts";
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

test("baselineFor holds the delay at the last announced value, so a creeping delay is not lost", () => {
  const step20 = { ...base, delayMinutes: 20, estimatedDeparture: T0 + 1200 };
  const step34 = { ...base, delayMinutes: 34, estimatedDeparture: T0 + 2040 };
  const step48 = { ...base, delayMinutes: 48, estimatedDeparture: T0 + 2880 };

  let snapshot = base;
  const posted = [];

  let lines = diffFlight(snapshot, step20);
  posted.push(...lines);
  snapshot = baselineFor(snapshot, step20, lines);
  assert.equal(snapshot.delayMinutes, 20);

  lines = diffFlight(snapshot, step34);
  posted.push(...lines);
  snapshot = baselineFor(snapshot, step34, lines);
  assert.equal(snapshot.delayMinutes, 20, "the baseline must not drift to 34 when nothing was posted");

  lines = diffFlight(snapshot, step48);
  posted.push(...lines);
  snapshot = baselineFor(snapshot, step48, lines);

  const delayLines = posted.filter((l) => /is delayed|is back on time/.test(l));
  assert.equal(delayLines.length, 2, JSON.stringify(posted));
  assert.match(delayLines[0], /is delayed 20 min/);
  assert.match(delayLines[1], /is delayed 48 min/);
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
