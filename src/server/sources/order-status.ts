import { proxiedFetch, type SourceEnv } from "./fetch.ts";
import type { OrderStatus } from "./types.ts";

const CARRIERS = ["Canada Post", "Purolator", "FedEx", "UPS", "USPS", "DHL", "Intelcom", "GLS", "Amazon"];

/**
 * A Shopify order status page says "on its way" once fulfilled and shows the
 * carrier's tracking number as a link. This is a text heuristic over that
 * page: everything past `fulfilled` is optional.
 */
export function parseOrderStatus(html: string): OrderStatus {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  const delivered = /\bdelivered\b/i.test(text) && !/not (yet )?delivered|will be delivered/i.test(text);
  const fulfilled = delivered || /\b(fulfilled|shipped|on its way|out for delivery|in transit)\b/i.test(text);
  const out: OrderStatus = { fulfilled, delivered };
  if (!fulfilled) return out;
  const carrier = CARRIERS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(text));
  if (carrier) out.carrier = carrier;
  const tracking = /tracking (?:number|#|no\.?)[:\s]+([A-Z0-9]{8,35})/i.exec(text)?.[1];
  if (tracking) out.tracking = tracking;
  const link = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).find((href) => /track/i.test(href) && (!tracking || href.includes(tracking)));
  if (link) out.trackingUrl = link.replace(/&amp;/g, "&");
  const eta = /(?:estimated delivery|arriving|expected)[:\s]+([A-Z][a-z]+(?:day)?,? [A-Z][a-z]+ \d{1,2}(?:,? \d{4})?|[A-Z][a-z]+ \d{1,2}(?: – [A-Z][a-z]+ \d{1,2})?)/i.exec(text)?.[1];
  if (eta) out.eta = eta;
  return out;
}

/** The store's own page needs no proxy. */
export async function orderStatus(env: SourceEnv, url: string): Promise<OrderStatus> {
  const page = await proxiedFetch(env, url, { proxies: false });
  return parseOrderStatus(page.content);
}
