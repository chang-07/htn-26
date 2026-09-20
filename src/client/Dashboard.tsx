import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { EventDocument } from "../shared/events";
import { api, type Account } from "./account-api";
import { type DashboardState, type SavedWidget, type Friend } from "./dashboard-state";
import "./Dashboard.css";
import { EventPlanDetails } from "./PlanDetails";
import { WidgetFlipCard } from "./WidgetFlipCard";
import { EventFlipCard } from "./EventFlipCard";
import { ACCENT_PALETTE } from "../theme";

type Tab = "Plans" | "Widgets" | "Friends" | "Settings";
type Modal = { type: "widget"; widget?: SavedWidget } | { type: "friend"; friend?: Friend } | null;
const TABS: Tab[] = ["Plans", "Widgets", "Friends", "Settings"];
function field(form: FormData, name: string) { return String(form.get(name) ?? "").trim(); }
function readTab(): Tab { const value = location.hash.slice(1); return TABS.find(t => t.toLowerCase() === value) ?? "Plans"; }

function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog className={`dash-dialog${wide ? " plan-dialog" : ""}`} aria-labelledby="dashboard-dialog-title" ref={ref} onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="dash-dialog-head"><h2 id="dashboard-dialog-title">{title}</h2><button aria-label="Close dialog" onClick={onClose} className="dash-icon-button">×</button></div>{children}</dialog>;
}
export function Dashboard({ initialData, initialRevision, initialNotice = "", account, onSignOut }: { initialData: DashboardState; initialRevision: number; initialNotice?: string; account: Account; onSignOut: () => void }) {
  const [tab, setTab] = useState<Tab>(readTab);
  const [data, setData] = useState(initialData);
  const revision = useRef(initialRevision);
  const lastQueued = useRef(initialData);
  const saves = useRef(Promise.resolve());
  const blocked = useRef(false);
  const [saving, setSaving] = useState(false);
  const [events, setEvents] = useState<EventDocument[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [notice, setNotice] = useState(initialNotice);
  const [storageError, setStorageError] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    document.title = "Your workspace — Whim";
    document.documentElement.style.colorScheme = "light";
    document.documentElement.style.background = "#faf9f6";
    const onHash = () => { setTab(readTab()); setSearch(""); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (data === lastQueued.current) return;
    lastQueued.current = data;
    setSaving(true);
    saves.current = saves.current.then(async () => {
      if (blocked.current) { if (lastQueued.current === data) setSaving(false); return; }
      try {
        const result = await api<{ revision: number }>("/api/account/workspace", { method: "PUT", body: JSON.stringify({ accountId: account.id, data, revision: revision.current }) });
        revision.current = result.revision;
        setStorageError("");
      } catch (error) {
        blocked.current = true;
        setStorageError((error instanceof Error ? error.message : "Couldn’t save.") + " Your latest changes are still in this tab.");
      } finally { if (lastQueued.current === data) setSaving(false); }
    });
  }, [data, account.id]);
  useEffect(() => {
    let active = true, running = false;
    async function refresh() {
      if (running) return; running = true;
      try { const result = await api<{ events: EventDocument[] }>("/api/events"); if (active) { setEvents(result.events); setEventsError(""); } }
      catch (error) { if (active) setEventsError(error instanceof Error ? error.message : "Couldn’t load your events."); }
      finally { running = false; if (active) setEventsLoading(false); }
    }
    void refresh(); const timer = setInterval(refresh, 15_000); window.addEventListener("focus", refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  async function signOut() {
    setLoggingOut(true);
    try { await saves.current; await api("/api/account/logout", { method: "POST" }); onSignOut(); }
    catch (error) { setStorageError(error instanceof Error ? error.message : "Couldn’t sign out."); }
    finally { setLoggingOut(false); }
  }
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
  return <div className="dashboard">
    <header className="dash-header"><a className="dash-logo" href="/">whim<span>✳</span></a><button className="dash-avatar" onClick={() => navigate("Settings")} aria-label="Account settings">{data.account.name.trim().charAt(0).toUpperCase() || "You"}</button></header>
    <div className="dash-layout">
      <nav className="dash-tabs" aria-label="Dashboard">{TABS.map(name => <button key={name} onClick={() => navigate(name)} aria-current={tab === name ? "page" : undefined}>{name}</button>)}</nav>
      <main className="dash-main">
      <div className="dash-page-heading"><div><h1>{tab === "Plans" ? "Your plans" : tab === "Widgets" ? "Your widgets" : tab === "Friends" ? "Your people" : "Account settings"}</h1>{tab === "Plans" && <p>Hangouts, parties, and everything your group has planned.</p>}</div>{(tab === "Widgets" || tab === "Friends") && <button className="dash-primary" onClick={() => open(tab === "Widgets" ? { type: "widget" } : { type: "friend" })}>{tab === "Widgets" ? "Create widget" : "Add a friend"}</button>}</div>
      {(notice || storageError) && <p role="status" className={storageError ? "dash-error" : "dash-notice"}>{storageError || notice}</p>}
      {tab !== "Settings" && (tab === "Plans" ? events.length > 6 : tab === "Widgets" ? data.widgets.length > 6 : data.friends.length > 6) && <div className="dash-tools"><input className="dash-search" aria-label={`Search ${tab.toLowerCase()}`} placeholder={`Search ${tab.toLowerCase()}…`} value={search} onChange={e => setSearch(e.target.value)} /></div>}
      {tab === "Plans" && <>
        {eventsError && <p className="dash-error" role="alert">{eventsError}</p>}
        {eventsLoading && <p role="status">Loading your plans…</p>}
        <div className="dash-plan-list">{events.filter(event => matches(event.title + " " + (event.location || ""))).map(event => <EventFlipCard key={event.id} title={event.title} subtitle={[event.location, event.startsAt ? new Date(event.startsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: event.timeZone }) : "From your iMessage group"].filter(Boolean).join(" · ")} label={event.status.charAt(0).toUpperCase() + event.status.slice(1)} image={event.coverUrl} accent={ACCENT_PALETTE.tealSoft}><EventPlanDetails event={event} /></EventFlipCard>)}
        {!eventsLoading && !eventsError && !events.some(event => matches(event.title + " " + (event.location || ""))) && <div className="dash-empty"><h2>{search ? "No matching plans" : "Your next plan goes here."}</h2><p>{search ? "Try another search." : "Ask Whim to plan something in your iMessage group. It’ll appear here automatically."}</p></div>}
        </div>
      </>}
      {tab === "Widgets" && <div className="dash-widget-grid widget-flip-grid">{widgets.map(w => <WidgetFlipCard key={JSON.stringify(w)} widget={w} onEdit={() => open({ type: "widget", widget: w })} />)}{!widgets.length && <div className="dash-empty"><h2>No widgets found</h2><p>Create one or try another search.</p></div>}</div>}
      {tab === "Friends" && <><p className="dash-help">Your notes for planning together. These don’t change anyone else’s account.</p><div className="dash-friend-list">{friends.map(f => <button key={f.id} className="dash-friend" onClick={() => open({ type: "friend", friend: f })}><div><h3>{f.name}</h3><p>{f.food || "No food preferences added"}</p></div><span>{f.budget}</span><small>Edit</small></button>)}{!friends.length && <div className="dash-empty"><h2>{search ? "No matching friends" : "Who do you make plans with?"}</h2><p>Add a friend’s name and preferences to keep them handy.</p></div>}</div></>}
      {tab === "Settings" && <form className="dash-settings" onSubmit={e => { e.preventDefault(); const form = new FormData(e.currentTarget); setData(d => ({ ...d, account: { name: field(form, "name"), city: field(form, "city"), food: field(form, "food"), budget: field(form, "budget") } })); setNotice("Preferences updated."); }}><h2>Your profile</h2><p>Signed in as {account.phone}. Preferences are saved to your account.</p><label>Display name<input name="name" defaultValue={data.account.name} placeholder="Your name" maxLength={80} /></label><label>Home city<input name="city" defaultValue={data.account.city} placeholder="Toronto" maxLength={100} /></label><div className="dash-form-divider" /><h2>Planning preferences</h2><label>Food preferences<input name="food" defaultValue={data.account.food} placeholder="Vegetarian, no peanuts, anything else…" maxLength={300} /></label><label>Usual budget<select name="budget" defaultValue={data.account.budget}><option>Flexible</option><option>Keep it affordable</option><option>Happy to spend a little more</option></select></label><button className="dash-primary" type="submit">Save preferences</button></form>}
    <p className="dash-local-note" role="status">{storageError ? "Changes haven’t been saved." : saving ? "Saving…" : "Saved to your account."}</p>
    {storageError && <button className="dash-text-button" onClick={() => { blocked.current = false; lastQueued.current = initialData; setData(current => ({ ...current })); }}>Retry saving</button>}
    {tab === "Settings" && <button className="dash-text-button" disabled={saving || loggingOut || !!storageError} onClick={signOut}>{loggingOut ? "Signing out…" : "Sign out"}</button>}</main></div>
    {modal && <Dialog title={modal.type === "widget" ? modal.widget ? "Edit widget" : "Create a widget" : modal.friend ? "Friend preferences" : "Add a friend"} onClose={() => setModal(null)}>
      {error && <p className="dash-error" role="alert">{error}</p>}
      {modal.type === "widget" && <form onSubmit={submitWidget}><p>Create a poll or a matching game. Each game answer becomes a pair of tiles.</p><label>Name<input autoFocus name="title" required maxLength={80} defaultValue={modal.widget?.title} placeholder="Friday dinner vote" /></label><label>Type<select name="kind" defaultValue={modal.widget?.kind ?? "Poll"}><option>Poll</option><option>Game</option></select></label><label>Question<input name="question" required maxLength={200} defaultValue={modal.widget?.question} placeholder="What should we eat?" /></label><label>Answers, one per line<textarea name="options" required rows={4} maxLength={1500} defaultValue={modal.widget?.options.join("\n")} placeholder={"Pizza\nRamen\nTacos"} /></label><div className="dash-form-actions"><button className="dash-primary">Save widget</button>{modal.widget && <button type="button" className="dash-text-button" onClick={() => { const original = modal.widget; if (!original) return; setData(d => ({ ...d, widgets: d.widgets.filter(w => w.id !== original.id) })); saved("Widget removed."); }}>Remove widget</button>}</div></form>}
      {modal.type === "friend" && <form onSubmit={submitFriend}><label>Name<input autoFocus name="name" required maxLength={80} defaultValue={modal.friend?.name} placeholder="Friend’s name" /></label><label>Food preferences<input name="food" maxLength={300} defaultValue={modal.friend?.food} placeholder="Vegetarian, favourite cuisines…" /></label><label>Budget<select name="budget" defaultValue={modal.friend?.budget ?? "Flexible"}><option>Flexible</option><option>Keep it affordable</option><option>Happy to spend a little more</option></select></label><div className="dash-form-actions"><button className="dash-primary">Save friend</button>{modal.friend && <button type="button" className="dash-text-button" onClick={() => { const friend = modal.friend; if (!friend) return; setData(d => ({ ...d, friends: d.friends.filter(f => f.id !== friend.id) })); saved("Friend removed."); }}>Remove friend</button>}</div></form>}
    </Dialog>}
  </div>;
}
