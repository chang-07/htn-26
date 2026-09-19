import { ImageResponse } from "workers-og";
import { SLOT_EMOJI, type PlanState } from "../types";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const STATUS_LABEL: Record<PlanState["status"], string> = {
  idle: "",
  voting: "Voting",
  booking: "Booking…",
  booked: "Booked",
  failed: "Booking failed",
};

/**
 * The card image for `layout.image_url`. Recipients without the Messages
 * extension see only this, so it carries the whole design.
 */
export function renderCard(plan: PlanState): Response {
  const booked = plan.status === "booked";

  // Drawn, not typed: the bundled font has no glyph for "●".
  const dot = `<div style="display:flex;width:18px;height:18px;margin-left:8px;border-radius:9px;background:#7DE2B0;"></div>`;

  const rows = plan.options
    .map((o, i) => {
      const won = plan.chosenOptionId === o.id;
      const count = plan.counts[o.id] ?? 0;
      return `
      <div style="display:flex;align-items:center;padding:22px 28px;margin-top:18px;border-radius:20px;
                  background:${won ? "#15301F" : "#15151C"};border:2px solid ${won ? "#3FA971" : "#15151C"};">
        <div style="display:flex;font-size:40px;margin-right:24px;">${SLOT_EMOJI[i] ?? "•"}</div>
        <div style="display:flex;flex-direction:column;flex:1;">
          <div style="display:flex;font-size:36px;font-weight:600;">${esc(o.title)}</div>
          ${o.subtitle ? `<div style="display:flex;font-size:24px;color:#9C9CAC;">${esc(o.subtitle)}</div>` : ""}
        </div>
        <div style="display:flex;align-items:center;">${dot.repeat(Math.min(count, 8))}</div>
      </div>`;
    })
    .join("");

  const html = `
  <div style="display:flex;flex-direction:column;width:1200px;height:628px;padding:56px 64px;
              background:#0B0B0F;color:#FAFAFA;font-family:sans-serif;">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div style="display:flex;font-size:54px;font-weight:700;">${esc(plan.title || "No plan yet")}</div>
      ${
        STATUS_LABEL[plan.status]
          ? `<div style="display:flex;font-size:26px;padding:10px 22px;border-radius:999px;
                         background:${booked ? "#1B5E3F" : "#1E1E26"};color:${booked ? "#7DE2B0" : "#9C9CAC"};">
               ${STATUS_LABEL[plan.status]}</div>`
          : ""
      }
    </div>
    <div style="display:flex;flex-direction:column;margin-top:24px;">${rows}</div>
  </div>`;

  // Twemoji supplies the tapback emoji as SVG; the default font has none.
  return new ImageResponse(html, { width: 1200, height: 628, emoji: "twemoji" });
}
