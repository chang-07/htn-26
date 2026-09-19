import { useEffect, useState } from "react";
import { useAgent } from "agents/react";
import { PALETTE, TICKET_CSS, TICKET_FONTS } from "../theme";
import { SLOT_EMOJI, cartsOf, cartsTotal, type PlanState } from "../types";
import { fmtMoney, invoiceFor } from "../invoice";

// The same words the ticket image uses, so the page reads as the card opened up.
const STATUS_META: Record<PlanState["status"], string> = {
  idle: "Plan",
  voting: "React to vote",
  booking: "Booking",
  booked: "Confirmed",
  handoff: "Yours to finish",
  failed: "Booking failed",
};

/** Mounts the ticket look once: fonts, stylesheet, and the page ground behind it. */
function useTicketTheme(done: boolean) {
  useEffect(() => {
    if (!document.getElementById("tk-fonts")) {
      const link = Object.assign(document.createElement("link"), { id: "tk-fonts", rel: "stylesheet", href: TICKET_FONTS });
      const style = Object.assign(document.createElement("style"), { id: "tk-css", textContent: TICKET_CSS });
      document.head.appendChild(link);
      document.head.appendChild(style);
    }
    document.documentElement.style.colorScheme = "light";
  }, []);
  useEffect(() => {
    // The ground runs edge to edge, including the overscroll area on a phone.
    document.body.style.background = done ? PALETTE.green : PALETTE.paper;
    document.documentElement.style.background = done ? PALETTE.green : PALETTE.paper;
  }, [done]);
}

/**
 * Live view of one chat's plan. useAgent holds a WebSocket to the PlanAgent
 * Durable Object, so `plan` re-renders the moment anyone votes — from here or
 * from a tapback in the thread — with no polling.
 */
