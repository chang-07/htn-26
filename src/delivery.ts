/**
 * Where an event's orders ship: one address per chat, shared by everyone who
 * pays for a cart, so three people covering three stores send it all to the
 * same door.
 *
 * It is only ever a prefill. A person sees it in the form and saves it before
 * any checkout uses it, which is why a venue's address — read off the web as
 * one freeform line — may be split into fields by best effort here: whatever
 * this gets wrong, the person fixes on the form.
 */

export type Address = { line1: string; line2?: string; city: string; region: string; postal: string; country: string };

export type Delivery = {
  /** "event": a person types it. "venue": prefilled from a researched venue. */
  source: "event" | "venue";
  /** The venue's name, shown on the form. Never an address. */
  label?: string;
  /** Missing until the first payer types it; partial when read off a venue. */
  address?: Partial<Address>;
  /** True once a person has saved the address on the form. */
  confirmed: boolean;
  /** Changes whenever the address does, so an earlier "ship here" stops counting. */
  stamp: string;
};

const CA_POSTAL = /\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b/i;
const US_ZIP = /\b(\d{5})(-\d{4})?\b(?!.*\b\d{5}\b)/;
const COUNTRY = /^(canada|ca|united states( of america)?|usa?|u\.s\.a?\.?)$/i;

/** "123 King St W, Toronto, ON M5H 1A1" → fields. Leaves out what it cannot tell. */
export function parseAddress(text: string): Partial<Address> {
  const out: Partial<Address> = {};
  let rest = text.replace(/\s+/g, " ").trim();

  const ca = rest.match(CA_POSTAL);
  const us = ca ? null : rest.match(US_ZIP);
  if (ca) {
    out.postal = `${ca[1]} ${ca[2]}`.toUpperCase();
    out.country = "CA";
    rest = rest.replace(ca[0], "");
  } else if (us) {
    out.postal = us[0];
    out.country = "US";
    rest = rest.replace(us[0], "");
  }

  const parts = rest
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !COUNTRY.test(p));

  // The region is a bare two-letter code, on its own or trailing the city ("Toronto ON").
  const at = parts.findIndex((p, i) => i > 0 && /(^|\s)[A-Z]{2}$/.test(p));
  if (at !== -1) {
    out.region = parts[at].slice(-2);
    const before = parts[at].slice(0, -2).trim();
    if (before) parts[at] = before;
    else parts.splice(at, 1);
  }

  if (parts.length) out.line1 = parts[0];
  if (parts.length >= 2) out.city = parts[parts.length - 1];
  if (parts.length >= 3) out.line2 = parts.slice(1, -1).join(", ");
  return out;
}

export function isComplete(a: Partial<Address> | undefined): a is Address {
  return !!(a?.line1 && a.city && a.region && a.postal && a.country);
}
