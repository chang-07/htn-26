import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RunSummary } from "../server/runs";
import { FieldList, MONO, SERVICES, btn, dur, type ServiceId } from "./ui";

/**
 * A run as a page of cards rather than a timeline.
 *
 * Every event becomes a card belonging to a service — iMessage, the model,
 * tools, the browser, bookings, the shop — carrying whatever that step actually
 * produced: a page capture, the text it sent, the cart it built. Cards wrap like
 * text and the wires carry the order, so the shape of a turn is visible without
 * reading anything, and a long run grows downward instead of off the side.
 *
 * Some cards are editable. A cart's quantities can be changed here and pushed
 * back to the chat, which rewrites the store cart and redraws the card in the
 * thread — see editCart on the agent.
 */

type GraphEvent = { seq: number; ts: number; level: string; event: string; fields: Record<string, unknown> };

type CartItem = { variantId?: string; title: string; quantity: number; price: string; imageUrl?: string };

type Node = {
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

const CARD_W = 236;
const GAP_X = 34;
const GAP_Y = 30;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function classify(e: GraphEvent): { svc: ServiceId; title: string; sub: string } {
  const f = e.fields;
  if (e.event === "tool" || e.event === "tool.failed") {
    const tool = str(f.tool) ?? "tool";
    return { svc: TOOL_SVC[tool] ?? "tool", title: tool, sub: e.event === "tool.failed" ? "failed" : "tool call" };
  }
  if (e.event.startsWith("research.")) {
    const st = e.event.slice("research.".length);
    const sub =
      st === "finished" ? `${num(f.candidates) ?? 0} venues found` :
      st === "read" ? (str(f.host) ?? "") :
      st === "searched" ? `${num(f.hits) ?? 0} results` :
      st === "planned" ? `${num(f.queries) ?? 0} queries written` : (str(f.brief) ?? "");
    return { svc: "browser", title: `research ${st}`, sub };
  }
  if (e.event.startsWith("booking.")) {
    return { svc: "booking", title: e.event.replace(".", " "), sub: str(f.detail) ?? str(f.option) ?? "" };
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
    case "turn.end": return f.outcome === "silent"
      ? "The model had nothing useful to add and stayed quiet."
      : "The turn finished and the agent had spoken.";
    case "research.started": return "Research started in the background. The agent says it is looking, then stops — findings arrive later.";
    case "research.planned": return "The brief became search queries.";
    case "research.searched": return "The queries ran in a real browser.";
    case "research.read": return "The browser opened a result page and pulled candidate venues off it.";
    case "research.finished": return f.ok
      ? "Research returned real venues. Nothing can be proposed that did not come from here."
      : "Research failed, so the agent has nothing it is allowed to propose.";
    case "booking.started": return "A browser session opened to make the reservation for real.";
    case "booking.finished": return f.ok ? "The reservation went through." : "The booking failed, and the agent has to take that back to the group.";
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

export function RunGraph({ run, events, token }: { run: RunSummary; events: GraphEvent[]; token: string }) {
  const nodes = useMemo<Node[]>(
    () => events.map((e) => ({
      seq: e.seq, ts: e.ts, level: e.level, event: e.event, fields: e.fields,
      ms: num(e.fields.ms) ?? null, ...classify(e),
    })),
    [events],
  );

  const [picked, setPicked] = useState<number | null>(null);
  const [cols, setCols] = useState(1);
  const wrap = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<{ x: number; y: number; w: number; h: number; row: number }[]>([]);
  // Quantity edits, keyed by "<seq>:<line>", until they are pushed to the chat.
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    setPicked(null);
    setEdits({});
  }, [run.runId]);

  // How many cards fit across. Everything else follows from it.
  useLayoutEffect(() => {
    const measure = () => {
      const w = (wrap.current?.clientWidth ?? CARD_W) - 48;
      setCols(Math.max(1, Math.floor((w + GAP_X) / (CARD_W + GAP_X))));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  /**
   * Cards wrap like text, left to right and top to bottom. A snaking layout
   * follows the wire more neatly but puts the earliest card of a reversed row
   * on the right, which reads backwards; arrowheads carry direction instead.
   *
   * Heights vary with content, so positions are measured from the DOM after
   * paint rather than guessed.
   */
  const place = useCallback(() => {
    const el = flow.current;
    if (!el) return;
    const cards = [...el.querySelectorAll<HTMLElement>("[data-card]")];
    const next: { x: number; y: number; w: number; h: number; row: number }[] = [];
    let y = 0;
    for (let i = 0; i < cards.length; i += cols) {
      const row = cards.slice(i, i + cols);
      const h = Math.max(...row.map((c) => c.offsetHeight), 0);
      row.forEach((c, ci) => {
        const x = ci * (CARD_W + GAP_X);
        c.style.left = `${x}px`;
        c.style.top = `${y}px`;
        next[i + ci] = { x, y, w: CARD_W, h: c.offsetHeight, row: i / cols };
      });
      y += h + GAP_Y;
    }
    el.style.height = `${Math.max(0, y - GAP_Y)}px`;
    el.style.width = `${cols * CARD_W + (cols - 1) * GAP_X}px`;
    setBoxes(next);
  }, [cols]);

  useLayoutEffect(() => {
    place();
  }, [place, nodes, edits]);

  const wires = useMemo(() => {
    const paths: { d: string; cross: boolean }[] = [];
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1], b = boxes[i];
      if (!a || !b) continue;
      const cross = nodes[i - 1]?.svc !== nodes[i]?.svc;
      if (a.row === b.row) {
        const x1 = a.x + a.w, x2 = b.x;
        const y1 = a.y + a.h / 2, y2 = b.y + b.h / 2;
        const bend = Math.max(16, (x2 - x1) * 0.45);
        paths.push({ d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`, cross });
      } else {
        // Row return: out of the bottom, sweeping back to the top of the next.
        const x1 = a.x + a.w / 2, y1 = a.y + a.h;
        const x2 = b.x + b.w / 2, y2 = b.y;
        const mid = (y1 + y2) / 2;
        paths.push({ d: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`, cross });
      }
    }
    return paths;
  }, [boxes, nodes]);

  const qtyOf = useCallback(
    (n: Node, li: number, items: CartItem[]) => edits[`${n.seq}:${li}`] ?? items[li].quantity,
    [edits],
  );
  const dirty = useCallback(
    (n: Node, items: CartItem[]) => items.some((_, li) => `${n.seq}:${li}` in edits),
    [edits],
  );

  const [problem, setProblem] = useState<string | null>(null);

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
  const pickedNode = picked === null ? null : nodes.find((n) => n.seq === picked) ?? null;

  return (
    <div ref={wrap} style={{ height: "100%", overflow: "auto", padding: "26px 24px 60px", background: "var(--paper)" }}>
      {problem && (
        <p style={{ margin: "0 0 16px", fontFamily: MONO, fontSize: 11, color: "var(--error)" }}>
          Couldn't update the cart: {problem}
        </p>
      )}

      <div ref={flow} style={{ position: "relative", margin: "0 auto" }}>
        <svg style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }} width="100%" height="100%">
          <defs>
            <marker id="rg-tip" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto-start-reverse">
              <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--wire)" />
            </marker>
          </defs>
          {wires.map((w, i) => (
            <path
              key={i}
              d={w.d}
              fill="none"
              stroke="var(--wire)"
              strokeWidth={w.cross ? 1.6 : 1.2}
              strokeDasharray={w.cross ? "4 4" : undefined}
              markerEnd="url(#rg-tip)"
            />
          ))}
        </svg>

        {nodes.map((n, i) => (
          <Card
            key={n.seq}
            node={n}
            t0={t0}
            chat={run.chat}
            turnMs={run.ms}
            live={running && i === nodes.length - 1}
            selected={picked === n.seq}
            onPick={() => setPicked((p) => (p === n.seq ? null : n.seq))}
            qtyOf={qtyOf}
            dirty={dirty}
            pushing={pushing}
            onStep={(li, by, items) =>
              setEdits((e) => ({ ...e, [`${n.seq}:${li}`]: Math.max(0, qtyOf(n, li, items) + by) }))
            }
            onPush={(items) => pushCart(n, items)}
          />
        ))}
      </div>

      {!nodes.length && (
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          {running ? "waiting for the first step…" : "no events recorded for this run"}
        </p>
      )}

      {pickedNode && <Sheet node={pickedNode} t0={t0} chat={run.chat} onClose={() => setPicked(null)} />}
    </div>
  );
}

