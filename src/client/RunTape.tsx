import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunSummary } from "../server/runs";
import { FieldList, SERVICES, dur, type ServiceId } from "./ui";

/**
 * A run as a tape: one row per step, printed top to bottom in the order it
 * happened, the way a till prints a receipt. The margin carries the service
 * mark — iMessage, the model, tools, the browser, bookings, the shop — so the
 * shape of a turn is visible without reading anything, and whatever a step
 * produced (a page capture, the text it sent, the cart it built, the live
 * browser) is printed under its row at a width you can actually read.
 *
 * Some rows are editable. A cart's quantities can be changed here and pushed
 * back to the chat, which rewrites the store cart and redraws the card in the
 * thread — see editCart on the agent.
 *
 * <StepDetail> is the plain-English side of a row: what this kind of step is
 * for and what this one's numbers say. The page puts it beside the tape when
 * there is room and in a sheet when there is not.
 */

export type TapeEvent = { seq: number; ts: number; level: string; event: string; fields: Record<string, unknown> };

type CartItem = { variantId?: string; title: string; quantity: number; price: string; imageUrl?: string };

export type Node = {
  seq: number;
  svc: ServiceId;
  title: string;
  sub: string;
  ts: number;
  ms: number | null;
  level: string;
  event: string;
  fields: Record<string, unknown>;
};

/** Tools that are really a hand-off to another service belong to it. */
const TOOL_SVC: Record<string, ServiceId> = {
  research: "browser",
  book_option: "booking",
  check_availability: "booking",
  shop_search: "shop",
  shop_build_cart: "shop",
  shop_drop_cart: "shop",
};

/** A browser session older than this is long gone, whatever the events say. */
const LIVE_MAX_AGE = 10 * 60 * 1000;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function classify(e: TapeEvent): { svc: ServiceId; title: string; sub: string } {
  const f = e.fields;
  if (e.event === "tool") {
    const tool = str(f.tool) ?? "tool";
    return { svc: TOOL_SVC[tool] ?? "tool", title: tool, sub: TOOL_SVC[tool] ? "handed off" : "tool call" };
  }
  if (e.event.startsWith("research.")) {
    const st = e.event.slice("research.".length);
    // `queries` is the list itself, not a count — reading it as a number showed
    // "0 queries written" on every run that had written some.
    const listLen = (v: unknown) => (Array.isArray(v) ? v.length : num(v) ?? 0);
    if (st === "selected") {
      return {
        svc: "browser",
        title: "pages chosen",
        sub: Array.isArray(f.hosts) ? (f.hosts as string[]).join(", ") : `${num(f.count) ?? 0} pages`,
      };
    }
    if (st === "browser") return { svc: "browser", title: "browser open", sub: str(f.provider) ?? "" };
    const sub =
      st === "finished" ? `${num(f.candidates) ?? 0} venues found` :
      st === "read" ? (str(f.host) ?? "") :
      st === "searched" ? `${num(f.hits) ?? 0} results` :
      st === "planned" ? `${listLen(f.queries)} queries written` : (str(f.brief) ?? "");
    return { svc: "browser", title: `research ${st}`, sub };
  }
  if (e.event.startsWith("booking.")) {
    return { svc: "booking", title: e.event.replace(".", " "), sub: str(f.detail) ?? str(f.option) ?? "" };
  }
  if (e.event.startsWith("pay.")) {
    const st = e.event.slice("pay.".length);
    const total = str(f.total) ?? "";
    const titles: Record<string, [string, string]> = {
      asked: ["offer to pay", `${str(f.who) ?? "someone"}, by ${str(f.source) === "reaction" ? "a thumbs up" : str(f.source) === "resume" ? "picking it back up" : "text"}`],
      ignored: ["ignored", str(f.reason) ?? ""],
      needs_wallet: ["no wallet yet", "told to set up payments"],
      needs_address: ["address asked", "private page sent"],
      started: ["checkout started", f.live === true ? "LIVE: will charge" : "dry run: will not charge"],
      browser: ["browser open", str(f.shop) ?? ""],
      step: ["checkout", str(f.line) ?? ""],
      priced: ["priced", total],
      needs_card: ["card needed", "add-card link sent"],
      needs_approval: ["approval asked", `${total} · passkey link sent`],
      card_ready: ["card minted", "single use, exact amount"],
      paying: ["approved", "typing the card in"],
      submitted: ["PAY PRESSED", total],
      finished: [str(f.status) === "paid" ? "PAID" : `ended: ${(str(f.status) ?? "?").replace(/_/g, " ")}`, [total, str(f.confirmation)].filter(Boolean).join(" · ")],
    };
    const [title, sub] = titles[st] ?? [e.event.replace(".", " "), ""];
    return { svc: st === "asked" || st.startsWith("needs_") ? "chat" : "shop", title, sub };
  }
  if (e.event.startsWith("location.")) {
    const st = e.event.slice("location.".length);
    return {
      svc: "chat",
      title: st === "requested" ? "location asked" : st === "taken" ? "city saved" : "sharing started",
      sub: st === "taken" ? (str(f.area) ?? "") : st === "requested" ? (str(f.result) ?? "") : `from ${str(f.who) ?? "?"}`,
    };
  }
  if (e.event.startsWith("cart.")) {
    return { svc: "shop", title: e.event.replace(".", " "), sub: str(f.shop) ?? "" };
  }
  switch (e.event) {
    case "message.in": return { svc: "chat", title: "inbound", sub: `from ${str(f.from) ?? "?"}` };
    case "message.stored": return { svc: "chat", title: "stored", sub: "not addressed — no model call" };
    case "message.out": return { svc: "chat", title: "reply sent", sub: `${num(f.chars) ?? 0} characters` };
    case "ticket.out": return { svc: "chat", title: "card sent", sub: `${str(f.kind) ?? ""} card, as a photo` };
    case "card.update": return { svc: "chat", title: "card redrawn", sub: `version ${num(f.version) ?? "?"}` };
    case "vote.cast": return { svc: "chat", title: "vote", sub: `by ${str(f.source) ?? "?"}` };
    case "turn.start": return { svc: "model", title: "turn", sub: str(f.llm) ?? "" };
    case "turn.step": {
      const calls = Array.isArray(f.calls) ? (f.calls as string[]) : [];
      return {
        svc: "model",
        title: `step ${num(f.step) ?? "?"}`,
        sub: calls.length ? `chose ${calls.join(", ")}` : str(f.thinking) ? "reasoning, no tool" : "no tool call",
      };
    }
    case "turn.end": return { svc: "model", title: str(f.outcome) ?? "turn end", sub: `${num(f.steps) ?? 0} model steps` };
    case "turn.crashed": return { svc: "model", title: "crashed", sub: str(f.error) ?? "" };
    default: return { svc: e.event.startsWith("turn.") ? "model" : "chat", title: e.event.replace(/\./g, " "), sub: "" };
  }
}

