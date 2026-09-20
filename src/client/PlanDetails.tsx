import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useAgent } from "agents/react";
import { cartsOf, type PlanState } from "../types";
import "./PlanDetails.css";

type ServiceItem = {
  id: string; category: string; provider: string; title: string; detail: string;
  status: "Booked" | "Payment recorded" | "Ready to order" | "Saved" | "Searched" | "Needs confirmation" | "In progress" | "Needs attention";
  logoUrl?: string; price?: string; notes: string[]; url?: string; linkLabel?: string;
};
type PlanView = {
  title: string; subtitle: string; example: boolean;
  schedule: { day: string; date: string; events: { time: string; title: string; note: string }[] }[];
  items: ServiceItem[];
  research: { provider: string; title: string; detail: string; result: string }[];
};
const safeUrl = (url?: string) => { try { const parsed = new URL(url || ""); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } };
const EXAMPLE_PLANS: Record<string, PlanView> = {
  "game-night": {
    title: "Friday game night", subtitle: "Sep 25 · 8 people · Toronto", example: true,
    schedule: [{ day: "Friday", date: "Sep 25", events: [
      { time: "7:00 pm", title: "Everyone arrives", note: "Bring your favourite game" },
      { time: "7:30 pm", title: "Pizza, then teams", note: "Food order ready to review" },
      { time: "8:00 pm", title: "Let the games begin", note: "A few rounds of whatever wins the vote" },
    ] }],
    items: [
      { id: "food", category: "Food", provider: "DoorDash", title: "Pizza for the group", detail: "4 pizzas · Vegetarian option included", status: "Ready to order", price: "Est. CA$92", notes: ["Review the order and delivery address before checkout.", "Example only. No food has been ordered."], url: "https://www.doordash.com/", linkLabel: "Open DoorDash" },
      { id: "ride", category: "Ride", provider: "Uber", title: "A ride home", detail: "Saved for after the games", status: "Saved", notes: ["Request a ride when you’re ready. Nothing is scheduled."], url: "https://m.uber.com/", linkLabel: "Open Uber" },
    ],
    research: [
      { provider: "DoorDash", title: "Pizza for eight", detail: "Compared group portions and vegetarian options.", result: "Order ready to review" },
      { provider: "Game ideas", title: "Games for a bigger group", detail: "Looked for easy party games with short rounds.", result: "Three ideas saved" },
    ],
  },
  concert: {
    title: "Calvin Harris at Ushuaïa", subtitle: "Sep 25 · 4 friends · Ibiza", example: true,
    schedule: [{ day: "Friday", date: "Sep 25", events: [{ time: "6:00 pm", title: "Meet up before the show", note: "Get everyone together" }, { time: "Evening", title: "Calvin Harris at Ushuaïa", note: "Check the venue’s final entry details" }, { time: "After", title: "Head home together", note: "Request a ride when everyone is ready" }] }],
    items: [
      { id: "tickets", category: "Tickets", provider: "Ushuaïa", title: "Calvin Harris", detail: "Sep 25 · 4 general admission tickets", status: "Booked", price: "€360", notes: ["Four sample tickets for your group.", "Example confirmation: DEMO-TICKETS-01.", "This is a fictional booking preview, not a valid ticket or event listing."], url: "https://www.theushuaiaexperience.com/", linkLabel: "Open venue website" },
      { id: "ride", category: "Ride", provider: "Uber", title: "Ride home after the show", detail: "4 riders · Pickup after the show", status: "Searched", notes: ["Transport option researched for the group.", "No driver assigned or pickup scheduled. Check local availability before requesting."], url: "https://m.uber.com/", linkLabel: "Open Uber" },
    ],
    research: [
      { provider: "Ushuaïa", title: "Tickets for the group", detail: "Reviewed general admission for four people.", result: "Example tickets selected" },
      { provider: "Uber", title: "Getting home after the show", detail: "Looked into transport after the show.", result: "No ride requested" },
    ],
  },
};