function Card({
  node, t0, chat, turnMs, live, selected, onPick, qtyOf, dirty, pushing, onStep, onPush,
}: {
  node: Node; t0: number; chat: string; turnMs: number | null; live: boolean; selected: boolean; onPick: () => void;
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
  const share = turnMs && node.ms ? Math.min(1, node.ms / turnMs) : 0;
  const stats = [
    node.ms != null ? dur(node.ms) : null,
    num(node.fields.tokens) ? `${num(node.fields.tokens)!.toLocaleString()} tok` : null,
    num(node.fields.candidates) != null ? `${num(node.fields.candidates)} found` : null,
  ].filter(Boolean);

  const total = items ? items.reduce((s, it, li) => s + qtyOf(node, li, items) * priceNum(it.price), 0) : 0;
  const changed = items ? dirty(node, items) : false;
  const border = selected || live ? "var(--accent)" : node.level === "error" ? "var(--error)" : "var(--rule)";

  return (
    <div
      data-card
      className="rg-card"
      style={{
        position: "absolute", width: CARD_W, background: "var(--card)",
        border: `1px solid ${border}`, borderRadius: 11,
        boxShadow: selected ? "var(--shadow-lift)" : "var(--shadow)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        transition: "box-shadow .18s, border-color .18s, transform .18s",
      }}
    >
      <button
        onClick={onPick}
        style={{ all: "unset", cursor: "pointer", display: "block", font: "inherit" }}
        aria-label={`${node.event} — open details`}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 11px 0", fontFamily: MONO, fontSize: 9, letterSpacing: "0.1em" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5, flex: 1, textTransform: "uppercase", color: `var(${svc.v})` }}>
            <i style={{ width: 7, height: 7, borderRadius: 2, background: `var(${svc.v})`, flex: "none" }} />
            {svc.label}
          </span>
          <span style={{ color: "var(--faint)", fontVariantNumeric: "tabular-nums" }}>+{dur(node.ts - t0)}</span>
        </div>
        <div style={{ padding: "5px 11px 0", fontSize: 14, fontWeight: 600, letterSpacing: "-0.012em", color: "var(--ink)" }}>{node.title}</div>
        <div style={{ padding: "2px 11px 0", fontFamily: MONO, fontSize: 10.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.sub}
        </div>
        {shot && !items && (
          <div style={{ margin: "9px 11px 0", border: "1px solid var(--rule)", borderRadius: 6, overflow: "hidden", height: 92, background: "var(--card-2)" }}>
            <img src={shot} alt={`What the agent saw at ${node.event}`} loading="lazy" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover", objectPosition: "top" }} />
          </div>
        )}
        {text && !items && (
          <p style={{ margin: "9px 11px 0", padding: "8px 10px", background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 10, fontSize: 12, lineHeight: 1.45, color: "var(--ink)" }}>
            {text.length > 96 ? `${text.slice(0, 96)}…` : text}
          </p>
        )}
      </button>

      {items && (
        <CartLines
          node={node} items={items} total={total} changed={changed} pushing={pushing}
          qtyOf={qtyOf} onStep={onStep} onPush={onPush}
        />
      )}

      <div style={{ marginTop: "auto", padding: "9px 11px 10px", display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 9.5, color: "var(--faint)" }}>
        <span style={{ flex: 1, height: 3, borderRadius: 2, background: "var(--rule)", overflow: "hidden" }}>
          <i style={{ display: "block", height: "100%", width: `${Math.round(share * 100)}%`, borderRadius: 2, background: `var(${svc.v})` }} />
        </span>
        {stats.join(" · ")}
      </div>
    </div>
  );
}

/** Quantities are editable on the card itself — no panel, no modal. */
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
  return (
    <>
      <div style={{ padding: "8px 11px 0", display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it, li) => (
          <div key={li} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--ink)" }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
            {editable ? (
              <span style={{ display: "flex", alignItems: "center", gap: 1, border: "1px solid var(--rule)", borderRadius: 6, overflow: "hidden" }}>
                <button className="rg-step" onClick={() => onStep(li, -1, items)} aria-label={`One fewer ${it.title}`} style={stepStyle}>−</button>
                <span style={{ minWidth: 20, textAlign: "center", fontFamily: MONO, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                  {qtyOf(node, li, items)}
                </span>
                <button className="rg-step" onClick={() => onStep(li, 1, items)} aria-label={`One more ${it.title}`} style={stepStyle}>+</button>
              </span>
            ) : (
              <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--muted)" }}>×{it.quantity}</span>
            )}
            <span style={{ fontFamily: MONO, fontSize: 11, minWidth: 50, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
              ${(qtyOf(node, li, items) * priceNum(it.price)).toFixed(2)}
            </span>
          </div>
        ))}
      </div>
      <div style={{ margin: "9px 11px 0", paddingTop: 8, borderTop: "1px solid var(--rule)", display: "flex", alignItems: "center", fontFamily: MONO, fontSize: 11, color: "var(--ink)" }}>
        total <b style={{ marginLeft: "auto", fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>${total.toFixed(2)}</b>
      </div>
      {editable && (
        <div style={{ padding: "9px 11px 0", display: "flex", gap: 6, alignItems: "center" }}>
          {changed && <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--warn)" }}>edited</span>}
          <button
            onClick={() => onPush(items)}
            disabled={!changed || pushing}
            style={{
              ...btn, marginLeft: "auto",
              cursor: changed && !pushing ? "pointer" : "default",
              opacity: changed ? 1 : 0.5,
              ...(changed ? { background: "var(--accent)", borderColor: "var(--accent)", color: "#fff" } : {}),
            }}
          >
            {pushing ? "pushing…" : "push to chat"}
          </button>
        </div>
      )}
    </>
  );
}

const stepStyle: React.CSSProperties = {
  width: 20, height: 20, background: "var(--card-2)", border: 0, cursor: "pointer",
  color: "var(--muted)", fontSize: 13, lineHeight: 1, padding: 0,
};

/** The step's detail, centred over the page. */
function Sheet({ node, t0, chat, onClose }: { node: Node; t0: number; chat: string; onClose: () => void }) {
  const f = node.fields;
  const shot = shotFor(f, chat);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const skip = new Set(["text", "url", "items", "plan", "replays", "replay", "args", "imageUrl", "shotId"]);
  const raw = Object.fromEntries(Object.entries(f).filter(([k]) => !skip.has(k)));

  return (
    <div
      className="rg-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 30, display: "grid", placeItems: "center", padding: "28px 20px", background: "var(--scrim)" }}
    >
      <div
        className="rg-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Step detail"
        style={{
          width: "min(580px, 100%)", maxHeight: "min(82vh, 780px)", background: "var(--card)",
          border: "1px solid var(--rule)", borderRadius: 14, boxShadow: "var(--shadow-lift)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}
      >
        <div style={{ padding: "15px 17px 13px", borderBottom: "1px solid var(--rule)", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--accent)" }}>{node.event}</span>
            <h2 style={{ margin: "4px 0 0", fontSize: 16, fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.35, textWrap: "balance", color: "var(--ink)" }}>
              {describe(node)}
            </h2>
            <span style={{ display: "block", marginTop: 7, fontFamily: MONO, fontSize: 10, color: "var(--faint)" }}>
              +{dur(node.ts - t0)} into the run{node.ms != null && ` · took ${dur(node.ms)}`}
            </span>
          </div>
          <button ref={closeRef} onClick={onClose} style={btn} aria-label="Close">×</button>
        </div>

        <div style={{ overflowY: "auto", padding: "15px 17px 28px", display: "flex", flexDirection: "column", gap: 17 }}>
          {str(f.text) && (
            <Section label={node.event === "message.in" ? "The message" : "What it sent"}>
              <p style={{ margin: 0, background: "var(--card-2)", border: "1px solid var(--rule)", borderRadius: 12, padding: "10px 13px", fontSize: 13.5, lineHeight: 1.5, color: "var(--ink)" }}>
                {str(f.text)}
              </p>
            </Section>
          )}
          {shot && (
            <Section label="What the browser saw">
              <img src={shot} alt="Page capture" style={{ width: "100%", borderRadius: 9, border: "1px solid var(--rule)", display: "block" }} />
            </Section>
          )}
          {plan && (
            <Section label="Queries it wrote">
              <pre style={codeStyle}>{plan.map((q) => `→ ${q}`).join("\n")}</pre>
            </Section>
          )}
          {node.event === "research.finished" && (
            <Section label="Result">
              <Stats pairs={[
                [String(num(f.candidates) ?? 0), "venues"],
                [String(num(f.pagesRead) ?? 0), "pages read"],
                [num(f.ms) != null ? dur(num(f.ms)!) : "—", "wall clock"],
                [num(f.tokens)?.toLocaleString() ?? "—", "tokens"],
              ]} />
            </Section>
          )}
          {node.event === "turn.end" && (
            <Section label="The turn">
              <Stats pairs={[
                [num(f.ms) != null ? dur(num(f.ms)!) : "—", "duration"],
                [String(num(f.steps) ?? 0), "model steps"],
                [num(f.tokens)?.toLocaleString() ?? "—", "tokens"],
                [String(Array.isArray(f.tools) ? (f.tools as string[]).length : 0), "tool calls"],
              ]} />
            </Section>
          )}
          {pretty && <Section label="Arguments"><pre style={codeStyle}>{pretty}</pre></Section>}
          {!!replays.length && (
            <Section label="Session replay">
              {replays.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" style={{ fontFamily: MONO, fontSize: 11, color: "var(--accent)", wordBreak: "break-all", display: "block" }}>
                  {u}
                </a>
              ))}
            </Section>
          )}
          {!!Object.keys(raw).length && <Section label="Raw event"><FieldList fields={raw} lines={6} /></Section>}
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p style={{ margin: "0 0 7px", fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", color: "var(--faint)", textTransform: "uppercase" }}>{label}</p>
      {children}
    </div>
  );
}

function Stats({ pairs }: { pairs: [string, string][] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: "var(--rule)", border: "1px solid var(--rule)", borderRadius: 9, overflow: "hidden" }}>
      {pairs.map(([v, k]) => (
        <div key={k} style={{ background: "var(--card)", padding: "9px 11px" }}>
          <b style={{ display: "block", fontFamily: MONO, fontSize: 14, fontWeight: 500, fontVariantNumeric: "tabular-nums", color: "var(--ink)" }}>{v}</b>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.09em", color: "var(--faint)", textTransform: "uppercase" }}>{k}</span>
        </div>
      ))}
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  margin: 0, padding: "10px 12px", background: "var(--card-2)", border: "1px solid var(--rule)",
  borderRadius: 9, fontFamily: MONO, fontSize: 11, lineHeight: 1.55, color: "var(--muted)",
  whiteSpace: "pre-wrap", wordBreak: "break-word",
};
