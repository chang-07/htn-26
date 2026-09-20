import { z } from "zod";
import { askJson } from "./llm";

/**
 * Generated games. The contract that keeps debugging time near zero:
 * ONE schema (this zod object) is the single source of truth — the LLM's
 * output is parsed against it, the engine state embeds it, and the Swift
 * Codable structs mirror the redacted view of it. Version field from day one.
 */
const TriviaSpecZ = z.object({
  version: z.literal(1),
  kind: z.literal("trivia"),
  title: z.string().min(3).max(60).describe("Short, punchy, names the theme"),
  topic: z.string().max(120),
  questions: z
    .array(
      z.object({
        q: z.string().min(8).max(200),
        options: z.array(z.string().min(1).max(80)).length(4),
        correct: z.number().int().min(0).max(3),
      }),
    )
    .min(4)
    .max(8),
});

const BlackjackSpecZ = z.object({
  version: z.literal(1),
  kind: z.literal("blackjack"),
  title: z.string().min(3).max(60).describe("Table name, can carry the asked-for flavour"),
  topic: z.string().max(120).describe("One line of table flavour"),
  rounds: z.number().int().min(1).max(10),
  startingChips: z.number().int().min(100).max(10000),
});

/** The engine router: every playable thing the generator can produce. */
export const GameSpecZ = z.discriminatedUnion("kind", [TriviaSpecZ, BlackjackSpecZ]);
export type GameSpec = z.infer<typeof GameSpecZ>;
export type TriviaSpec = z.infer<typeof TriviaSpecZ>;
export type BlackjackSpec = z.infer<typeof BlackjackSpecZ>;

/** Everything the engine tracks. Lives in the chat agent's SQLite as JSON. */
export type BjHand = { cards: string[]; done: boolean; bust: boolean };

export type GameState = {
  id: string;
  spec: GameSpec;
  createdBy: string;
  phase: "lobby" | "round" | "reveal" | "done";
  /** 1-based; 0 in the lobby. */
  round: number;
  /** voter id -> display name, in join order. */
  players: Record<string, string>;
  /** trivia: round -> voter id -> chosen option index. */
  answers: Record<string, Record<string, number>>;
  /** trivia: points. blackjack: chips. */
  scores: Record<string, number>;
  /** blackjack only. */
  bj?: { hands: Record<string, BjHand>; dealer: string[] };
  created: number;
};

/** What a phone is allowed to see. The correct answer never leaves the server early. */
export type GameView = {
  id: string;
  kind: GameSpec["kind"];
  title: string;
  topic: string;
  phase: GameState["phase"];
  round: number;
  totalRounds: number;
  players: { name: string; score: number; answered: boolean }[];
  /** trivia round: the question, options, and whether YOU answered. */
  question?: { q: string; options: string[]; myAnswer: number | null };
  /** trivia reveal/done. */
  reveal?: { q: string; options: string[]; correct: number; myAnswer: number | null; gotIt: string[] };
  /** blackjack: your hand and the table, dealer hole card hidden mid-round. */
  bj?: {
    myHand: string[];
    myTotal: number;
    myDone: boolean;
    myBust: boolean;
    dealer: string[];
    dealerTotal: number | null;
    outcomes: { name: string; result: "win" | "lose" | "push" | "blackjack"; delta: number }[] | null;
  };
  joined: boolean;
};

export function newGame(id: string, spec: GameSpec, createdBy: string): GameState {
  return { id, spec, createdBy, phase: "lobby", round: 0, players: {}, answers: {}, scores: {}, created: Date.now() };
}

export function joinGame(g: GameState, voter: string, name: string): GameState {
  if (g.players[voter]) return g;
  const clean = name.trim().slice(0, 20) || `Player ${Object.keys(g.players).length + 1}`;
  const openingScore = g.spec.kind === "blackjack" ? g.spec.startingChips : 0;
  return { ...g, players: { ...g.players, [voter]: clean }, scores: { ...g.scores, [voter]: g.scores[voter] ?? openingScore } };
}

// ------------------------------------------------------------------- trivia

export function answer(g: GameState, voter: string, choice: number): GameState {
  if (g.spec.kind !== "trivia" || g.phase !== "round" || !g.players[voter]) return g;
  if (choice < 0 || choice > 3) return g;
  const r = String(g.round);
  if (g.answers[r]?.[voter] !== undefined) return g; // first answer stands
  return { ...g, answers: { ...g.answers, [r]: { ...(g.answers[r] ?? {}), [voter]: choice } } };
}

// ---------------------------------------------------------------- blackjack

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
const BET = 100;