/** One plain sentence: what the agent actually did at this step. */
function describe(n: Node): string {
  const f = n.fields;
  switch (n.event) {
    case "message.in": return "Someone texted the group, and the agent was addressed.";
    case "message.stored": return "Chatter the agent was not addressed in. Stored for context, no model call — it costs nothing.";
    case "message.out": return "The agent texted the group back.";
    case "ticket.out": return "A card went into the thread as a photo, with tapback voting.";
    case "card.update": return "The card was redrawn in place, so the tally updates without a new message.";
    case "turn.start": return "The model woke and read the conversation.";
    case "turn.step": return str(f.thinking)
      ? "One round trip to the model. This is what it was thinking before it acted."
      : "One round trip to the model, which went straight to a tool call without commentary.";
    case "turn.end": return f.outcome === "silent"
      ? "The model had nothing useful to add and stayed quiet."
      : "The turn finished and the agent had spoken.";
    case "pay.asked": return "Someone offered to cover a cart. Who pays is decided by who reacted, never by the model.";
    case "pay.needs_wallet": return "They have no wallet connected, so nothing started. They were told how to set one up.";
    case "pay.needs_address": return "No delivery address on file. A private page was sent; saving it resumes the payment by itself.";
    case "pay.started": return f.live === true ? "A checkout run started with payments LIVE." : "A checkout run started as a dry run: it prices the order and stops before any card exists.";
    case "pay.browser": return "A browser opened the store's own checkout page.";
    case "pay.step": return "The checkout form is filled by rote, with no model involved.";
    case "pay.priced": return "The store priced shipping and tax. This is the real total, read off the page.";
    case "pay.needs_approval": return "The wallet wants the person's passkey before it will mint a card. A link was sent; the run waits up to four minutes.";
    case "pay.needs_card": return "The wallet has no card on file. An add-card link was sent; the run waits.";
    case "pay.card_ready": return "A single-use card was minted for exactly this total at exactly this store. Its number never reaches a log or a model.";
    case "pay.submitted": return "Pay was pressed on the store's checkout. From here the order may exist even if the page never confirms.";
    case "pay.finished": return f.status === "paid" ? "The store confirmed the order." : f.status === "dry_run" ? "Priced and stopped: payments are switched off, so nothing was charged." : "The payment did not go through.";
    case "research.started": return "Research started in the background. The agent says it is looking, then stops — findings arrive later.";
    case "research.planned": return "The brief became search queries.";
    case "research.selected": return "A model picked which search results were worth opening in a browser.";
    case "research.browser": return "A browser session opened. While the run is live you can watch it here.";
    case "research.searched": return "The queries ran in a real browser.";
    case "research.read": return "The browser opened a result page and pulled candidate venues off it.";
    case "research.finished": return f.ok
      ? "Research returned real venues. Nothing can be proposed that did not come from here."
      : "Research failed, so the agent has nothing it is allowed to propose.";
    case "booking.started": return "A browser session opened to make the reservation for real.";
    case "booking.finished": return f.ok ? "The reservation went through." : "The booking failed, and the agent has to take that back to the group.";
    case "location.requested": return "The agent asked this person's phone to share its location, after they agreed to.";
    case "location.sharing_started": return "The person accepted, and Linq reported that sharing began.";
    case "location.taken": return "The agent read the share once, kept only the city, and ended the share.";
    case "cart.updated": return "A cart was built at the store and posted to the chat. The agent cannot pay — a person finishes checkout.";
    case "cart.edited": return "The cart's quantities were changed from this page, and the card in the thread was redrawn.";
    case "tool": return ({
      research: "The model asked for research. It returns at once; the work happens in a workflow.",
      propose_plan: "The model posted options and opened voting.",
      send_message: "One line to the chat. Text only reaches the group through this tool, never from raw model output.",
      get_votes: "The model checked the tally before naming a winner.",
      book_option: "The model asked for a real reservation — allowed at most once per plan.",
      shop_search: "The model searched the store's catalog over UCP. No browser involved.",
      shop_build_cart: "The model built the cart at the store and got back a checkout link.",
    } as Record<string, string>)[str(f.tool) ?? ""] ?? "The model called a tool.";
    default: return "";
  }
}

