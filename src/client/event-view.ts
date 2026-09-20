import type { EventDocument, EventItem } from "../shared/events.ts";
export type ServiceItem = {
  id: string; category: string; provider: string; title: string; detail: string; status: string;
  logoUrl?: string; price?: string; notes: string[]; url?: string; linkLabel?: string;
  links?: EventItem["links"];
};
export type PlanView = {
  title: string; subtitle: string; example: boolean;
  schedule: { day: string; date: string; events: { time: string; title: string; note: string; details?: string[] }[] }[];
  items: ServiceItem[];
  research: { provider: string; title: string; detail: string; result: string }[];
};
const labels: Record<EventItem["status"], string> = { idea: "Idea", saved: "Saved", needs_confirmation: "Needs confirmation", in_progress: "In progress", booked: "Booked", completed: "Completed", cancelled: "Cancelled", failed: "Needs attention" };
function detailText(value: unknown): string {
  if (value === null) return "—";
  if (Array.isArray(value)) return value.map(detailText).join(" · ");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}: ${detailText(entry)}`).join(" · ");
  return String(value);
}
export function eventView(event: EventDocument): PlanView {
  const options = { timeZone: event.timeZone };
  const time = (date: string) => new Date(date).toLocaleTimeString(undefined, { ...options, hour: "numeric", minute: "2-digit" });
  const groups = new Map<string, PlanView["schedule"][number]>();
  const ordered = event.items.filter(item => item.status !== "idea").slice().sort((a,b) => (a.startsAt ? Date.parse(a.startsAt) : Infinity) - (b.startsAt ? Date.parse(b.startsAt) : Infinity));
  for (const item of ordered) {
    const date = item.startsAt ? new Date(item.startsAt).toLocaleDateString("en-CA", options) : "unscheduled";
    if (!groups.has(date)) groups.set(date, { day: item.startsAt ? new Date(item.startsAt).toLocaleDateString(undefined, { ...options, weekday: "short" }) : "TBD", date: item.startsAt ? new Date(item.startsAt).toLocaleDateString(undefined, { ...options, month: "short", day: "numeric" }) : "Time not set", events: [] });
    groups.get(date)!.events.push({ time: item.startsAt ? time(item.startsAt) : item.timeLabel || "Time TBD", title: item.title, details: Object.entries(item.details).map(([key, value]) => `${key}: ${detailText(value)}`), note: [item.location, item.description, item.endsAt ? `Until ${time(item.endsAt)}` : undefined, ["cancelled", "failed"].includes(item.status) ? labels[item.status] : undefined].filter(Boolean).join(" · ") });
  }
  return {
    title: event.title, subtitle: [event.description, event.location, event.people.length ? `${event.people.length} people` : undefined, event.timeZone].filter(Boolean).join(" · "), example: false,
    schedule: Array.from(groups.values()), research: [],
    items: event.items.filter(item => item.provider || item.links.length || item.price || ["booked", "needs_confirmation", "failed"].includes(item.status)).map(item => {
      const primary = item.links.find(link => ["booking", "checkout"].includes(link.kind)) ?? item.links[0];
      return { id: item.id, category: item.kind, provider: item.provider?.name || item.kind.replace(/_/g, " "), title: item.title,
        detail: [item.description, item.location].filter(Boolean).join(" · "), status: labels[item.status], logoUrl: item.provider?.logoUrl, price: item.price,
        notes: [...(item.startsAt ? [`Starts: ${new Date(item.startsAt).toLocaleString(undefined, options)}`] : []), ...(item.endsAt ? [`Ends: ${new Date(item.endsAt).toLocaleString(undefined, options)}`] : []), ...Object.entries(item.details).map(([key, value]) => `${key}: ${detailText(value)}`)],
        url: primary?.url, linkLabel: primary?.label, links: item.links.filter(link => link !== primary),
      };
    }),
  };
}