function serviceBrand(provider: string) {
  const name = provider.toLowerCase();
  if (name.includes("doordash")) return { logo: "doordash", tone: "coral" };
  if (name.includes("uber")) return { logo: "uber", tone: "mint" };
  if (name.includes("booking.com")) return { logo: "booking", tone: "blue" };
  return { logo: null, tone: name.includes("hotel") ? "blue" : "pink" };
}
function ServiceLogo({ provider, logoUrl }: { provider: string; logoUrl?: string }) {
  const [failed, setFailed] = useState(false);
  const { logo } = serviceBrand(provider);
  return <span className={`plan-logo ${logoUrl && !failed ? "downloaded" : logo || "generic"}`} aria-hidden="true">{logoUrl && !failed ? <img src={logoUrl} alt="" onError={() => setFailed(true)} /> : logo ? <img src={`/images/services/${logo}.svg`} alt="" /> : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">{provider.toLowerCase().includes("hotel") ? <><path d="M5 21V4h14v17M3 21h18M9 21v-5h6v5M9 8h1m4 0h1M9 12h1m4 0h1" /></> : <><path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4V6Z" /><path d="M15 6v3m0 2v2m0 2v3" /></>}</svg>}</span>;
}
function PlanContent({ plan, voteLink }: { plan: PlanView; voteLink?: string }) {
  const [tab, setTab] = useState("Plan");
  const [dayIndex, setDayIndex] = useState(0);
  const day = plan.schedule[dayIndex];
  return <div className="plan-details">
    <div className="plan-overline"><p>{plan.subtitle}</p>{plan.example && <span className="plan-example-note" title="Bookings, prices, and research are sample data.">Example plan</span>}</div>
    <nav className="plan-detail-tabs" aria-label="Plan details">{["Plan", "Bookings"].map(name => <button key={name} onClick={() => setTab(name)} aria-current={tab === name ? "page" : undefined}>{name}</button>)}</nav>
    {tab === "Plan" && <>
      {day && <section className="plan-itinerary"><div className="plan-section-heading"><h3>Itinerary</h3><div className="plan-days" aria-label="Itinerary day">{plan.schedule.map((entry, index) => <button key={entry.day} onClick={() => setDayIndex(index)} aria-pressed={index === dayIndex}>{entry.day.slice(0, 3)}</button>)}</div></div><div className="plan-day-events">{day.events.map((event, i) => <div className="plan-event" key={i}><span>{event.time}</span><strong>{event.title}</strong></div>)}</div></section>}
      {!day && <p className="plan-empty">The timeline will appear here once times are set.</p>}
    </>}
    {tab === "Bookings" && <>
      <div className="plan-section-heading"><h3>Bookings & services</h3></div>
      <div className="plan-services">{plan.items.map(item => <article key={item.id} className="plan-service"><details><summary>
        <ServiceLogo provider={item.provider} logoUrl={item.logoUrl || (item.provider === "Ushuaïa" ? "/images/services/ushuaia.png" : undefined)} />
        <div className="plan-service-copy"><span className="plan-provider">{item.provider}</span><h3>{item.title}</h3>
        <div className="plan-service-meta">{item.price && <strong>{item.price}</strong>}<span className={`plan-state ${item.status === "Booked" ? "confirmed" : ""}`}>{item.status}</span></div></div>
        <span className="plan-expand" aria-hidden="true">+</span>
        <div className="plan-booking-action">{safeUrl(item.url) ? <a href={safeUrl(item.url)} target="_blank" rel="noreferrer" aria-label={`${item.linkLabel || "Open booking page"}: ${item.title}`} title={item.linkLabel || "Open booking page"} onClick={event => event.stopPropagation()}><ArrowUpRight size={20} strokeWidth={2} aria-hidden="true" /></a> : <p>Booking link not available yet.</p>}</div>
      </summary><div className="plan-service-detail"><p className="plan-item-meta">{item.detail}</p>{item.notes.map((note, i) => <p key={i}>{note}</p>)}</div></details></article>)}</div>
      {!plan.items.length && <p className="plan-empty">Your bookings will appear here.</p>}

    </>}

    {voteLink && tab === "Plan" && <a className="plan-vote-link" href={voteLink}>Group vote</a>}
  </div>;
}
export function ExamplePlanDetails({ id }: { id: string }) { return <PlanContent plan={EXAMPLE_PLANS[id] ?? EXAMPLE_PLANS["game-night"]} />; }

