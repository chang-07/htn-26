import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useAgent } from "agents/react";
import type { PlanState } from "../types";
import { DASHBOARD_KEY, readDashboard, type DashboardState, type SavedWidget, type Friend } from "./dashboard-state";
import "./Dashboard.css";
import { ExamplePlanDetails, LivePlanDetails } from "./PlanDetails";
import { WidgetFlipCard } from "./WidgetFlipCard";
import { EventFlipCard } from "./EventFlipCard";

type Tab = "Plans" | "Widgets" | "Friends" | "Settings";
type Modal = { type: "live"; agent: string; title: string } | { type: "sample"; id: string } | { type: "widget"; widget?: SavedWidget } | { type: "friend"; friend?: Friend } | null;
const TABS: Tab[] = ["Plans", "Widgets", "Friends", "Settings"];
const STATUS: Record<string, string> = { idle: "No plan yet", voting: "Voting", booking: "Booking", booked: "Booked", handoff: "Needs your input", failed: "Needs attention" };
const DEMOS = [
  { id: "game-night", title: "Friday game night", group: "The usual crew", label: "Hangout", date: "Sep 25", icon: "", color: "mint" },
  { id: "concert", title: "Calvin Harris at Ushuaïa", group: "Summer trip", label: "Tickets", date: "Sep 25", icon: "♫", color: "peach" },
];
function field(form: FormData, name: string) { return String(form.get(name) ?? "").trim(); }
function readTab(): Tab { const value = location.hash.slice(1); return TABS.find(t => t.toLowerCase() === value) ?? "Plans"; }

function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog className={`dash-dialog${wide ? " plan-dialog" : ""}`} aria-labelledby="dashboard-dialog-title" ref={ref} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="dash-dialog-head"><h2 id="dashboard-dialog-title">{title}</h2><button aria-label="Close dialog" onClick={onClose} className="dash-icon-button">×</button></div>{children}</dialog>;
}
function LinkedPlan({ agent, onRemove, onTitle }: { agent: string; onRemove: () => void; onTitle: (agent: string, title: string) => void }) {
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => { if (plan?.title) onTitle(agent, plan.title); }, [agent, plan?.title, onTitle]);
  useAgent<PlanState>({ agent: "plan-agent", name: agent, onStateUpdate: state => { setPlan(state); setOffline(false); }, onError: () => setOffline(true), onClose: () => setOffline(true) });
  useEffect(() => { const timeout = setTimeout(() => { if (!plan) setOffline(true); }, 10000); return () => clearTimeout(timeout); }, [plan]);
  return <EventFlipCard image={plan?.media?.title === plan?.title && plan?.media?.cover?.generated ? plan?.media?.cover?.url : undefined} title={plan?.title || (offline ? "Plan unavailable" : "Your next plan")} subtitle="From your iMessage group chat" label={offline ? "Offline" : plan ? STATUS[plan.status] ?? plan.status : "Connecting"} accent="#a7efd2"><LivePlanDetails agent={agent} /><button className="dash-text-button" style={{ marginTop: 20 }} onClick={onRemove}>Remove from dashboard</button></EventFlipCard>;
}

