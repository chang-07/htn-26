import { z } from "zod";
import { askJson } from "./llm";

/**
 * Generated games. The contract that keeps debugging time near zero:
 * ONE schema (this zod object) is the single source of truth — the LLM's
 * output is parsed against it, the engine state embeds it, and the Swift
 * Codable structs mirror the redacted view of it. Version field from day one.
 */
export const GameSpecZ = z.object({
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
export type GameSpec = z.infer<typeof GameSpecZ>;

/** Everything the engine tracks. Lives in the chat agent's SQLite as JSON. */
export type GameState = {
  id: string;
  spec: GameSpec;
  createdBy: string;
  phase: "lobby" | "round" | "reveal" | "done";
  /** 1-based; 0 in the lobby. */
  round: number;
  /** voter id -> display name, in join order. */
  players: Record<string, string>;
  /** round -> voter id -> chosen option index. */
  answers: Record<string, Record<string, number>>;
  scores: Record<string, number>;
  created: number;
};

/** What a phone is allowed to see. The correct answer never leaves the server early. */
export type GameView = {
  id: string;
  title: string;
  topic: string;
  phase: GameState["phase"];
  round: number;
  totalRounds: number;
  players: { name: string; score: number; answered: boolean }[];
  /** Present during a round: the question, options, and whether YOU answered. */
  question?: { q: string; options: string[]; myAnswer: number | null };
  /** Present in reveal/done: last round's truth. */
  reveal?: { q: string; options: string[]; correct: number; myAnswer: number | null; gotIt: string[] };
  joined: boolean;
};

export function newGame(id: string, spec: GameSpec, createdBy: string): GameState {
  return { id, spec, createdBy, phase: "lobby", round: 0, players: {}, answers: {}, scores: {}, created: Date.now() };
}

export function joinGame(g: GameState, voter: string, name: string): GameState {
  if (g.players[voter]) return g;
  const clean = name.trim().slice(0, 20) || `Player ${Object.keys(g.players).length + 1}`;
  return { ...g, players: { ...g.players, [voter]: clean }, scores: { ...g.scores, [voter]: g.scores[voter] ?? 0 } };
}

export function answer(g: GameState, voter: string, choice: number): GameState {
  if (g.phase !== "round" || !g.players[voter]) return g;
  if (choice < 0 || choice > 3) return g;
  const r = String(g.round);
  if (g.answers[r]?.[voter] !== undefined) return g; // first answer stands
  return { ...g, answers: { ...g.answers, [r]: { ...(g.answers[r] ?? {}), [voter]: choice } } };
}

/**
 * Advance the machine: lobby -> round 1 -> reveal -> round 2 -> ... -> done.
 * Scoring happens exactly once, on the round -> reveal edge.
 */
export function advance(g: GameState): GameState {
  if (g.phase === "lobby") {
    return Object.keys(g.players).length > 0 ? { ...g, phase: "round", round: 1 } : g;
  }
  if (g.phase === "round") {
    const q = g.spec.questions[g.round - 1];
    const given = g.answers[String(g.round)] ?? {};
    const scores = { ...g.scores };
    for (const [voter, choice] of Object.entries(given)) {
      if (choice === q.correct) scores[voter] = (scores[voter] ?? 0) + 100;
    }
    return { ...g, phase: "reveal", scores };
  }
  if (g.phase === "reveal") {
    return g.round >= g.spec.questions.length ? { ...g, phase: "done" } : { ...g, phase: "round", round: g.round + 1 };
  }
  return g;
}

/** True when everyone who joined has answered the current round. */
export function roundComplete(g: GameState): boolean {
  if (g.phase !== "round") return false;
  const given = g.answers[String(g.round)] ?? {};
  return Object.keys(g.players).length > 0 && Object.keys(g.players).every((v) => given[v] !== undefined);
}

export function view(g: GameState, voter: string): GameView {
  const players = Object.entries(g.players).map(([v, name]) => ({
    name,
    score: g.scores[v] ?? 0,
    answered: g.phase === "round" ? (g.answers[String(g.round)]?.[v] !== undefined) : false,
  }));
  const out: GameView = {
    id: g.id,
    title: g.spec.title,
    topic: g.spec.topic,
    phase: g.phase,
    round: g.round,
    totalRounds: g.spec.questions.length,
    players,
    joined: Boolean(g.players[voter]),
  };
  if (g.phase === "round") {
    const q = g.spec.questions[g.round - 1];
    out.question = { q: q.q, options: q.options, myAnswer: g.answers[String(g.round)]?.[voter] ?? null };
  }
  if (g.phase === "reveal" || g.phase === "done") {
    const idx = Math.max(1, g.round);
    const q = g.spec.questions[idx - 1];
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

/**
 * Prompt -> spec, through the same validated-JSON path research uses. A reply
 * that fails the schema is retried once with the error; still bad -> throws,
 * and the caller reports failure instead of storing a broken game.
 */
export async function generateGame(env: Env, topic: string, grounding?: string): Promise<GameSpec> {
  const { value } = await askJson(
    env,
    GameSpecZ,
    `You write pub-trivia packs. Rules that decide whether your output is USABLE:
- 5 or 6 questions, each with exactly 4 options and exactly one correct answer (its index in "correct").
- Vary which index is correct; never make the correct option consistently the longest.
- No duplicate questions or options. No "all of the above".
- Questions must be answerable by a general audience unless the topic is niche on purpose.
- version is 1, kind is "trivia".`,
    `Topic: ${topic}${grounding ? `\n\nFresh notes from a web search, prefer facts found here:\n${grounding.slice(0, 2000)}` : ""}`,
  );
  return value;
}
