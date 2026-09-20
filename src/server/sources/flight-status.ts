import { log } from "../log.ts";
import { pageTitle, proxiedFetch, type SourceEnv } from "./fetch.ts";
import type { FlightStatus } from "./types.ts";

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
    scheduledDeparture: dep.scheduled!,
    estimatedDeparture: opt(dep.estimated),
    actualDeparture: opt(dep.actual),
    scheduledArrival: arr.scheduled!,
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