export function Dashboard() {
  const [tab, setTab] = useState<Tab>(readTab);
  const [data, setData] = useState<DashboardState>(() => { try { return readDashboard(localStorage.getItem(DASHBOARD_KEY)); } catch { return readDashboard(null); } });
  const [modal, setModal] = useState<Modal>(null);
  const [notice, setNotice] = useState("");
  const [storageError, setStorageError] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [planTitles, setPlanTitles] = useState<Record<string, string>>({});
  const rememberTitle = useCallback((agent: string, title: string) => setPlanTitles(old => old[agent] === title ? old : { ...old, [agent]: title }), []);
  const [planFilter, setPlanFilter] = useState("All plans");
  useEffect(() => {
    document.title = "Your workspace — Whim";
    document.documentElement.style.colorScheme = "light";
    document.documentElement.style.background = "#faf9f6";
    const onHash = () => { setTab(readTab()); setSearch(""); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => { try { localStorage.setItem(DASHBOARD_KEY, JSON.stringify(data)); setStorageError(""); } catch { setStorageError("Your browser couldn’t save these changes. Keep this tab open to retain them."); } }, [data]);
  function navigate(next: Tab) { setTab(next); setSearch(""); setNotice(""); location.hash = next.toLowerCase(); }
  function open(next: Modal) { setError(""); setModal(next); }
  function saved(message: string) { setModal(null); setNotice(message); }
  function submitWidget(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); const options = field(form, "options").split("\n").map(v => v.trim()).filter(Boolean);
    if (field(form, "kind") === "Game" && new Set(options).size > 8) { setError("Use up to eight pairs for a matching game."); return; }
    if (new Set(options).size < 2) { setError("Add at least two different answers, one per line."); return; }
    const old = modal?.type === "widget" ? modal.widget : undefined;
    const widget: SavedWidget = { id: old?.id ?? crypto.randomUUID(), title: field(form, "title"), question: field(form, "question"), kind: field(form, "kind") === "Game" ? "Game" : "Poll", options: [...new Set(options)], sample: false, ...(field(form, "kind") === "Game" ? { game: "memory" as const } : {}) };
    if (!widget.title || !widget.question) { setError("Add a title and a question."); return; }
    setData(d => ({ ...d, widgets: old ? d.widgets.map(w => w.id === old.id ? widget : w) : [...d.widgets, widget] })); saved(old ? "Widget updated." : "Widget created.");
  }
  function submitFriend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = new FormData(e.currentTarget); const old = modal?.type === "friend" ? modal.friend : undefined;
    const friend = { id: old?.id ?? crypto.randomUUID(), name: field(form, "name"), food: field(form, "food"), budget: field(form, "budget") };
    if (!friend.name) { setError("Add your friend’s name."); return; }
    setData(d => ({ ...d, friends: old ? d.friends.map(f => f.id === old.id ? friend : f) : [...d.friends, friend] })); saved("Friend preferences saved.");
  }
  const matches = (value: string) => value.toLowerCase().includes(search.toLowerCase());
  const widgets = data.widgets.filter(w => matches(w.title + " " + w.question));
  const friends = data.friends.filter(f => matches(f.name));
  const samples = DEMOS.filter(p => matches(p.title + " " + p.group));
  return <div className="dashboard">
    <header className="dash-header"><a className="dash-logo" href="/">whim<span>✳</span></a><button className="dash-avatar" onClick={() => navigate("Settings")} aria-label="Account settings">{data.account.name.trim().charAt(0).toUpperCase() || "You"}</button></header>
    <div className="dash-layout">
      <nav className="dash-tabs" aria-label="Dashboard">{TABS.map(name => <button key={name} onClick={() => navigate(name)} aria-current={tab === name ? "page" : undefined}>{name}</button>)}</nav>
      <main className="dash-main">
      <div className="dash-page-heading"><div><h1>{tab === "Plans" ? "Your plans" : tab === "Widgets" ? "Your widgets" : tab === "Friends" ? "Your people" : "Account settings"}</h1>{tab === "Plans" && <p>Hangouts, parties, and everything your group has planned.</p>}</div>{(tab === "Widgets" || tab === "Friends") && <button className="dash-primary" onClick={() => open(tab === "Widgets" ? { type: "widget" } : { type: "friend" })}>{tab === "Widgets" ? "Create widget" : "Add a friend"}</button>}</div>
      {(notice || storageError) && <p role="status" className={storageError ? "dash-error" : "dash-notice"}>{storageError || notice}</p>}
      {tab !== "Settings" && (tab === "Plans" ? data.plans.length > 6 : tab === "Widgets" ? data.widgets.length > 6 : data.friends.length > 6) && <div className="dash-tools">{tab === "Plans" ? <div className="dash-filters" aria-label="Filter plans">{["All plans", "Examples"].map(filter => <button key={filter} aria-pressed={filter === planFilter} onClick={() => setPlanFilter(filter)}>{filter}</button>)}</div> : <span className="dash-count">{tab === "Widgets" ? data.widgets.length + " widgets" : data.friends.length + " friends"}</span>}<input className="dash-search" aria-label={`Search ${tab.toLowerCase()}`} placeholder={`Search ${tab.toLowerCase()}…`} value={search} onChange={e => setSearch(e.target.value)} /></div>}
      {tab === "Plans" && <div className="dash-plan-list">{planFilter !== "Examples" && data.plans.map(plan => <div key={plan.id} hidden={!!search && !matches(plan.agent + " " + (planTitles[plan.agent] ?? ""))}><LinkedPlan agent={plan.agent} onTitle={rememberTitle} onRemove={() => { setData(d => ({ ...d, plans: d.plans.filter(p => p.id !== plan.id) })); setNotice("Plan removed from this dashboard. The group’s plan is unchanged."); }} /></div>)}{samples.map(plan => <EventFlipCard key={plan.id} title={plan.title} subtitle={`${plan.date} · ${plan.group}`} label="Example plan" accent="#c6b8ff" image={plan.id === "concert" ? "/images/20240628_Ushuaia_Calvin_Harris_0049_6000x4000px_-scaled.jpg" : "/images/rooftop-friends.png"}><ExamplePlanDetails id={plan.id} /></EventFlipCard>)}{!samples.length && (planFilter === "Examples" || !data.plans.some(p => matches(p.agent + " " + (planTitles[p.agent] ?? "")))) && <div className="dash-empty"><h2>{search ? "No matching plans" : "Your next plan goes here."}</h2><p>{search ? "Try another search." : "Plans come from Whim in your iMessage group chat."}</p></div>}</div>}
      {tab === "Widgets" && <div className="dash-widget-grid widget-flip-grid">{widgets.map(w => <WidgetFlipCard key={JSON.stringify(w)} widget={w} onEdit={() => open({ type: "widget", widget: w })} />)}{!widgets.length && <div className="dash-empty"><h2>No widgets found</h2><p>Create one or try another search.</p></div>}</div>}
      {tab === "Friends" && <><p className="dash-help">Your notes for planning together. These don’t change anyone else’s account.</p><div className="dash-friend-list">{friends.map(f => <button key={f.id} className="dash-friend" onClick={() => open({ type: "friend", friend: f })}><div><h3>{f.name}</h3><p>{f.food || "No food preferences added"}</p></div><span>{f.budget}</span><small>Edit</small></button>)}{!friends.length && <div className="dash-empty"><h2>{search ? "No matching friends" : "Who do you make plans with?"}</h2><p>Add a friend’s name and preferences to keep them handy.</p></div>}</div></>}
      {tab === "Settings" && <form className="dash-settings" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); setData(d => ({ ...d, account: { name: field(form, "name"), city: field(form, "city"), food: field(form, "food"), budget: field(form, "budget") } })); setNotice("Preferences saved in this browser."); }}><h2>Your profile</h2><p>Preferences for this workspace. Account sync isn’t connected yet.</p><label>Display name<input name="name" defaultValue={data.account.name} placeholder="Your name" maxLength={80} /></label><label>Home city<input name="city" defaultValue={data.account.city} placeholder="Toronto" maxLength={100} /></label><div className="dash-form-divider" /><h2>Planning preferences</h2><label>Food preferences<input name="food" defaultValue={data.account.food} placeholder="Vegetarian, no peanuts, anything else…" maxLength={300} /></label><label>Usual budget<select name="budget" defaultValue={data.account.budget}><option>Flexible</option><option>Keep it affordable</option><option>Happy to spend a little more</option></select></label><button className="dash-primary" type="submit">Save preferences</button></form>}
    <p className="dash-local-note">Saved in this browser.</p></main></div>
    {modal && <Dialog wide={modal.type === "sample" || modal.type === "live"} title={modal.type === "widget" ? modal.widget ? "Edit widget" : "Create a widget" : modal.type === "friend" ? modal.friend ? "Friend preferences" : "Add a friend"  : modal.type === "live" ? modal.title : modal.id === "montreal" ? "Weekend in Montréal" : "Calvin Harris at Ushuaïa"} onClose={() => setModal(null)}>
      {error && <p className="dash-error" role="alert">{error}</p>}
      {modal.type === "widget" && <form onSubmit={submitWidget}><p>Create a poll or a matching game. Each game answer becomes a pair of tiles.</p><label>Name<input autoFocus name="title" required maxLength={80} defaultValue={modal.widget?.title} placeholder="Friday dinner vote" /></label><label>Type<select name="kind" defaultValue={modal.widget?.kind ?? "Poll"}><option>Poll</option><option>Game</option></select></label><label>Question<input name="question" required maxLength={200} defaultValue={modal.widget?.question} placeholder="What should we eat?" /></label><label>Answers, one per line<textarea name="options" required rows={4} maxLength={1500} defaultValue={modal.widget?.options.join("\n")} placeholder={"Pizza\nRamen\nTacos"} /></label><div className="dash-form-actions"><button className="dash-primary">Save widget</button>{modal.widget && <button type="button" className="dash-text-button" onClick={() => { const original = modal.widget; if (!original) return; setData(d => ({ ...d, widgets: d.widgets.filter(w => w.id !== original.id) })); saved("Widget removed."); }}>Remove widget</button>}</div></form>}
      {modal.type === "friend" && <form onSubmit={submitFriend}><label>Name<input autoFocus name="name" required maxLength={80} defaultValue={modal.friend?.name} placeholder="Friend’s name" /></label><label>Food preferences<input name="food" maxLength={300} defaultValue={modal.friend?.food} placeholder="Vegetarian, favourite cuisines…" /></label><label>Budget<select name="budget" defaultValue={modal.friend?.budget ?? "Flexible"}><option>Flexible</option><option>Keep it affordable</option><option>Happy to spend a little more</option></select></label><div className="dash-form-actions"><button className="dash-primary">Save friend</button>{modal.friend && <button type="button" className="dash-text-button" onClick={() => { const friend = modal.friend; if (!friend) return; setData(d => ({ ...d, friends: d.friends.filter(f => f.id !== friend.id) })); saved("Friend removed."); }}>Remove friend</button>}</div></form>}
      {modal.type === "sample" && <ExamplePlanDetails id={modal.id} />}
      {modal.type === "live" && <LivePlanDetails agent={modal.agent} />}
    </Dialog>}
  </div>;
}