export function Widget({ agentName }: { agentName: string }) {
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [mine, setMine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agent = useAgent<PlanState>({
    agent: "plan-agent",
    name: agentName,
    onStateUpdate: (state) => setPlan(state),
  });

  const done = plan?.status === "booked";
  useTicketTheme(done);
  useEffect(() => {
    document.title = plan?.title ? `${plan.title} — Plan` : "Plan";
  }, [plan?.title]);

  if (!plan) {
    return (
      <div className="tk-page">
        <div className="tk-wrap">
          <div className="tk-meta tk-wait">Opening the plan</div>
          <h1 className="tk-title tk-soft" aria-hidden>Plan</h1>
        </div>
      </div>
    );
  }

  async function vote(optionId: string) {
    setMine(optionId);
    setError(null);
    try {
      await agent.call("vote", [optionId, voterId()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The vote didn't go through. Tap again.");
    }
  }

  const open = plan.status === "voting";
  const votes = Object.values(plan.counts).reduce((a, b) => a + b, 0);
  const lead = Math.max(0, ...Object.values(plan.counts));
  const winner = plan.options.find((o) => o.id === plan.chosenOptionId);

  return (
    <div className={`tk-page${done ? " is-done" : ""}`}>
      <div className="tk-wrap">
        <header className="tk-head">
          <div>
            <div className="tk-meta">{STATUS_META[plan.status]}</div>
            <h1 className="tk-title">{done ? (winner?.title ?? plan.title) : plan.title || "No plan yet"}</h1>
          </div>
          {done ? (
            <div className="tk-stub">
              <b>GO</b>
              <span className="tk-meta">Booked</span>
            </div>
          ) : plan.options.length ? (
            <div className="tk-stub">
              <b>{votes}</b>
              <span className="tk-meta">{votes === 1 ? "vote" : "votes"}</span>
            </div>
          ) : null}
        </header>

        {/* Booked: the ticket's own two facts first, the vote kept below as the record. */}
        {done && (winner?.subtitle || plan.bookingNote) ? (
          <>
            <hr className="tk-perf" />
            <ul className="tk-rows">
              {winner?.subtitle ? <li className="tk-row">{winner.subtitle}</li> : null}
              {plan.bookingNote ? <li className="tk-row">{plan.bookingNote}</li> : null}
            </ul>
          </>
        ) : null}

        {!plan.options.length && plan.status === "idle" ? (
          <p className="tk-lede tk-soft">Nothing to vote on yet. Ask the planner in the chat and the options land here, live.</p>
        ) : null}

        {plan.options.length ? (
          <>
            <hr className="tk-perf" />
            {done ? <div className="tk-meta" style={{ marginBottom: 4 }}>The vote</div> : null}
            <div className="tk-rows">
              {plan.options.map((o, i) => {
                const won = plan.chosenOptionId === o.id;
                const lost = Boolean(plan.chosenOptionId) && !won;
                const count = plan.counts[o.id] ?? 0;
                const leading = open && count > 0 && count === lead;
                return (
                  <button
                    key={o.id}
                    className={`tk-row${mine === o.id ? " is-mine" : ""}${won ? " is-won" : ""}${lost ? " is-dim" : ""}${leading ? " is-lead" : ""}`}
                    onClick={() => vote(o.id)}
                    disabled={!open}
                    aria-pressed={mine === o.id}
                    aria-label={`${o.title}${count ? `, ${count} vote${count === 1 ? "" : "s"}` : ""}${open ? ". Vote for this" : ""}`}
                  >
                    <span className="tk-mark" aria-hidden>{SLOT_EMOJI[i]}</span>
                    <span className="tk-grow">
                      <span className="tk-name">{o.title}</span>
                      {o.subtitle && !(done && won) ? <span className="tk-sub">{o.subtitle}</span> : null}
                      {o.availability ? <span className="tk-sub">{o.availability}</span> : null}
                    </span>
                    <span className="tk-num">{count ? `x${count}` : ""}</span>
                  </button>
                );
              })}
            </div>
            {open ? (
              <p className="tk-small" style={{ margin: "14px 0 0" }}>
                Tap a row to vote here, or tapback the card in the chat with its emoji{waitingLine(plan.awaiting)}
              </p>
            ) : null}
          </>
        ) : null}

        {!done && plan.bookingNote ? (
          <>
            <hr className="tk-perf" />
            <p style={{ margin: 0 }}>{plan.bookingNote}</p>
          </>
        ) : null}

        <ShoppingList plan={plan} />
        <InvoiceSection plan={plan} />

        {error ? <p className="tk-error" role="alert">{error}</p> : null}
      </div>
    </div>
  );
}

/**
 * Every store's order, each with its own checkout: a store can only take
 * payment for its own cart, so there is one button per store, never one for all.
 */
function ShoppingList({ plan }: { plan: PlanState }) {
  const carts = cartsOf(plan);
  if (!carts.length) return null;
  const sum = cartsTotal(carts);
  const unpaid = carts.filter((c) => !c.paidBy).length;

  return (
    <section>
      <hr className="tk-perf" />
      <header className="tk-head">
        <div>
          <div className="tk-meta">Shopping list</div>
          <div style={{ marginTop: 6 }}>
            {carts.length} {carts.length === 1 ? "store" : "stores"}, {unpaid ? `${unpaid} to pay` : "all paid"}
          </div>
        </div>
        {sum ? (
          <div className="tk-stub">
            <b style={{ fontSize: 24 }}>
              {sum.symbol}
              {sum.amount.toFixed(0)}
            </b>
            <span className="tk-meta">total</span>
          </div>
        ) : null}
      </header>

      {carts.map((cart) => {
        const items = cart.lines.reduce((n, l) => n + l.quantity, 0);
        return (
          <div key={cart.shop} style={{ marginTop: 26 }}>
            <div className="tk-meta" style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cart.shop}</span>
              <span style={{ flex: "none" }}>{cart.paidBy ? `paid by ${cart.paidBy}` : cart.total}</span>
            </div>
            <ul className="tk-rows" style={{ marginTop: 6 }}>
              {cart.lines.map((l, i) => (
                <li key={i} className={`tk-row${cart.paidBy ? " is-dim" : ""}`} style={{ fontSize: 15, padding: "5px 0" }}>
                  <span className="tk-mark tk-soft">{l.quantity}x</span>
                  <span className="tk-grow">{l.title}</span>
                  <span className="tk-num">{l.price ?? ""}</span>
                </li>
              ))}
            </ul>
            {cart.paidBy ? null : (
              <a className="tk-action" href={cart.checkoutUrl}>
                Check out {items} {items === 1 ? "item" : "items"} at {cart.shop.replace(/\.[a-z.]+$/, "")}
              </a>
            )}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The running invoice: who paid what and who owes whom, worked out here from
 * the same state the ticket is drawn from, so it is current the moment a cart
 * is paid, an expense is logged or the headcount changes. The carts are
 * itemised in the shopping list above; this section is the balances, the
 * payments that square them, and anything paid outside a cart.
 */
function InvoiceSection({ plan }: { plan: PlanState }) {
  const inv = invoiceFor(cartsOf(plan), plan.expenses ?? [], plan.going ?? []);
  if (!inv.ok) return null;
  const lines = inv.lines.filter((l) => l.paid || l.share);
  if (!lines.length) return null; // nothing paid yet: the shopping list says it all
  const money = (cents: number) => fmtMoney(inv.symbol, cents);
  const square = lines.every((l) => l.net === 0);
  const expenses = inv.entries.filter((e) => e.kind === "expense");

  return (
    <section>
      <hr className="tk-perf" />
      <header className="tk-head">
        <div>
          <div className="tk-meta">{inv.settled ? "Settle up" : "Running tab"}</div>
          <div style={{ marginTop: 6 }}>
            {inv.settled
              ? square
                ? "All square"
                : "Who owes what"
              : `${money(inv.paid)} paid so far, ${inv.unpaid.length} ${inv.unpaid.length === 1 ? "store" : "stores"} left to pay`}
          </div>
        </div>
        <div className="tk-stub">
          <b style={{ fontSize: 24 }}>
            {inv.symbol}
            {Math.round(inv.total / 100)}
          </b>
          <span className="tk-meta">total</span>
        </div>
      </header>

      <ul className="tk-rows" style={{ marginTop: 14 }}>
        {lines.map((l) => (
          <li key={l.name} className={`tk-row${l.net === 0 ? " is-dim" : ""}`}>
            <span className="tk-grow">
              <span className="tk-name">{l.name}</span>
              {l.paid ? <span className="tk-sub">paid {money(l.paid)}</span> : null}
            </span>
            <span className="tk-num">{l.net > 0 ? `gets ${money(l.net)}` : l.net < 0 ? `owes ${money(-l.net)}` : "even"}</span>
          </li>
        ))}
      </ul>

      {inv.transfers.length ? (
        <>
          <div className="tk-meta" style={{ marginTop: 22 }}>
            To settle up
          </div>
          <ul className="tk-rows" style={{ marginTop: 6 }}>
            {inv.transfers.map((t) => (
              <li key={`${t.from}>${t.to}`} className="tk-row" style={{ fontSize: 15, padding: "5px 0" }}>
                <span className="tk-grow">
                  {t.from} → {t.to}
                </span>
                <span className="tk-num">{money(t.amount)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {expenses.length ? (
        <>
          <div className="tk-meta" style={{ marginTop: 22 }}>
            Outside the carts
          </div>
          <ul className="tk-rows" style={{ marginTop: 6 }}>
            {expenses.map((e) => (
              <li key={e.id} className="tk-row" style={{ fontSize: 15, padding: "5px 0" }}>
                <span className="tk-grow">
                  {e.what}
                  <span className="tk-sub">
                    {e.who} paid{e.among.length !== inv.people.length ? ` · for ${e.among.join(", ")}` : ""}
                  </span>
                </span>
                <span className="tk-num">{money(e.amount)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** Names when they are known; a count otherwise. "…0667" is a phone number, not a person. */
function waitingLine(awaiting: string[]) {
  if (!awaiting.length) return ".";
  return awaiting.every((w) => !w.startsWith("…")) ? `. Waiting on ${awaiting.join(", ")}.` : `. Waiting on ${awaiting.length} more.`;
}

/** Stand-in identity for the web fallback: one vote per browser. */
function voterId() {
  const key = "plan-voter";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return "anonymous";
  }
}
