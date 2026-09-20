import { useEffect, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useAgent } from "agents/react";
import type { PlanState } from "../types";
import { eventFromPlan, type EventDocument } from "../shared/events";
import { eventView, type PlanView } from "./event-view";
import "./PlanDetails.css";

const safeUrl = (url?: string) => { try { const parsed = new URL(url || ""); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } };
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
  const day = plan.schedule[dayIndex] ?? plan.schedule[0];
  return <div className="plan-details">
    <div className="plan-overline"><p>{plan.subtitle}</p>{plan.example && <span className="plan-example-note" title="Bookings, prices, and research are sample data.">Example plan</span>}</div>
    <nav className="plan-detail-tabs" aria-label="Plan details">{["Plan", "Bookings"].map(name => <button key={name} onClick={() => setTab(name)} aria-current={tab === name ? "page" : undefined}>{name}</button>)}</nav>
    {tab === "Plan" && <>
      {day && <section className="plan-itinerary"><div className="plan-section-heading"><h3>{day.date}</h3><div className="plan-days" aria-label="Itinerary day">{plan.schedule.map((entry, index) => <button key={entry.date + entry.day} onClick={() => setDayIndex(index)} aria-pressed={index === dayIndex}>{entry.day.slice(0, 3)}</button>)}</div></div><div className="plan-day-events">{day.events.map((event, i) => <div className="plan-event" key={i}><span>{event.time}</span><div>{event.details?.length ? <details className="plan-timeline-details"><summary><strong>{event.title}</strong></summary>{event.details.map((detail, index) => <p className="plan-timeline-note" key={index}>{detail}</p>)}</details> : <strong>{event.title}</strong>}{event.note && <p className="plan-timeline-note">{event.note}</p>}</div></div>)}</div></section>}
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
      </summary><div className="plan-service-detail"><p className="plan-item-meta">{item.detail}</p>{item.notes.map((note, i) => <p key={i}>{note}</p>)}{item.links?.filter(link => safeUrl(link.url)).map((link, i) => <a className="plan-extra-link" key={i} href={safeUrl(link.url)} target="_blank" rel="noreferrer">{link.label}<ArrowUpRight size={14} aria-hidden="true" /></a>)}</div></details></article>)}</div>
      {!plan.items.length && <p className="plan-empty">Your bookings will appear here.</p>}

    </>}

    {voteLink && tab === "Plan" && <a className="plan-vote-link" href={voteLink}>Group vote</a>}
  </div>;
}

export function EventPlanDetails({ event }: { event: EventDocument }) { return <PlanContent plan={eventView(event)} />; }
export function liveView(state: PlanState): PlanView { return eventView(state.event ?? eventFromPlan(state, "", "legacy")); }
export function LivePlanDetails({ agent }: { agent: string }) {
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [error, setError] = useState(false);
  useAgent<PlanState>({ agent: "plan-agent", name: agent, onStateUpdate: state => { setPlan(state); setError(false); }, onError: () => setError(true), onClose: () => setError(true) });
  useEffect(() => { const timer = setTimeout(() => { if (!plan) setError(true); }, 10000); return () => clearTimeout(timer); }, [plan]);
  if (!plan) return <p className="plan-empty" role="status">{error ? "Couldn’t load this plan. Close it and try again." : "Loading plan…"}</p>;
  return <>{error && <p className="plan-example-note" role="status">Connection interrupted. Showing the last received plan.</p>}<PlanContent plan={liveView(plan)} voteLink={`/w/${encodeURIComponent(agent)}`} /></>;
}
