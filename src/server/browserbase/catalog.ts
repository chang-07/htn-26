/** Metadata only. Full instructions belong exclusively to the Browserbase subagent. */
export const skills = [
  { id: "ticketmaster.com/find-ticket-i7c0vy", hosts: ["ticketmaster.com"], use: "Concert, sports or theatre event discovery; never seat holds or checkout.", intent: /ticketmaster|concert|tickets|theat(re|er)|sports game/i, browser: false },
  { id: "airbnb.com/search-listings-ddgioa", hosts: ["airbnb.com"], use: "Short-term stays with destination, check-in/out dates and guest count; preserve total vs nightly price.", intent: /airbnb|lodging|accommodation|vacation rental|place to stay|overnight/i, browser: true },
  { id: "alltrails.com/search-trails-dsqvnx", hosts: ["alltrails.com"], use: "Trail discovery with location, difficulty, distance and accessibility constraints.", intent: /alltrails|hik(e|es|ing)|trails?|backpacking|paddling/i, browser: true },
  { id: "doordash.com/extract-menu-5uzqvc", hosts: ["doordash.com"], use: "Named restaurant delivery/pickup menus; no orders. Chain template prices are not store prices.", intent: /doordash|delivery|takeout|take-out|pickup|menu/i, browser: true },
  { id: "facebook.com/search-marketplace-m9gyrc", hosts: ["facebook.com"], use: "Explicit used/local goods searches on Marketplace; never message sellers or make offers.", intent: /marketplace|second.hand|used (?:gear|furniture|bike|equipment)/i, browser: true },
  { id: "opentable.com/check-availability-f2fwrm", hosts: ["opentable.com"], use: "Live restaurant slots for a known venue, local date/time and party size; no reservation.", intent: /opentable|availability|available times|table for|reservation/i, browser: true },
  { id: "skyscanner.net/search-cheapest-flight-v8nvut", hosts: ["skyscanner.net", "skyscanner.com"], use: "One-way flights with origin, destination and departure date; no booking. Flag stops, currency and self-transfer.", intent: /skyscanner|flights?|airfare/i, browser: true },
  { id: "yelp.com/find-menu-jhjk4o", hosts: ["yelp.com"], use: "Named restaurant menu photos when structured menu text is unavailable; transcribe only legible prices.", intent: /yelp|menu|dish|dietary/i, browser: true },
  { id: "luma.com/discover-1zqc5a", hosts: ["luma.com", "lu.ma"], use: "Public local meetups/events by city and interest; no RSVP or tickets purchased.", intent: /luma|meetups?|networking|public events|local events/i, browser: false },
  { id: "link.com/create-payment-credential-0nc34a", hosts: ["link.com"], use: "Unavailable at runtime: requires Stripe Link CLI/MCP and human approval. Existing Linq payment flow owns payments.", intent: /(?!) /, browser: false },
] as const;
export type SkillId = (typeof skills)[number]["id"];
export const paymentSkill: SkillId = "link.com/create-payment-credential-0nc34a";
export function skillForUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return;
    return skills.find((s) => s.hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)));
  } catch { return; }
}
export function eligibleSkills(brief: string) {
  return skills.filter((s) => s.id !== paymentSkill && s.intent.test(brief));
}
export function canUseSkill(id: string, url: string) {
  return id !== paymentSkill && skillForUrl(url)?.id === id;
}

/** Only documented public read endpoints; no arbitrary model-generated API calls. */
export function allowedSkillFetch(id: SkillId, raw: string) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    if (id === "luma.com/discover-1zqc5a") return (
      u.hostname === "api.luma.com" && u.pathname === "/discover/get-paginated-events"
    ) || (u.hostname === "luma.com" && /^\/(discover|[a-z0-9-]+)\/?$/.test(u.pathname));
    if (id === "ticketmaster.com/find-ticket-i7c0vy") return u.hostname === "www.ticketmaster.com" && (
      u.pathname === "/search" || /^\/api\/search\/events\/artist\/\d+$/.test(u.pathname)
      || /^\/[^/]+\/artist\/\d+$/.test(u.pathname)
    );
    return false;
  } catch { return false; }
}
