import { z } from "zod";
import { askJson } from "./llm";
import { LANE_NAMES, laneCatalogue, normaliseLanes, type LaneName } from "./lanes";

/**
 * Stage one of a turn: which lanes (lanes.ts) the specialist runs with.
 *
 * Three sources, cheapest first. A turn woken by a tally or an availability
 * check has a fixed job, so its lanes are decided in code. Anything else is
 * asked of a small triage model call: no tools, a tenth of the specialist's
 * prompt, the last few transcript lines and a one-line catalogue of the
 * lanes. When that call fails or overruns its budget, the turn runs with every
 * lane, which is what the single-agent loop always did; the route event says
 * so, so a slow triage shows up in the run viewer rather than hiding.
 *
 * The harness then overrides what it already knows better than the model: a
 * direct chat mid-onboarding or with an intro to answer always has the people
 * lane, and only a group turn may end silent.
 */
export type RouteSource = "reason" | "triage" | "fallback" | "single";

export type Route = {
  /** Never includes core; systemFor and laneToolNames add it. Empty means core only. */
  lanes: LaneName[];
  source: RouteSource;
  why?: string;
  tokens: number;
  ms: number;
  /** A group turn triage found nothing to do in: no specialist call, end the turn at once. */
  silent: boolean;
};

export type WakeFacts = {
  /** The turn_reason meta: "votes_in", "availability_in" or "". */
  reason: string;
  /** With votes_in: the kind of the lone winner when it came from the trip sources, else undefined. */
  winnerKind?: string;
};

export type ChatFacts = {
  direct: boolean;
  /** Onboarding text is non-empty: the person is still being asked profile questions. */
  onboarding: boolean;
  /** An intro is waiting on this person's yes or no. */
  pendingIntro: boolean;
};

export type TriageInput = {
  direct: boolean;
  /** Last few transcript lines, most recent last. */
  transcript: string;
  plan: string;
  hasCarts: boolean;
  hasItinerary: boolean;
  hasResearch: boolean;
};

const CHOOSABLE = LANE_NAMES.filter((l) => l !== "core") as Exclude<LaneName, "core">[];

/** Lanes a wake reason fixes on its own, or undefined when the message decides. */
export function routeByReason(wake: WakeFacts): LaneName[] | undefined {
  if (wake.reason === "votes_in") return wake.winnerKind ? ["trip"] : ["venues"];
  if (wake.reason === "availability_in") return [];
  return undefined;
}

const TriageAnswer = z.object({
  lanes: z.array(z.string()).describe("Lane names from the catalogue that this turn needs. Empty when nobody addressed the agent."),
  why: z.string().max(200).optional().describe("A few words"),
});

/** The lane names in a triage answer that exist. Undefined when the answer has no usable shape, which means every lane. */
export function parseLanes(value: unknown): LaneName[] | undefined {
  if (!value || typeof value !== "object" || !Array.isArray((value as { lanes?: unknown }).lanes)) return undefined;
  const known = new Set<string>(CHOOSABLE);
  const picked = ((value as { lanes: unknown[] }).lanes.filter((l) => typeof l === "string" && known.has(l)) as LaneName[]);
  return normaliseLanes(picked).filter((l) => l !== "core");
}

/** What the harness knows overrides the model: onboarding and intros need people; only a group may stay silent. */
export function settleRoute(route: Route, chat: ChatFacts): Route {
  let lanes = route.lanes;
  if (chat.direct && (chat.onboarding || chat.pendingIntro) && !lanes.includes("people")) lanes = [...lanes, "people"];
  const silent = route.source === "triage" && lanes.length === 0 && !chat.direct;
  return { ...route, lanes: normaliseLanes(lanes).filter((l) => l !== "core"), silent };
}

export const TRIAGE_BUDGET_MS = 4000;

const TRIAGE_SYSTEM = `You are the triage step for Whim, a planning agent in an iMessage chat. Whim was just woken by the latest message(s) in the transcript (or by answering a question it asked). Your only job is to pick which of Whim's lanes this turn needs, from the catalogue. Pick every lane the latest ask touches: "flights and a hotel, and order balloons" is trip and shop. A vague ask about what to do or where to go is venues. Something about a person's own details, or wanting to be paired up with someone, is people. Talking, thanking, agreeing, small talk, or answering a question Whim asked that needs no tool is no lane at all: return an empty list and Whim will still reply. In a group chat, if the latest messages are people talking among themselves and nobody asked Whim anything, return an empty list too. Never invent lane names.`;

export type Ask = <T>(env: Env, schema: z.ZodType<T>, system: string, user: string) => Promise<{ value: T; tokens: number }>;

/**
 * Decides the lanes for a turn. The wake reason answers at once when it can;
 * otherwise the triage model is asked, racing the budget. Chat facts are
 * applied by the caller through settleRoute once the People lookup is in, so
 * this call can run alongside it.
 */
export async function routeTurn(env: Env, wake: WakeFacts, input: TriageInput, opts: { ask?: Ask; budgetMs?: number } = {}): Promise<Route> {
  const started = Date.now();
  if (env.AGENT_PIPELINE === "single") return { lanes: [...CHOOSABLE], source: "single", tokens: 0, ms: 0, silent: false };
  const fixed = routeByReason(wake);
  if (fixed) return { lanes: fixed, source: "reason", tokens: 0, ms: 0, silent: false };

  const ask = opts.ask ?? askJson;
  const budget = opts.budgetMs ?? TRIAGE_BUDGET_MS;
  const user = JSON.stringify({
    chat: input.direct ? "direct, one to one: every message is for Whim" : "group",
    plan: input.plan,
    shoppingList: input.hasCarts ? "has carts" : "empty",
    itinerary: input.hasItinerary ? "has items" : "empty",
    research: input.hasResearch ? "findings available" : "none",
    lanes: laneCatalogue(),
    transcript: input.transcript,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overran = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budget);
  });
  try {
    const answer = await Promise.race([ask(env, TriageAnswer, TRIAGE_SYSTEM, user), overran]);
    if (answer === "timeout") return { lanes: [...CHOOSABLE], source: "fallback", why: `triage took over ${budget}ms`, tokens: 0, ms: Date.now() - started, silent: false };
    const lanes = parseLanes(answer.value);
    if (!lanes) return { lanes: [...CHOOSABLE], source: "fallback", why: "triage answer had no lanes array", tokens: answer.tokens, ms: Date.now() - started, silent: false };
    return { lanes, source: "triage", why: answer.value.why, tokens: answer.tokens, ms: Date.now() - started, silent: false };
  } catch (err) {
    return { lanes: [...CHOOSABLE], source: "fallback", why: `triage failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), tokens: 0, ms: Date.now() - started, silent: false };
  } finally {
    clearTimeout(timer);
  }
}
