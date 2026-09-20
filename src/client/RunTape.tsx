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
  if (e.event === "trace.start" || e.event === "trace.end") {
    const op = String(f.op ?? "");
    return { svc: op.startsWith("gen_ai") ? "model" : op === "browser" || op === "http.client" ? "browser" : "tool", title: String(f.operation ?? "operation"), sub: e.event === "trace.start" ? "started" : String(f.status ?? "completed") };
  }
  if (e.event.startsWith("llm.") || e.event.startsWith("pilot.decision")) return { svc: "model", title: e.event.replaceAll(".", " "), sub: String(f.model ?? f.decision ?? "") };
  if (e.event.startsWith("provider.")) return { svc: "tool", title: "provider response", sub: `${f.provider ?? ""} HTTP ${f.statusCode ?? ""}` };
  if (e.event === "tool") {
    const tool = str(f.tool) ?? "tool";
    return { svc: TOOL_SVC[tool] ?? "tool", title: tool, sub: "tool call" };
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
      asked: ["offer to pay", `${str(f.who) ?? "?"} · ${str(f.source) ?? "text"}`],
      ignored: ["ignored", str(f.reason) ?? ""],
      needs_wallet: ["no wallet", "setup link sent"],
      needs_address: ["address needed", "link sent"],
      started: ["checkout started", f.live === true ? "live" : "dry run"],
      browser: ["browser open", str(f.shop) ?? ""],
      step: ["checkout", str(f.line) ?? ""],
      priced: ["priced", total],
      needs_card: ["card needed", "link sent"],
      needs_approval: ["approval asked", total],
      card_ready: ["card minted", "single use"],
      paying: ["approved", "entering card"],
      submitted: ["pay submitted", total],
      finished: [str(f.status) === "paid" ? "paid" : `ended: ${(str(f.status) ?? "?").replace(/_/g, " ")}`, [total, str(f.confirmation)].filter(Boolean).join(" · ")],
    };
    const [title, sub] = titles[st] ?? [e.event.replace(".", " "), ""];
    return { svc: st === "asked" || st.startsWith("needs_") ? "chat" : "shop", title, sub };
  }
  if (e.event.startsWith("location.")) {
    const st = e.event.slice("location.".length);
    return {
      svc: "chat",
      title: st === "requested" ? "location asked" : st === "taken" ? "city saved" : st === "read" ? "locations read" : "sharing started",
      sub:
        st === "taken" ? (str(f.area) ?? "") :
        st === "requested" ? (str(f.result) ?? "") :
        st === "read" ? `${num(f.sharing) ?? 0} sharing` : `from ${str(f.who) ?? "?"}`,
    };
  }
  if (e.event.startsWith("cart.")) {
    return { svc: "shop", title: e.event.replace(".", " "), sub: str(f.shop) ?? "" };
  }
  switch (e.event) {
    case "message.in": return { svc: "chat", title: "inbound", sub: `from ${str(f.from) ?? "?"}` };
    case "message.stored": return { svc: "chat", title: "stored", sub: "no model call" };
    case "message.out": return { svc: "chat", title: "reply sent", sub: `${num(f.chars) ?? 0} characters` };
    case "ticket.out": return { svc: "chat", title: "card sent", sub: str(f.kind) ?? "" };
    case "card.update": return { svc: "chat", title: "card redrawn", sub: `version ${num(f.version) ?? "?"}` };
    case "vote.cast": return { svc: "chat", title: "vote", sub: `by ${str(f.source) ?? "?"}` };
    case "turn.start": return { svc: "model", title: "turn", sub: str(f.llm) ?? "" };
    case "turn.step": {
      const calls = Array.isArray(f.calls) ? (f.calls as string[]) : [];
      return {
        svc: "model",
        title: `step ${num(f.step) ?? "?"}`,
        sub: calls.length ? `chose ${calls.join(", ")}` : "no tool call",
      };
    }
    case "turn.end": return { svc: "model", title: str(f.outcome) ?? "turn end", sub: `${num(f.steps) ?? 0} model steps` };
    case "run.timeout": return { svc: "model", title: "timed out", sub: str(f.error) ?? "No completion within 30 minutes" };
    case "turn.crashed": return { svc: "model", title: "crashed", sub: str(f.error) ?? "" };
    default: return { svc: e.event.startsWith("turn.") ? "model" : "chat", title: e.event.replace(/\./g, " "), sub: "" };
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

export function toNodes(events: TapeEvent[]): Node[] {
  return events.map((e) => ({
    seq: e.seq, ts: e.ts, level: e.level, event: e.event, fields: Object.fromEntries(Object.entries(e.fields).filter(([k]) => !/^(thinking|reasoning|chain.?of.?thought)$/i.test(k))),
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

  const { blocks, hidden } = useMemo(() => toBlocks(nodes, raw, liveSeq), [nodes, raw, liveSeq]);

  return (
    <div style={{ padding: "6px 0 60px" }}>
      {problem && (
        <p style={{ margin: "0 0 12px 4px", fontFamily: "var(--mono)", fontSize: 12, color: "var(--error)" }}>
          Cart update failed: {problem}
        </p>
      )}

      {blocks.map((b) =>
        b.kind === "head" ? (
          <button
            key={b.id}
            className={`rv-phase${b.pick !== null && picked === b.pick ? " is-selected" : ""}`}
            onClick={() => b.pick !== null && onPick(picked === b.pick ? null : b.pick)}
          >
            <i style={{ width: 8, height: 8, borderRadius: "50%", background: `var(${SERVICES[b.svc].v})`, flex: "none", alignSelf: "center" }} />
            <b>{b.label}</b>
            <span>{b.meta.join("  ·  ")}</span>
          </button>
        ) : b.kind === "pages" ? (
          <Pages key={`p${b.nodes[0].seq}`} nodes={b.nodes} t0={t0} chat={run.chat} picked={picked} onPick={onPick} />
        ) : (
          <Row
            key={b.node.seq}
            node={b.node}
            t0={t0}
            chat={run.chat}
            isNew={running && !fresh.has(b.node.seq)}
            showLive={b.node.seq === liveSeq}
            selected={picked === b.node.seq}
            onPick={() => onPick(picked === b.node.seq ? null : b.node.seq)}
            raw={raw}
            qtyOf={qtyOf}
            dirty={dirty}
            pushing={pushing}
            onStep={(li, by, items) =>
              setEdits((e) => ({ ...e, [`${b.node.seq}:${li}`]: Math.max(0, qtyOf(b.node, li, items) + by) }))
            }
            onPush={(items) => pushCart(b.node, items)}
          />
        ),
      )}
      {hidden > 0 && !running && (
        <p style={{ margin: "18px 0 0 8px", fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--faint)" }}>
          {hidden} low-signal event{hidden === 1 ? "" : "s"} hidden. Toggle Raw to show all.
        </p>
      )}

      {running && <Typing last={nodes[nodes.length - 1]} inTurn={nodes.map((n) => n.event).lastIndexOf("turn.start") > nodes.map((n) => n.event).lastIndexOf("turn.end")} />}
      {!nodes.length && !running && (
        <p style={{ margin: 0, padding: "12px 4px", color: "var(--soft)", fontSize: 13.5 }}>No events.</p>
      )}
    </div>
  );
}

/**
 * The tape, arranged for reading. The event log is flat and says most things
 * twice — the model "chose send_message", the message went out, and the tool
 * call returned are three events for one thing that happened — and one run can
 * hold a turn, the research it started, and the turn that used the findings.
 * So: each act gets a head that carries its totals, rows that only repeat a
 * neighbour are folded, and the pages research read become one contact sheet.
 * Raw turns all of this off and prints the log as it was written.
 */
type Block =
  | { kind: "head"; id: string; svc: ServiceId; label: string; meta: string[]; pick: number | null }
  | { kind: "row"; node: Node }
  | { kind: "pages"; nodes: Node[] };

const ACTS: Record<string, { label: string; svc: ServiceId }> = {
  research: { label: "Research", svc: "browser" },
  booking: { label: "Booking", svc: "booking" },
  pay: { label: "Checkout", svc: "shop" },
};

function toBlocks(nodes: Node[], raw: boolean, liveSeq: number | null): { blocks: Block[]; hidden: number } {
  const blocks: Block[] = [];
  let hidden = 0;
  let turns = 0;
  let inTurn = false;
  let act: string | null = null;

  const folded = (n: Node) =>
    n.seq !== liveSeq && n.level !== "error" && (
      n.event === "presence" || n.event === "turn.start" || n.event === "turn.end" || n.event === "trace.start" ||
      // A step with nothing to say for itself: the tool rows after it are what it chose.
      (n.event === "turn.step" && !str(n.fields.decision)) ||
      // Already on the tape in its own words: the message that went out, the research that started.
      (n.event === "tool" && (n.fields.tool === "send_message" || n.fields.tool === "research")) ||
      // The act's head already carries these totals, and picks this event.
      (n.event === "research.finished" && n.fields.ok !== false)
    );

  nodes.forEach((n, i) => {
    if (n.event === "turn.start") {
      inTurn = true;
      act = null;
      const end = nodes.slice(i + 1).find((x) => x.event === "turn.end" || x.event === "turn.crashed" || x.event === "turn.start");
      const done = end && end.event !== "turn.start" ? end : undefined;
      blocks.push({
        kind: "head", id: `t${n.seq}`, svc: "model", label: `Turn ${++turns}`, pick: done?.seq ?? n.seq,
        meta: [
          str(n.fields.llm),
          done ? (str(done.fields.outcome) ?? "crashed").replace(/_/g, " ") : "running",
          done?.ms != null ? dur(done.ms) : null,
          num(done?.fields.tokens) ? `${num(done?.fields.tokens)!.toLocaleString()} tok` : null,
        ].filter(Boolean) as string[],
      });
    } else if (!inTurn) {
      const key = n.event.split(".")[0];
      if (ACTS[key] && key !== act) {
        act = key;
        const end = nodes.slice(i).find((x) => x.event === `${key}.finished`);
        blocks.push({
          kind: "head", id: `a${n.seq}`, svc: ACTS[key].svc, label: ACTS[key].label, pick: end?.seq ?? null,
          meta: [
            end ? null : "in progress",
            num(end?.fields.pagesRead) != null ? `${num(end?.fields.pagesRead)} pages read` : null,
            num(end?.fields.candidates) != null ? `${num(end?.fields.candidates)} kept` : null,
            str(end?.fields.status)?.replace(/_/g, " "),
            end?.ms != null ? dur(end.ms) : null,
            num(end?.fields.tokens) ? `${num(end?.fields.tokens)!.toLocaleString()} tok` : null,
          ].filter(Boolean) as string[],
        });
      }
    }
    if (n.event === "turn.end" || n.event === "turn.crashed") inTurn = false;

    if (raw) return void blocks.push({ kind: "row", node: n });
    if (folded(n)) return void hidden++;
    const last = blocks[blocks.length - 1];
    if (n.event === "research.read" && str(n.fields.shotId)) {
      if (last?.kind === "pages") last.nodes.push(n);
      else blocks.push({ kind: "pages", nodes: [n] });
    } else blocks.push({ kind: "row", node: n });
  });
  return { blocks, hidden };
}

/**
 * The bottom of a tape that is still printing: the chat's own typing dots, in
 * the ink of whichever service is working, and a guess at what it is doing —
 * read off the last event, since nothing announces the step that is underway.
 */
function Typing({ last, inTurn }: { last?: Node; inTurn: boolean }) {
  const e = last?.event ?? "";
  const [svc, doing]: [ServiceId, string] =
    !last ? ["chat", "starting"] :
    e === "research.browser" || e === "research.read" || e === "research.selected" ? ["browser", "reading pages"] :
    e === "research.planned" ? ["browser", "searching"] :
    e === "research.started" || e === "research.searched" ? ["model", e === "research.started" ? "planning queries" : "selecting pages"] :
    e.startsWith("booking.") ? ["booking", "booking"] :
    e.startsWith("pay.") ? ["shop", "checkout"] :
    e === "message.in" || e === "presence" ? ["model", "starting turn"] :
    inTurn || e === "tool" || e.startsWith("turn.") || e.startsWith("llm.") ? ["model", "thinking"] :
    [last.svc, "working"];
  return (
    <div className="rv-row is-static" role="status" aria-label={`Still running: ${doing}`}>
      <span style={timeStyle} />
      <i className="rv-mark rv-live" style={{ background: `var(${SERVICES[svc].v})` }} />
      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="rv-typing" style={{ color: `var(${SERVICES[svc].v})` }}><i /><i /><i /></span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--soft)" }}>{doing}</span>
      </span>
    </div>
  );
}

/** A capture that failed to load leaves its frame, not a broken-image glyph. */
const hideBroken = (e: React.SyntheticEvent<HTMLImageElement>) => {
  e.currentTarget.style.visibility = "hidden";
};

function Pages({ nodes, t0, chat, picked, onPick }: { nodes: Node[]; t0: number; chat: string; picked: number | null; onPick: (seq: number | null) => void }) {
  const found = nodes.reduce((s, n) => s + (num(n.fields.candidates) ?? 0), 0);
  return (
    <div className="rv-row is-static" style={{ paddingBottom: 12 }}>
      <span style={timeStyle}>+{dur(nodes[0].ts - t0)}</span>
      <i className="rv-mark" style={{ background: "var(--s-browser)" }} title="Browser" />
      <span style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
        <span className="rv-title" style={{ fontFamily: "var(--sans)", fontWeight: 500, fontSize: 13.5, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
          {nodes.length === 1 ? "page read" : `${nodes.length} pages read`}
        </span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--soft)" }}>{found} candidate{found === 1 ? "" : "s"}</span>
      </span>
      <div className="rv-media rv-pages">
        {nodes.map((n) => {
          const c = num(n.fields.candidates) ?? 0;
          return (
            <button
              key={n.seq}
              className={`rv-page${picked === n.seq ? " is-selected" : ""}${c ? "" : " is-empty"}`}
              onClick={() => onPick(picked === n.seq ? null : n.seq)}
              aria-pressed={picked === n.seq}
              title={str(n.fields.url)}
            >
              <span className="rv-thumb"><img src={shotFor(n.fields, chat)} alt="" loading="lazy" onError={hideBroken} /></span>
              <span className="rv-cap"><span>{(str(n.fields.host) ?? "").replace(/^www\./, "")}</span><span>{c}</span></span>
            </button>
          );
        })}
      </div>
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
  const thinking = str(node.fields.decision);
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
        <span className="rv-title" style={{ fontFamily: "var(--sans)", fontWeight: 500, fontSize: 13.5, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>{node.title}</span>
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
          <img src={shot} alt={`What the agent saw at ${node.event}`} loading="lazy" onError={hideBroken} style={{ maxHeight: 260, objectFit: "cover", objectPosition: "top" }} />
        </span>
      )}
      {showLive && (
        <span className="rv-media rv-frame" style={{ maxWidth: 640, borderColor: "var(--ink)" }} onClick={(e) => e.stopPropagation()}>
          <span className="rv-meta" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", color: "var(--ink)" }}>
            <i className="rv-live" style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--s-browser)" }} />
            Live browser
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
      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 8, marginTop: 2, borderTop: "1px solid var(--hair)", ...mono }}>
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
export function StepDetail({ node, t0, chat, onClose, onPrev, onNext }: { node: Node; t0: number; chat: string; onClose?: () => void; onPrev?: () => void; onNext?: () => void }) {
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

  const skip = new Set(["text", "url", "items", "plan", "replays", "replay", "args", "imageUrl", "shotId", "thinking", "decision"]);
  const raw = Object.fromEntries(Object.entries(f).filter(([k]) => !skip.has(k)));

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
      <div style={{ padding: "18px 22px 14px", display: "flex", gap: 12, alignItems: "flex-start", flex: "none" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="rv-meta" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <i style={{ width: 7, height: 7, borderRadius: "50%", background: `var(${svc.v})`, flex: "none" }} />
            <span style={{ color: `var(${svc.v})` }}>{svc.label}</span>
            <span>{node.event}</span>
          </div>
          <h2 style={{ margin: "8px 0 0", fontFamily: "var(--sans)", fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: 1.3, textWrap: "balance" }}>
            {node.title}{node.sub ? <span style={{ fontWeight: 400, color: "var(--soft)" }}> · {node.sub}</span> : null}
          </h2>
          <p style={{ margin: "8px 0 0", fontFamily: "var(--mono)", fontSize: 12, color: "var(--soft)", fontVariantNumeric: "tabular-nums" }}>
            +{dur(node.ts - t0)}{node.ms != null && ` · ${dur(node.ms)}`} · seq {node.seq}
          </p>
        </div>
        {onClose && (
          <span style={{ display: "flex", gap: 6, flex: "none" }}>
            <button className="rv-btn is-quiet" onClick={onPrev} disabled={!onPrev} aria-label="Previous step" title="Previous step (←)">←</button>
            <button className="rv-btn is-quiet" onClick={onNext} disabled={!onNext} aria-label="Next step" title="Next step (→)">→</button>
            <button className="rv-btn is-quiet" onClick={onClose} aria-label="Close" title="Close (Esc)">Close</button>
          </span>
        )}
      </div>
      <hr className="rv-perf" style={{ margin: "0 22px" }} />

      <div style={{ overflowY: "auto", padding: "16px 22px 32px", display: "flex", flexDirection: "column", gap: 20, minHeight: 0 }}>
        {str(f.decision) && (
          <Section label="Decision">
            <p className="rv-quote is-thinking">{str(f.decision)}</p>
          </Section>
        )}
        {str(f.text) && (
          <Section label={node.event === "message.in" ? "Message" : "Sent"}>
            <p className="rv-quote">{str(f.text)}</p>
          </Section>
        )}
        {shot && (
          <Section label="Screenshot">
            <span className="rv-frame"><img src={shot} alt="Page capture" /></span>
          </Section>
        )}
        {plan && (
          <Section label="Queries">
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
          <Section label="Turn">
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
          <Section label="Replay">
            {replays.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer" style={{ fontFamily: "var(--mono)", fontSize: 12, wordBreak: "break-all", display: "block" }}>
                {u}
              </a>
            ))}
          </Section>
        )}
        {Object.keys(raw).length > 0 && <Section label="Fields"><FieldList fields={raw} lines={8} /></Section>}
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
