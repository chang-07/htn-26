import { useEffect, useState } from "react";
import { useAgent } from "agents/react";
import { TICKET_CSS, TICKET_FONTS } from "../theme";
import { SLOT_EMOJI, cartsOf, cartsTotal, type PlanState } from "../types";

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
    document.body.style.background = done ? "#1f5f4f" : "#efe7d6";
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

  if (!plan) {
    return (
      <div className="tk-page">
        <div className="tk-wrap tk-meta">Connecting</div>
      </div>
    );
  }

  async function vote(optionId: string) {
    setMine(optionId);
    setError(null);
    try {
      await agent.call("vote", [optionId, voterId()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vote failed");
    }
  }

  const open = plan.status === "voting";
  const votes = Object.values(plan.counts).reduce((a, b) => a + b, 0);

  return (
    <div className={`tk-page${done ? " is-done" : ""}`}>
      <div className="tk-wrap">
        <header className="tk-head">
          <div>
            <div className="tk-meta">{STATUS_META[plan.status]}</div>
            <h1 className="tk-title">{plan.title || "No plan yet"}</h1>
          </div>
          {plan.options.length ? (
            <div className="tk-stub">
              <b>{votes}</b>
              <span className="tk-meta">{votes === 1 ? "vote" : "votes"}</span>
            </div>
          ) : null}
        </header>

        {plan.options.length ? (
          <>
            <hr className="tk-perf" />
            <div className="tk-rows">
              {plan.options.map((o, i) => {
                const won = plan.chosenOptionId === o.id;
                const lost = Boolean(plan.chosenOptionId) && !won;
                const count = plan.counts[o.id] ?? 0;
                return (
                  <button
                    key={o.id}
                    className={`tk-row${mine === o.id ? " is-mine" : ""}${won ? " is-won" : ""}${lost ? " is-dim" : ""}`}
                    onClick={() => vote(o.id)}
                    disabled={!open}
                  >
                    <span className="tk-mark">{SLOT_EMOJI[i]}</span>
                    <span className="tk-grow">
                      <span className="tk-name">{o.title}</span>
                      {o.subtitle ? <span className="tk-sub">{o.subtitle}</span> : null}
                      {o.availability ? <span className="tk-sub">{o.availability}</span> : null}
                    </span>
                    <span className="tk-num">{count ? `x${count}` : ""}</span>
                  </button>
                );
              })}
            </div>
            {open ? (
              <p className="tk-small" style={{ margin: "14px 0 0" }}>
                Tap one to vote{waitingLine(plan.awaiting)}
              </p>
            ) : null}
          </>
        ) : null}

        {plan.bookingNote ? (
          <>
            <hr className="tk-perf" />
            <p style={{ margin: 0 }}>{plan.bookingNote}</p>
          </>
        ) : null}

        <ShoppingList plan={plan} />

        {error ? <p className="tk-error">{error}</p> : null}
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
            <div className="tk-meta" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{cart.shop}</span>
              <span>{cart.paidBy ? `paid by ${cart.paidBy}` : cart.total}</span>
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
                Check out {items} {items === 1 ? "item" : "items"}
              </a>
            )}
          </div>
        );
      })}
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
