/**
 * What a ballot option's booking link is a link to. Used to keep the model
 * from asking for a name and email on a flight, stay or event — those never
 * go through book_option, only add_to_itinerary.
 */
export function tripKind(url?: string): "flight" | "stay" | "event" | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "google.com" && parsed.pathname.startsWith("/travel/flights")) return "flight";
  if (host === "google.com" && parsed.pathname.startsWith("/travel/search")) return "stay";
  if (host.includes("ticketmaster.") || host === "luma.com") return "event";
  return undefined;
}