function freshShoe(): string[] {
  const deck = SUITS.flatMap((su) => RANKS.map((r) => r + su));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function handTotal(cards: string[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    const rank = c.slice(0, -1);
    if (rank === "A") { total += 11; aces++; }
    else if (["K", "Q", "J"].includes(rank)) total += 10;
    else total += Number(rank);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

/** Per-round dealt state lives outside GameState.bj.hands so a redeal is one call. */
type BjRoundOutcome = { name: string; result: "win" | "lose" | "push" | "blackjack"; delta: number };
type BjExtra = { hands: Record<string, BjHand>; dealer: string[]; outcomes?: BjRoundOutcome[] };

function bjDeal(g: GameState): GameState {
  const shoe = freshShoe();
  const hands: Record<string, BjHand> = {};
  for (const voter of Object.keys(g.players)) {
    hands[voter] = { cards: [shoe.pop()!, shoe.pop()!], done: false, bust: false };
  }
  const dealer = [shoe.pop()!, shoe.pop()!];
  // The rest of the shoe rides along in a hidden hand so hits draw from it.
  hands["__shoe"] = { cards: shoe, done: true, bust: false };
  return { ...g, bj: { hands, dealer } };
}

function bjDraw(bj: BjExtra): string {
  const shoe = bj.hands["__shoe"];
  return shoe.cards.pop() ?? freshShoe()[0];
}

function copyBj(bj: NonNullable<GameState["bj"]>): BjExtra {
  return {
    hands: Object.fromEntries(
      Object.entries(bj.hands).map(([voter, hand]) => [voter, { ...hand, cards: [...hand.cards] }]),
    ),
    dealer: [...bj.dealer],
  };
}

export function bjHit(g: GameState, voter: string): GameState {
  if (g.spec.kind !== "blackjack" || g.phase !== "round" || !g.bj) return g;
  const hand = g.bj.hands[voter];
  if (!hand || hand.done || hand.bust) return g;
  const bj = copyBj(g.bj);
  bj.hands[voter].cards.push(bjDraw(bj));
  const total = handTotal(bj.hands[voter].cards);
  if (total > 21) { bj.hands[voter].bust = true; bj.hands[voter].done = true; }
  if (total === 21) bj.hands[voter].done = true;
  return { ...g, bj };
}

export function bjStand(g: GameState, voter: string): GameState {
  if (g.spec.kind !== "blackjack" || g.phase !== "round" || !g.bj) return g;
  const hand = g.bj.hands[voter];
  if (!hand || hand.done) return g;
  return { ...g, bj: { ...g.bj, hands: { ...g.bj.hands, [voter]: { ...hand, done: true } } } };
}

function bjResolve(g: GameState): GameState {
  if (!g.bj) return g;
  const bj = copyBj(g.bj);
  while (handTotal(bj.dealer) < 17) bj.dealer.push(bjDraw(bj));
  const dealerTotal = handTotal(bj.dealer);
  const dealerBust = dealerTotal > 21;
  const scores = { ...g.scores };
  const outcomes: BjRoundOutcome[] = [];
  for (const [voter, name] of Object.entries(g.players)) {
    const hand = bj.hands[voter];
    if (!hand) continue;
    const total = handTotal(hand.cards);
    const natural = hand.cards.length === 2 && total === 21;
    let result: BjRoundOutcome["result"];
    let delta: number;
    if (hand.bust) { result = "lose"; delta = -BET; }
    else if (natural) { result = "blackjack"; delta = Math.round(BET * 1.5); }
    else if (dealerBust || total > dealerTotal) { result = "win"; delta = BET; }
    else if (total === dealerTotal) { result = "push"; delta = 0; }
    else { result = "lose"; delta = -BET; }
    scores[voter] = (scores[voter] ?? 0) + delta;
    outcomes.push({ name, result, delta });
  }
  bj.outcomes = outcomes;
  return { ...g, scores, bj };
}

// ---------------------------------------------------------------- the clock

function totalRounds(spec: GameSpec): number {
  return spec.kind === "trivia" ? spec.questions.length : spec.rounds;
}

export function advance(g: GameState): GameState {
  if (g.phase === "lobby") {
    if (Object.keys(g.players).length === 0) return g;
    const started = { ...g, phase: "round" as const, round: 1 };
    return g.spec.kind === "blackjack" ? bjDeal(started) : started;
  }
  if (g.phase === "round") {
    if (g.spec.kind === "trivia") {
      const q = g.spec.questions[g.round - 1];
      const given = g.answers[String(g.round)] ?? {};
      const scores = { ...g.scores };
      for (const [voter, choice] of Object.entries(given)) {
        if (choice === q.correct) scores[voter] = (scores[voter] ?? 0) + 100;
      }
      return { ...g, phase: "reveal", scores };
    }
    return { ...bjResolve(g), phase: "reveal" };
  }
  if (g.phase === "reveal") {
    if (g.round >= totalRounds(g.spec)) return { ...g, phase: "done" };
    const next = { ...g, phase: "round" as const, round: g.round + 1 };
    return g.spec.kind === "blackjack" ? bjDeal(next) : next;
  }
  return g;
}

/** True when everyone who joined has acted this round (answered, or stood/bust). */
export function roundComplete(g: GameState): boolean {
  if (g.phase !== "round") return false;
  const voters = Object.keys(g.players);
  if (voters.length === 0) return false;
  if (g.spec.kind === "trivia") {
    const given = g.answers[String(g.round)] ?? {};
    return voters.every((v) => given[v] !== undefined);
  }
  return voters.every((v) => g.bj?.hands[v]?.done);
}

export function view(g: GameState, voter: string): GameView {
  const isBj = g.spec.kind === "blackjack";
  const players = Object.entries(g.players).map(([v, name]) => ({
    name,
    score: g.scores[v] ?? 0,
    answered:
      g.phase === "round"
        ? (isBj ? Boolean(g.bj?.hands[v]?.done) : g.answers[String(g.round)]?.[v] !== undefined)
        : false,
  }));
  const out: GameView = {
    id: g.id,
    kind: g.spec.kind,
    title: g.spec.title,
    topic: g.spec.topic,
    phase: g.phase,
    round: g.round,
    totalRounds: totalRounds(g.spec),
    players,
    joined: Boolean(g.players[voter]),
  };

  if (g.spec.kind === "trivia") {
    const spec = g.spec;
    if (g.phase === "round") {
      const q = spec.questions[g.round - 1];
      out.question = { q: q.q, options: q.options, myAnswer: g.answers[String(g.round)]?.[voter] ?? null };
    }
    if (g.phase === "reveal" || g.phase === "done") {
      const idx = Math.max(1, g.round);
      const q = spec.questions[idx - 1];
      const given = g.answers[String(idx)] ?? {};
      out.reveal = {
        q: q.q,
        options: q.options,
        correct: q.correct,
        myAnswer: given[voter] ?? null,
        gotIt: Object.entries(given).filter(([, c]) => c === q.correct).map(([v]) => g.players[v] ?? "?"),
      };
    }
    return out;
  }

  if (g.bj && (g.phase === "round" || g.phase === "reveal" || g.phase === "done")) {
    const mine = g.bj.hands[voter];
    const showAll = g.phase !== "round";
    out.bj = {
      myHand: mine?.cards ?? [],
      myTotal: mine ? handTotal(mine.cards) : 0,
      myDone: mine?.done ?? true,
      myBust: mine?.bust ?? false,
      // Mid-round only the up card shows; the hole card stays server-side.
      dealer: showAll ? g.bj.dealer : [g.bj.dealer[0], "??"],
      dealerTotal: showAll ? handTotal(g.bj.dealer) : null,
      outcomes: showAll ? ((g.bj as unknown as { outcomes?: BjRoundOutcome[] }).outcomes ?? null) : null,
    };
  }
  return out;
}

/**
 * Prompt -> spec, through the same validated-JSON path research uses. A reply
 * that fails the schema is retried once with the error; still bad -> throws,
 * and the caller reports failure instead of storing a broken game.
 */
export async function generateGame(env: Env, topic: string, grounding?: string): Promise<GameSpec> {
  const { value } = await askJson(
    env,
    GameSpecZ,
    `You turn a request into a playable game spec. First PICK THE ENGINE:
- "blackjack", cards, casino, 21, gambling -> kind "blackjack": rounds 3-5, startingChips 500, title and topic carrying whatever flavour they asked for.
- everything else -> kind "trivia".
Trivia rules that decide whether your output is USABLE:
- 5 or 6 questions, each with exactly 4 options and exactly one correct answer (its index in "correct").
- Vary which index is correct; never make the correct option consistently the longest.
- No duplicate questions or options. No "all of the above".
- Questions must be answerable by a general audience unless the topic is niche on purpose.
- version is always 1.`,
    `Topic: ${topic}${grounding ? `\n\nFresh notes from a web search, prefer facts found here:\n${grounding.slice(0, 2000)}` : ""}`,
  );
  return value;
}
