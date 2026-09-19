import { useState } from "react";
import { useAgent } from "agents/react";
import { SLOT_EMOJI, type PlanState } from "../types";

const STATUS_LABEL: Record<PlanState["status"], string> = {
  idle: "No plan yet",
  voting: "Voting open",
  booking: "Booking…",
  booked: "Booked",
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

      {plan.cart ? (
        <a
          href={plan.cart.checkoutUrl}
          style={{
            display: "block",
            marginTop: 20,
            padding: 16,
            borderRadius: 16,
            background: "#5B5BD6",
            color: "#fff",
            textAlign: "center",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Check out {plan.cart.lines.reduce((n, l) => n + l.quantity, 0)} items at {plan.cart.shop} · {plan.cart.total}
        </a>
      ) : null}

      {error ? <p style={{ color: "#FF8A8A" }}>{error}</p> : null}
    </>
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