/**
 * The longer answer, for someone who has not read the code: what this kind of
 * step is for, and what this one's numbers actually say. `describe` is the
 * headline; this is the paragraph under it.
 */
function explain(n: Node): string[] {
  const f = n.fields;
  const out: string[] = [];
  const n_ = (k: string) => num(f[k]);
  const s_ = (k: string) => str(f[k]);

  switch (n.event) {
    case "message.in":
      out.push("The agent only wakes for messages addressed to it — an @mention, a reply to something it said, an answer to a question it just asked, or any message in a one-to-one chat. This one qualified, so a turn was scheduled.");
      if (n_("chars")) out.push(`The message was ${n_("chars")} characters. Phone numbers are masked before anything is written down.`);
      break;
    case "message.stored":
      out.push("Everything said in the chat is stored so the agent has the full conversation when it is finally called on — but storing costs nothing, and no model runs here. This is why a busy group chat does not burn tokens.");
      break;
    case "turn.step":
      out.push("A turn is a loop: the model is called, it either calls tools or stops, and the results go back for another round. This is one pass through that loop.");
      if (Array.isArray(f.calls) && (f.calls as string[]).length) out.push(`It chose to call ${(f.calls as string[]).join(", ")}.`);
      if (s_("thinking")) out.push("The text below is the model's own prose. It never reaches the group — the chat only ever sees what goes through send_message — so it is reasoning rather than a reply.");
      break;
    case "turn.start":
      out.push(`The model was handed the recent transcript, the current plan, anything research has returned, and the list of tools it may call. It then decides, step by step, what to do${s_("llm") ? ` — this turn ran on ${s_("llm")}` : ""}.`);
      if (n_("history")) out.push(`It could see ${n_("history")} earlier messages.`);
      break;
    case "turn.end": {
      const outcome = s_("outcome");
      out.push(
        outcome === "silent" ? "The model looked at the conversation and chose not to speak. In a group chat that is the common and correct outcome."
        : outcome === "max_steps" ? "The model hit its step ceiling before finishing. That usually means it got stuck in a loop of tool calls."
        : outcome === "llm_failed" ? "The model call itself failed — a network or provider problem, not something the model did wrong."
        : "The turn completed and the agent had said its piece.");
      if (n_("steps")) out.push(`It took ${n_("steps")} round trip${n_("steps") === 1 ? "" : "s"} to the model${n_("tokens") ? `, costing ${n_("tokens")!.toLocaleString()} tokens in total` : ""}.`);
      break;
    }
    case "tool": {
      const tool = s_("tool");
      if (tool === "send_message") out.push("Text reaches the group only through this tool, never from the model's raw output — some models leak their reasoning into the reply, and that must not be texted to anyone.");
      else if (tool === "research") out.push("This returns immediately. The real work runs in a separate workflow that can take minutes, and its findings come back later in the chat's history — which is why research steps often appear before the turn that uses them.");
      else if (tool === "propose_plan") out.push("This posts the plan card into the thread and opens voting. People vote with tapbacks on the card, not by replying.");
      else if (tool === "get_votes") out.push("The agent is required to check the tally here rather than guess a winner from the conversation.");
      else if (tool === "book_option") out.push("This drives a real browser at the venue's own site. It is allowed at most once per plan, and it cannot pay for anything.");
      else if (tool?.startsWith("shop")) out.push("The store is called over UCP — plain JSON-RPC over HTTPS, no browser. The agent can build a cart but never completes checkout; a person does that with the link.");
      else out.push("A tool call. Arguments below are exactly what the model sent.");
      break;
    }
    case "research.started":
      out.push("A background workflow opened a real browser. The agent tells the group it is looking and then stops talking — it is not allowed to start a second run while one is in flight, and it may not invent places while waiting.");
      break;
    case "research.planned":
      out.push("The model turned the plain-English brief into search queries. These are the exact strings that were typed into a search engine.");
      break;
    case "research.searched":
      out.push(`The queries ran in the browser and came back with ${n_("hits") ?? 0} result links. Only a few of those get opened — reading a page is the expensive part.`);
      break;
    case "research.selected":
      out.push("Opening a page costs a browser load and a model call, so a model first picks which results are worth it — preferring curated lists and venues' own pages over aggregator landing pages, and avoiding several results from one site.");
      break;
    case "research.browser":
      out.push("Pages are read a tab at a time in one session, all at once rather than one after another, so the model is extracting from one page while the browser loads the next.");
      break;
    case "research.read":
      out.push(`The browser opened ${s_("host") ?? "a page"} and a model read the visible text, pulling out anything that looked like a real venue. It found ${n_("candidates") ?? 0}.`);
      out.push("The capture is what the page looked like when it loaded, so you can tell a good result from a cookie wall or a blocked page.");
      break;
    case "research.finished":
      out.push(`${n_("candidates") ?? 0} venue${n_("candidates") === 1 ? "" : "s"} came back from ${n_("pagesRead") ?? 0} page${n_("pagesRead") === 1 ? "" : "s"}. From here on the agent may only propose places that appear in this list — it cannot make one up.`);
      if (n_("ms")) out.push(`The whole run took ${dur(n_("ms")!)} of wall clock, which is why the turn that asked for it finished long before this arrived.`);
      break;
    case "booking.started":
      out.push("A browser session opened at the venue's own booking page and is being driven step by step. There is a session replay below if you want to watch what it did.");
      break;
    case "booking.finished":
      out.push(f.ok
        ? "The reservation was submitted and confirmed."
        : `It did not get a booking: ${s_("detail") ?? "no reason recorded"}. The agent has to take that back to the group rather than pretend it worked.`);
      out.push("The capture is the last thing the browser saw, which is usually enough to tell whether it got lost or the slot was genuinely unavailable.");
      break;
    case "location.requested":
      out.push("Apple only allows this in a one-to-one iMessage chat, and the person sees a system prompt they have to accept — nothing is readable until they do. The agent only calls this after they have said yes in the conversation.");
      break;
    case "location.sharing_started":
      out.push("This event carries no coordinates, only that sharing began. If it never arrives — an older webhook subscription will not send it — the agent checks on a timer instead.");
      break;
    case "location.taken":
      out.push("Only the city and region were kept, as the person's area, so searches are about the right place. Coordinates and the street address were never stored or logged.");
      out.push(f.shareEnded ? "The share was then ended from the agent's side, so it has no way to look again." : "Ending the share failed, so the person was told how to stop it themselves.");
      break;
    case "cart.updated":
      out.push("The cart was created at the store and a checkout link came back. The agent cannot pay — the card in the chat carries the link so a person finishes it.");
      out.push("Quantities on the tape are editable: changing them rewrites the cart at the store and redraws the card in the thread.");
      break;
    case "cart.edited":
      out.push("Someone changed the quantities from this page rather than through the chat. The store cart was rewritten and the card in the thread redrawn, so the checkout link now points at the new contents.");
      break;
    case "card.update":
      out.push("The card already in the thread was redrawn in place rather than a new one being sent, so the vote tally updates without spamming the chat.");
      break;
    case "ticket.out":
      out.push("Cards are sent as photos, which is why they look designed rather than like a link preview. Voting happens with tapbacks on the photo.");
      break;
    case "message.out":
      out.push(`The agent sent ${n_("chars") ?? 0} characters to the group. It is limited to one message per turn — an earlier version rephrased itself eight times in twenty seconds.`);
      break;
    case "vote.cast":
      out.push(`A vote arrived${s_("source") === "reaction" ? " as a tapback on the card" : " from the vote page"}. The agent will not name a winner until it has checked the tally.`);
      break;
  }
  return out;
}