export function liveView(state: PlanState): PlanView {
  const chosen = state.options.find(option => option.id === state.chosenOptionId);
  const items: ServiceItem[] = [];
  const company = (url?: string) => { try { return new URL(url || "").hostname.replace(/^www\./, ""); } catch { return undefined; } };
  const logoFor = (url?: string) => state.media?.logos[company(url) || ""];
  if (chosen) items.push({ id: chosen.id, category: "Reservation", provider: company(chosen.bookingUrl) || "Whim", logoUrl: logoFor(chosen.bookingUrl), title: chosen.title, detail: chosen.subtitle || "Selected by your group", status: state.status === "booked" ? "Booked" : state.status === "booking" ? "In progress" : state.status === "failed" ? "Needs attention" : "Needs confirmation", notes: [state.bookingNote || "No additional booking details available."], url: chosen.bookingUrl, linkLabel: "Open venue booking page" });
  state.options.filter(option => option.id !== chosen?.id && safeUrl(option.bookingUrl)).forEach(option => items.push({
    id: option.id, category: "Option", provider: company(option.bookingUrl) || "Whim", logoUrl: logoFor(option.bookingUrl),
    title: option.title, detail: option.subtitle || "Found for your group", status: "Saved",
    notes: [option.availability || "Not booked yet."], url: option.bookingUrl, linkLabel: "Open booking page",
  }));
  cartsOf(state).forEach((cart, i) => items.push({ id: `cart-${i}`, category: "Shopping", provider: cart.shop, logoUrl: logoFor(cart.checkoutUrl), title: `Order from ${cart.shop}`, detail: `${cart.lines.reduce((n, line) => n + line.quantity, 0)} items`, status: cart.paidBy ? "Payment recorded" : "Ready to order", price: cart.total, notes: [...cart.lines.map(line => `${line.quantity} × ${line.title} · ${line.price}`), ...(cart.paidBy ? [`${cart.paidBy} marked this order as paid. Check the merchant for fulfillment.`] : ["Checkout prepared. An order confirmation hasn’t been provided."])], url: cart.checkoutUrl, linkLabel: "Open checkout" }));
  return { title: state.title, subtitle: state.going?.length ? `${state.going.length} people going · From your iMessage group` : "From your iMessage group", example: false, schedule: [], items, research: state.options.map(option => ({ provider: "Whim", title: option.title, detail: [option.subtitle, option.availability].filter(Boolean).join(" · ") || "Proposed to your group", result: option.id === state.chosenOptionId ? "Selected by the group" : `${state.counts[option.id] ?? 0} votes` })) };
}
export function LivePlanDetails({ agent }: { agent: string }) {
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [error, setError] = useState(false);
  useAgent<PlanState>({ agent: "plan-agent", name: agent, onStateUpdate: state => { setPlan(state); setError(false); }, onError: () => setError(true), onClose: () => setError(true) });
  useEffect(() => { const timer = setTimeout(() => { if (!plan) setError(true); }, 10000); return () => clearTimeout(timer); }, [plan]);
  if (!plan) return <p className="plan-empty" role="status">{error ? "Couldn’t load this plan. Close it and try again." : "Loading plan…"}</p>;
  return <>{error && <p className="plan-example-note" role="status">Connection interrupted. Showing the last received plan.</p>}<PlanContent plan={liveView(plan)} voteLink={`/w/${encodeURIComponent(agent)}`} /></>;
}
