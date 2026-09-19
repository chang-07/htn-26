import { z } from "zod";
import { log } from "../log.ts";
import { pageTitle, proxiedFetch, type SourceEnv } from "./fetch.ts";
import type { Event } from "./types.ts";

const MAX_RESULTS = 10;
const DAYS_AHEAD = 30;

export type EventQuery = { city: string; query?: string; country?: string };

const tld = (country?: string) => ((country ?? "CA").toUpperCase() === "CA" ? "ca" : "com");

/**
 * A comparable city key: fold accents (NFD, strip combining marks) before
 * dropping everything but a-z, so "Québec" and "Quebec" match, and Luma's
 * slug for a French-named city is still plain ASCII.
 */
export const cityKey = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/** City key → IANA zone, for the cities a Canadian demo meets. Defaults to America/Toronto. */
const CITY_TZ: Record<string, string> = {
  toronto: "America/Toronto",
  ottawa: "America/Toronto",
  montreal: "America/Toronto",
  quebec: "America/Toronto",
  hamilton: "America/Toronto",
  london: "America/Toronto",
  vancouver: "America/Vancouver",
  victoria: "America/Vancouver",
  calgary: "America/Edmonton",
  edmonton: "America/Edmonton",
  banff: "America/Edmonton",
  winnipeg: "America/Winnipeg",
  halifax: "America/Halifax",
  regina: "America/Regina",
  saskatoon: "America/Regina",
  newyork: "America/New_York",
  boston: "America/New_York",
  washington: "America/New_York",
  philadelphia: "America/New_York",
  miami: "America/New_York",
  chicago: "America/Chicago",
  losangeles: "America/Los_Angeles",
  sanfrancisco: "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  denver: "America/Denver",
};

/** The searched city's zone, for formatting an event's time; unknown cities default to America/Toronto. */
export const cityTz = (city: string): string => CITY_TZ[cityKey(city)] ?? "America/Toronto";

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

const TmEvent = z.object({
  title: z.string(),
  url: z.string().optional(),
  dates: z.object({ startDate: z.string().optional(), onsaleDate: z.string().optional() }).optional(),
  venue: z.object({ name: z.string().optional(), city: z.string().optional(), state: z.string().optional() }).nullish(),
  soldOut: z.boolean().optional(),
  limitedAvailability: z.boolean().optional(),
  cancelled: z.boolean().optional(),
});
const TmEnvelope = z.object({ events: z.array(z.unknown()) });

export function parseTicketmasterEvents(json: string): Event[] {
  let envelope: z.infer<typeof TmEnvelope>;
  try {
    envelope = TmEnvelope.parse(JSON.parse(json));
  } catch {
    return [];
  }
  const events: z.infer<typeof TmEvent>[] = [];
  for (const raw of envelope.events) {
    const item = TmEvent.safeParse(raw);
    if (item.success) events.push(item.data); // one malformed event must not zero the whole batch
  }
  return events
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

const LumaEntry = z.object({
  event: z.object({
    name: z.string(),
    start_at: z.string(),
    url: z.string(),
    geo_address_info: z.object({ address: z.string().nullish(), city_state: z.string().nullish() }).nullish(),
  }),
});
const LumaEnvelope = z.object({ entries: z.array(z.unknown()) });

export function parseLuma(json: string): Event[] {
  let envelope: z.infer<typeof LumaEnvelope>;
  try {
    envelope = LumaEnvelope.parse(JSON.parse(json));
  } catch {
    return [];
  }
  const events: Event[] = [];
  for (const raw of envelope.entries) {
    const entry = LumaEntry.safeParse(raw);
    if (!entry.success) continue; // one malformed entry must not zero the whole batch
    const { event } = entry.data;
    events.push({
      title: event.name,
      when: event.start_at,
      ...(event.geo_address_info?.address ? { venue: event.geo_address_info.address } : {}),
      ...(event.geo_address_info?.city_state ? { city: event.geo_address_info.city_state } : {}),
      url: `https://luma.com/${event.url}`,
      source: "luma" as const,
    });
  }
  return events;
}

/**
 * With a query (a team, an artist, a show): Ticketmaster, the city's events
 * first. Without: Luma's feed for the city. Both soonest first, at most ten.
 */
export async function findEvents(env: SourceEnv, q: EventQuery, now = new Date()): Promise<Event[]> {
  const horizon = new Date(now.getTime() + DAYS_AHEAD * 86_400_000).toISOString();
  const citySlug = cityKey(q.city);
  const inCity = (e: Event) => cityKey(e.city ?? "").startsWith(citySlug);
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
    if (!events.length) log("warn", "source", "empty", { source: "ticketmaster-events", status: list.status, artist: artist.id });
  } else {
    const page = await proxiedFetch(env, `https://api.luma.com/discover/get-paginated-events?slug=${citySlug}&pagination_limit=20`, { proxies: false });
    events = parseLuma(page.content).filter((e) => e.when >= now.toISOString() && e.when <= horizon);
    if (!events.length) log("warn", "source", "empty", { source: "luma", status: page.status, city: citySlug });
  }
  // Within each group (city first), soonest first.
  const stable = events.map((e, i) => ({ e, i }));
  stable.sort((a, b) => Number(inCity(b.e)) - Number(inCity(a.e)) || a.e.when.localeCompare(b.e.when) || a.i - b.i);
  return stable.map((s) => s.e).slice(0, MAX_RESULTS);
}

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
