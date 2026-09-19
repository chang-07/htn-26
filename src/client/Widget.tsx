import { useState } from "react";
import { useAgent } from "agents/react";
import { SLOT_EMOJI, cartsOf, cartsTotal, type PlanState } from "../types";

const STATUS_LABEL: Record<PlanState["status"], string> = {
  idle: "No plan yet",
  voting: "Voting open",
  booking: "Booking…",
  booked: "Booked",
  handoff: "Ready for you to finish",
  failed: "Booking failed",
};

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

  if (!plan) return <p style={{ color: "#9C9CAC" }}>Connecting…</p>;

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

  return (
    <>
      <h1 style={{ fontSize: 28, margin: "0 0 4px" }}>{plan.title || "Plan"}</h1>
      <p style={{ color: "#9C9CAC", marginTop: 0 }}>
        {STATUS_LABEL[plan.status]}
        {plan.awaiting.length ? ` · waiting on ${plan.awaiting.join(", ")}` : ""}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {plan.options.map((o, i) => {
          const won = plan.chosenOptionId === o.id;
          return (
            <button
              key={o.id}
              onClick={() => vote(o.id)}
              disabled={!open}
              style={{
                textAlign: "left",
                padding: 16,
                borderRadius: 16,
                border: `2px solid ${won ? "#3FA971" : mine === o.id ? "#5B5BD6" : "#1E1E26"}`,
                background: won ? "#15301F" : "#15151C",
                color: "inherit",
                font: "inherit",
                cursor: open ? "pointer" : "default",
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                {SLOT_EMOJI[i]} {o.title}
              </div>
              {o.subtitle ? <div style={{ color: "#9C9CAC", fontSize: 14 }}>{o.subtitle}</div> : null}
              <div style={{ color: "#9C9CAC", fontSize: 13, marginTop: 6 }}>
                {plan.counts[o.id] ?? 0} {plan.counts[o.id] === 1 ? "vote" : "votes"}
              </div>
            </button>
          );
        })}
      </div>

      {plan.bookingNote ? <p style={{ color: "#9C9CAC" }}>{plan.bookingNote}</p> : null}

      <ShoppingList plan={plan} />

      {error ? <p style={{ color: "#FF8A8A" }}>{error}</p> : null}
    </>
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
    <section style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 18, margin: "0 0 2px" }}>Shopping list</h2>
      <p style={{ color: "#9C9CAC", margin: "0 0 12px", fontSize: 14 }}>
        {carts.length} {carts.length === 1 ? "store" : "stores"}
        {sum ? ` · ${sum.symbol}${sum.amount.toFixed(2)} total` : ""}
        {unpaid ? ` · ${unpaid} still to pay` : " · all paid"}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {carts.map((cart) => {
          const items = cart.lines.reduce((n, l) => n + l.quantity, 0);
          return (
            <div key={cart.shop} style={{ padding: 16, borderRadius: 16, background: "#15151C", border: `2px solid ${cart.paidBy ? "#3FA971" : "#1E1E26"}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600 }}>
                <span>{cart.shop}</span>
                <span>{cart.total}</span>
              </div>
              <ul style={{ margin: "8px 0 12px", padding: 0, listStyle: "none", color: "#9C9CAC", fontSize: 14 }}>
                {cart.lines.map((l, i) => (
                  <li key={i}>
                    {l.quantity}× {l.title}
                    {l.price ? ` · ${l.price}` : ""}
                  </li>
                ))}
              </ul>
              {cart.paidBy ? (
                <div style={{ color: "#7DE2B0", fontSize: 14, fontWeight: 600 }}>Paid by {cart.paidBy}</div>
              ) : (
                <a
                  href={cart.checkoutUrl}
                  style={{
                    display: "block",
                    padding: 12,
                    borderRadius: 12,
                    background: "#5B5BD6",
                    color: "#fff",
                    textAlign: "center",
                    textDecoration: "none",
                    fontWeight: 600,
                  }}
                >
                  Check out {items} {items === 1 ? "item" : "items"} at {cart.shop}
                </a>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
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
