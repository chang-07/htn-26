import { fmtLocal } from "./flight-status.ts";
import type { FlightStatus, OrderStatus } from "./types.ts";

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

/**
 * What to persist as the flight snapshot: `next`, except that when this tick
 * posted no delay line ("is delayed" / "is back on time"), the delay holds at
 * `prev`'s. Without this, a creeping delay (20 → 34 → 48) drifts the stored
 * baseline every tick and never crosses the 15-minute step again, so only the
 * first move is ever announced.
 */
export function baselineFor(prev: FlightStatus | undefined, next: FlightStatus, posted: string[]): FlightStatus {
  const announcedDelay = posted.some((line) => line.includes("is delayed") || line.includes("is back on time"));
  if (!announcedDelay && prev && next.status === "scheduled") {
    return { ...next, delayMinutes: prev.delayMinutes, estimatedDeparture: prev.estimatedDeparture };
  }
  return next;
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