/** The picture behind a step: a saved browser frame, or a product image. */
function shotFor(fields: Record<string, unknown>, chat: string): string | undefined {
  const id = str(fields.shotId);
  if (id) return `/shot/${encodeURIComponent(chat)}/${id}.jpg`;
  return str(fields.imageUrl);
}

const itemsOf = (fields: Record<string, unknown>): CartItem[] | null =>
  Array.isArray(fields.items) ? (fields.items as CartItem[]) : null;

/** "$32.00" -> 32. Prices arrive already formatted by the store. */
const priceNum = (p: string) => Number(String(p).replace(/[^0-9.]/g, "")) || 0;

export function toNodes(events: TapeEvent[]): Node[] {
  return events.map((e) => ({
    seq: e.seq, ts: e.ts, level: e.level, event: e.event, fields: e.fields,
    ms: num(e.fields.ms) ?? null, ...classify(e),
  }));
}

export function RunTape({
  run, nodes, token, picked, onPick, raw,
}: {
  run: RunSummary;
  nodes: Node[];
  token: string;
  picked: number | null;
  onPick: (seq: number | null) => void;
  /** Print every event's fields under its row, for reading the tape field by field. */
  raw: boolean;
}) {
  // Quantity edits, keyed by "<seq>:<line>", until they are pushed to the chat.
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [pushing, setPushing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setEdits({});
  }, [run.runId]);

  const qtyOf = useCallback(
    (n: Node, li: number, items: CartItem[]) => edits[`${n.seq}:${li}`] ?? items[li].quantity,
    [edits],
  );
  const dirty = useCallback(
    (n: Node, items: CartItem[]) => items.some((_, li) => `${n.seq}:${li}` in edits),
    [edits],
  );

  async function pushCart(n: Node, items: CartItem[]) {
    const lines = items
      .map((it, li) => ({ variantId: it.variantId ?? "", quantity: qtyOf(n, li, items) }))
      .filter((l) => l.variantId);
    setPushing(true);
    setProblem(null);
    try {
      const res = await fetch(`/api/runs/cart${token ? `?token=${encodeURIComponent(token)}` : ""}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat: run.chat, shop: str(n.fields.shop), lines }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string };
      if (!res.ok || !out.ok) throw new Error(out.detail ?? `the server answered ${res.status}`);
      // The edit is the truth now; the agent logs a fresh cart.updated behind it.
      setEdits({});
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  }

  const running = run.ended === null;
  const t0 = nodes[0]?.ts ?? run.started;

  /**
   * Which row, if any, should hold the live browser. The session opens at a
   * `*.browser` step and is closed by the matching `*.finished`, so the view
   * belongs to the browser step for as long as nothing has closed it — not to
   * whichever row happens to be last, which changes every few seconds.
   *
   * Deliberately not tied to the run being open: a research workflow's browser
   * outlives the short run that records its callbacks, so keying off run.ended
   * meant the view never appeared at all. Recency is the guard instead, and
   * /live 404s once nothing is running.
   */
  const liveSeq = useMemo(() => {
    let open: number | null = null;
    let at = 0;
    for (const n of nodes) {
      if (n.fields.live === true) (open = n.seq), (at = n.ts);
      if (n.event === "research.finished" || n.event === "booking.finished") open = null;
    }
    return open !== null && Date.now() - at < LIVE_MAX_AGE ? open : null;
  }, [nodes]);

  // Rows that arrived while watching get one reveal; everything already on the
  // tape when it was opened is simply there.
  const seen = useRef<{ runId: string; seqs: Set<number> } | null>(null);
  if (seen.current?.runId !== run.runId) seen.current = { runId: run.runId, seqs: new Set(running ? [] : nodes.map((n) => n.seq)) };
  const fresh = seen.current.seqs;
  useEffect(() => {
    for (const n of nodes) fresh.add(n.seq);
  });

  return (
    <div style={{ padding: "6px 0 60px" }}>
      {problem && (
        <p style={{ margin: "0 0 12px 4px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--error)" }}>
          Couldn't update the cart: {problem}
        </p>
      )}

      {nodes.map((n) => (
        <Row
          key={n.seq}
          node={n}
          t0={t0}
          chat={run.chat}
          isNew={running && !fresh.has(n.seq)}
          showLive={n.seq === liveSeq}
          selected={picked === n.seq}
          onPick={() => onPick(picked === n.seq ? null : n.seq)}
          raw={raw}
          qtyOf={qtyOf}
          dirty={dirty}
          pushing={pushing}
          onStep={(li, by, items) =>
            setEdits((e) => ({ ...e, [`${n.seq}:${li}`]: Math.max(0, qtyOf(n, li, items) + by) }))
          }
          onPush={(items) => pushCart(n, items)}
        />
      ))}

      {running && (
        <div className="rv-row is-static" aria-live="polite">
          <span style={timeStyle}>…</span>
          <i className="rv-mark rv-live" style={{ background: "var(--soft)" }} />
          <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--soft)" }}>
            {nodes.length ? "still going" : "waiting for the first step"}
          </span>
        </div>
      )}
      {!nodes.length && !running && (
        <p style={{ margin: 0, padding: "12px 4px", color: "var(--soft)", fontSize: 13.5 }}>Nothing was recorded for this run.</p>
      )}
    </div>
  );
}

const timeStyle: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--faint)", fontVariantNumeric: "tabular-nums", textAlign: "right", whiteSpace: "nowrap",
};

function Row({
  node, t0, chat, isNew, showLive, selected, onPick, raw, qtyOf, dirty, pushing, onStep, onPush,
}: {
  node: Node; t0: number; chat: string; isNew: boolean; showLive: boolean; selected: boolean; onPick: () => void; raw: boolean;
  qtyOf: (n: Node, li: number, items: CartItem[]) => number;
  dirty: (n: Node, items: CartItem[]) => boolean;
  pushing: boolean;
  onStep: (li: number, by: number, items: CartItem[]) => void;
  onPush: (items: CartItem[]) => void;
}) {
  const svc = SERVICES[node.svc];
  const shot = shotFor(node.fields, chat);
  const items = itemsOf(node.fields);
  const text = str(node.fields.text);
  const thinking = str(node.fields.thinking);
  const stats = [
    node.ms != null && node.ms > 0 ? dur(node.ms) : null,
    num(node.fields.tokens) ? `${num(node.fields.tokens)!.toLocaleString()} tok` : null,
    num(node.fields.candidates) != null ? `${num(node.fields.candidates)} found` : null,
  ].filter(Boolean);
  const total = items ? items.reduce((s, it, li) => s + qtyOf(node, li, items) * priceNum(it.price), 0) : 0;
  const changed = items ? dirty(node, items) : false;
  const hasMedia = Boolean(shot || showLive || thinking || text || items || raw);

  return (
    <div
      className={`rv-row${selected ? " is-selected" : ""}${node.level === "error" ? " is-error" : ""}${isNew ? " is-new" : ""}`}
      style={{ paddingBottom: hasMedia ? 12 : 9 }}
      data-seq={node.seq}
      onClick={onPick}
    >
      <span style={timeStyle}>+{dur(node.ts - t0)}</span>
      <i className="rv-mark" style={{ background: `var(${svc.v})` }} title={svc.label} />
      <button
        aria-pressed={selected}
        aria-label={`${svc.label}: ${node.title}${node.sub ? `, ${node.sub}` : ""}. Show what this step means`}
        style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0, margin: 0, padding: 0, background: "none", border: 0, cursor: "pointer", font: "inherit", color: "inherit", textAlign: "left" }}
      >
        <span className="rv-title" style={{ fontFamily: "var(--sans)", fontWeight: 600, fontSize: 14.5, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>{node.title}</span>
        {node.sub && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{node.sub}</span>
        )}
        {stats.length > 0 && (
          <span style={{ marginLeft: "auto", paddingLeft: 12, fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
            {stats.join("  ")}
          </span>
        )}
      </button>

      {thinking && (
        <p className="rv-media rv-quote is-thinking">{thinking.length > 280 && !selected ? `${thinking.slice(0, 280)}…` : thinking}</p>
      )}
      {text && !items && <p className="rv-media rv-quote">{text}</p>}
      {shot && !items && (
        <span className="rv-media rv-frame" style={{ maxWidth: 460 }}>
          <img src={shot} alt={`What the agent saw at ${node.event}`} loading="lazy" style={{ maxHeight: 260, objectFit: "cover", objectPosition: "top" }} />
        </span>
      )}
      {showLive && (
        <span className="rv-media rv-frame" style={{ maxWidth: 640, borderColor: "var(--ink)" }} onClick={(e) => e.stopPropagation()}>
          <span className="rv-meta" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", color: "var(--ink)" }}>
            <i className="rv-live" style={{ width: 8, height: 8, background: "var(--s-browser)" }} />
            The agent's browser, live
          </span>
          <iframe
            src={`/live/${encodeURIComponent(chat)}`}
            title="The agent's browser, live"
            style={{ height: 360 }}
            sandbox="allow-scripts allow-same-origin"
          />
        </span>
      )}
      {items && (
        <div className="rv-media" onClick={(e) => e.stopPropagation()}>
          <CartLines
            node={node} items={items} total={total} changed={changed} pushing={pushing}
            qtyOf={qtyOf} onStep={onStep} onPush={onPush}
          />
        </div>
      )}
      {raw && Object.keys(node.fields).length > 0 && (
        <div className="rv-media" onClick={(e) => e.stopPropagation()}>
          <FieldList fields={node.fields} lines={4} />
        </div>
      )}
    </div>
  );
}

/** Quantities are editable on the tape itself — no panel, no modal. */
function CartLines({
  node, items, total, changed, pushing, qtyOf, onStep, onPush,
}: {
  node: Node; items: CartItem[]; total: number; changed: boolean; pushing: boolean;
  qtyOf: (n: Node, li: number, items: CartItem[]) => number;
  onStep: (li: number, by: number, items: CartItem[]) => void;
  onPush: (items: CartItem[]) => void;
}) {
  // Without variant ids the store cannot be told what changed, so the steppers
  // would be decoration. Events recorded before they were logged show counts.
  const editable = items.length > 0 && items.every((it) => it.variantId);
  const mono: React.CSSProperties = { fontFamily: "var(--mono)", fontSize: 12.5, fontVariantNumeric: "tabular-nums" };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0, maxWidth: 460 }}>
      {items.map((it, li) => (
        <div key={li} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: li ? "1px solid var(--hair)" : 0, fontSize: 13.5 }}>
          {it.imageUrl && (
            <img src={it.imageUrl} alt="" loading="lazy" style={{ width: 34, height: 34, objectFit: "cover", flex: "none", background: "var(--paper2)" }} />
          )}
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--sans)" }}>{it.title}</span>
          {editable ? (
            <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button className="rv-step" onClick={() => onStep(li, -1, items)} aria-label={`One fewer ${it.title}`}>−</button>
              <span style={{ ...mono, minWidth: 26, textAlign: "center" }}>{qtyOf(node, li, items)}</span>
              <button className="rv-step" onClick={() => onStep(li, 1, items)} aria-label={`One more ${it.title}`}>+</button>
            </span>
          ) : (
            <span style={{ ...mono, color: "var(--soft)" }}>{it.quantity}×</span>
          )}
          <span style={{ ...mono, minWidth: 64, textAlign: "right" }}>${(qtyOf(node, li, items) * priceNum(it.price)).toFixed(2)}</span>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 8, marginTop: 2, borderTop: "2px dotted var(--rule)", ...mono }}>
        <span className="rv-meta">total</span>
        <b style={{ marginLeft: "auto", fontWeight: 500 }}>${total.toFixed(2)}</b>
      </div>
      {editable && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
          {changed && <span className="rv-meta" style={{ color: "var(--warn)" }}>edited</span>}
          <button className={`rv-btn${changed ? " is-go" : ""}`} onClick={() => onPush(items)} disabled={!changed || pushing} style={{ marginLeft: "auto" }}>
            {pushing ? "Pushing…" : "Push to chat"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The step's plain-English side. Rendered by the page beside the tape, or in a sheet. */
export function StepDetail({ node, t0, chat, onClose }: { node: Node; t0: number; chat: string; onClose?: () => void }) {
  const f = node.fields;
  const shot = shotFor(f, chat);
  const svc = SERVICES[node.svc];

  const replays = Array.isArray(f.replays) ? (f.replays as string[]) : str(f.replay) ? [str(f.replay)!] : [];
  const plan = Array.isArray(f.plan) ? (f.plan as string[]) : null;
  const args = str(f.args);
  let pretty = args;
  if (args) {
    try {
      pretty = JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      /* not JSON; show it as sent */
    }
  }

  const skip = new Set(["text", "url", "items", "plan", "replays", "replay", "args", "imageUrl", "shotId", "thinking"]);
  const raw = Object.fromEntries(Object.entries(f).filter(([k]) => !skip.has(k)));
  const paras = explain(node);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div style={{ padding: "18px 22px 14px", display: "flex", gap: 12, alignItems: "flex-start", flex: "none" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rv-meta" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <i style={{ width: 9, height: 9, background: `var(${svc.v})`, flex: "none" }} />
            <span style={{ color: `var(${svc.v})` }}>{svc.label}</span>
            <span>{node.event}</span>
          </div>
          <h2 style={{ margin: "8px 0 0", fontFamily: "var(--sans)", fontSize: 20, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.15, textWrap: "balance" }}>
            {describe(node) || node.title}
          </h2>
          <p style={{ margin: "8px 0 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--soft)", fontVariantNumeric: "tabular-nums" }}>
            +{dur(node.ts - t0)} into the run{node.ms != null && `, took ${dur(node.ms)}`}
          </p>
        </div>
        {onClose && (
          <button className="rv-btn is-quiet" onClick={onClose} aria-label="Close">Close</button>
        )}
      </div>
      <hr className="rv-perf" style={{ margin: "0 22px" }} />

      <div style={{ overflowY: "auto", padding: "16px 22px 32px", display: "flex", flexDirection: "column", gap: 20, minHeight: 0 }}>
        {paras.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {paras.map((para, i) => (
              <p key={i} style={{ margin: 0, fontFamily: "var(--sans)", fontSize: 14.5, lineHeight: 1.55, maxWidth: "58ch" }}>{para}</p>
            ))}
          </div>
        )}
        {str(f.thinking) && (
          <Section label="What the model was thinking">
            <p className="rv-quote is-thinking">{str(f.thinking)}</p>
          </Section>
        )}
        {str(f.text) && (
          <Section label={node.event === "message.in" ? "The message" : "What it sent"}>
            <p className="rv-quote">{str(f.text)}</p>
          </Section>
        )}
        {shot && (
          <Section label="What the browser saw">
            <span className="rv-frame"><img src={shot} alt="Page capture" /></span>
          </Section>
        )}
        {plan && (
          <Section label="Queries it wrote">
            <pre className="rv-code">{plan.join("\n")}</pre>
          </Section>
        )}
        {node.event === "research.finished" && (
          <Section label="Result">
            <Stats pairs={[
              ["Venues", String(num(f.candidates) ?? 0)],
              ["Pages read", String(num(f.pagesRead) ?? 0)],
              ["Wall clock", num(f.ms) != null ? dur(num(f.ms)!) : "—"],
              ["Tokens", num(f.tokens)?.toLocaleString() ?? "—"],
            ]} />
          </Section>
        )}
        {node.event === "turn.end" && (
          <Section label="The turn">
            <Stats pairs={[
              ["Duration", num(f.ms) != null ? dur(num(f.ms)!) : "—"],
              ["Model steps", String(num(f.steps) ?? 0)],
              ["Tokens", num(f.tokens)?.toLocaleString() ?? "—"],
              ["Tool calls", String(Array.isArray(f.tools) ? (f.tools as string[]).length : 0)],
            ]} />
          </Section>
        )}
        {pretty && <Section label="Arguments"><pre className="rv-code">{pretty}</pre></Section>}
        {replays.length > 0 && (
          <Section label="Session replay">
            {replays.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" style={{ fontFamily: "var(--mono)", fontSize: 12, wordBreak: "break-all", display: "block" }}>
                {u}
              </a>
            ))}
          </Section>
        )}
        {Object.keys(raw).length > 0 && <Section label="Raw event"><FieldList fields={raw} lines={8} /></Section>}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p style={{ margin: "0 0 8px", fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{label}</p>
      {children}
    </div>
  );
}

/** Figures as ticket rows: the label leads, the number sits at the right. */
function Stats({ pairs }: { pairs: [string, string][] }) {
  return (
    <dl style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>
      {pairs.map(([k, v], i) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderTop: i ? "1px solid var(--hair)" : 0 }}>
          <dt style={{ color: "var(--soft)" }}>{k}</dt>
          <dd style={{ margin: 0, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
