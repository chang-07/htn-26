/**
 * Once a plan is booked the group chat itself takes its name, an icon and a
 * background — "🍜 Friday dinner · Kinton Ramen" in the thread list instead of
 * three phone numbers. This is the naming: pure, shared, tested on its own.
 * The Linq calls that apply it live in server/linq.ts.
 */
import type { PlanState } from "./types";

export const DEFAULT_EMOJI = "📍";

/**
 * Messages shows about this much of a group name before it is cut off in the
 * thread list; the venue is what gets clipped, never the plan.
 */
const NAME_MAX = 48;

type Named = Pick<PlanState, "title" | "emoji" | "options" | "chosenOptionId">;

const graphemes = (s: string) => Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s), (g) => g.segment);

/**
 * The plan's emoji: the model's, if the first character it gave is one, else
 * the pin. Only the first grapheme is taken, so "🍜 ramen" is "🍜" and a
 * ZWJ sequence such as "🧗‍♀️" stays whole.
 */
export function planEmoji(plan: Pick<PlanState, "emoji">): string {
  const first = graphemes((plan.emoji ?? "").trim())[0];
  return first && /^\p{Extended_Pictographic}/u.test(first) ? first : DEFAULT_EMOJI;
}

/** "🍜 Friday dinner · Kinton Ramen"; the venue is dropped when the title already names it. */
export function groupName(plan: Named): string {
  const winner = plan.options.find((o) => o.id === plan.chosenOptionId)?.title.trim();
  const head = `${planEmoji(plan)} ${plan.title.trim()}`;
  if (!winner || plan.title.toLowerCase().includes(winner.toLowerCase())) return head;
  const room = NAME_MAX - head.length - " · ".length;
  const venue = winner.length > room ? `${winner.slice(0, Math.max(room - 1, 1)).trimEnd()}…` : winner;
  return `${head} · ${venue}`;
}
