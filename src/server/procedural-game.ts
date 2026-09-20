import { z } from "zod";

const VisualTokensZ = z.object({
  mood: z.enum(["bright", "electric", "midnight"]),
  accent: z.enum(["mint", "coral", "violet"]),
  icon: z.enum(["spark", "bird", "bolt", "star"]),
}).strict();

const ChoiceZ = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  text: z.string().trim().min(1).max(120),
}).strict();

const ChoiceRoundZ = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  prompt: z.string().trim().min(1).max(240),
  choices: z.array(ChoiceZ).min(2).max(4),
  correctId: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).optional(),
}).strict();

export const ChoiceRoundsDefinitionZ = z.object({
  version: z.literal(1),
  surface: z.literal("choice_rounds"),
  title: z.string().trim().min(3).max(60),
  topic: z.string().trim().min(1).max(120),
  visual: VisualTokensZ,
  scoring: z.enum(["correct", "plurality"]),
  rounds: z.array(ChoiceRoundZ).min(1).max(8),
}).strict().superRefine((definition, ctx) => {
  const roundIds = new Set<string>();
  definition.rounds.forEach((round, roundIndex) => {
    if (roundIds.has(round.id)) ctx.addIssue({ code: "custom", path: ["rounds", roundIndex, "id"], message: "Round ids must be unique" });
    roundIds.add(round.id);
    const choiceIds = new Set(round.choices.map((choice) => choice.id));
    if (choiceIds.size !== round.choices.length) ctx.addIssue({ code: "custom", path: ["rounds", roundIndex, "choices"], message: "Choice ids must be unique" });
    if (definition.scoring === "correct" && !round.correctId) {
      ctx.addIssue({ code: "custom", path: ["rounds", roundIndex, "correctId"], message: "Correct scoring requires a correct choice" });
    }
    if (definition.scoring === "plurality" && round.correctId) {
      ctx.addIssue({ code: "custom", path: ["rounds", roundIndex, "correctId"], message: "Plurality scoring cannot declare a correct choice" });
    }
    if (round.correctId && !choiceIds.has(round.correctId)) {
      ctx.addIssue({ code: "custom", path: ["rounds", roundIndex, "correctId"], message: "Correct choice must be registered" });
    }
  });
});

export const TapDodgeDefinitionZ = z.object({
  version: z.literal(1),
  surface: z.literal("tap_dodge"),
  title: z.string().trim().min(3).max(60),
  topic: z.string().trim().min(1).max(120),
  visual: VisualTokensZ,
  seed: z.number().int().min(0).max(0x7fffffff),
  durationMs: z.number().int().min(10_000).max(45_000),
  obstacleIntervalMs: z.number().int().min(500).max(5_000),
  obstacleSpeed: z.number().int().min(160).max(480),
  gapSize: z.number().int().min(220).max(560),
}).strict();

export const ProceduralDefinitionZ = z.union([ChoiceRoundsDefinitionZ, TapDodgeDefinitionZ]);
export type ChoiceRoundsDefinition = z.infer<typeof ChoiceRoundsDefinitionZ>;
export type TapDodgeDefinition = z.infer<typeof TapDodgeDefinitionZ>;
export type ProceduralDefinition = z.infer<typeof ProceduralDefinitionZ>;

export type ProceduralPhase = "lobby" | "round" | "reveal" | "done";
export type ProceduralGameState = {
  type: "procedural";
  id: string;
  spec: ProceduralDefinition;
  createdBy: string;
  phase: ProceduralPhase;
  round: number;
  players: Record<string, string>;
  choices: Record<string, Record<string, string>>;
  scores: Record<string, number>;
  tapResult?: TapResult;
  created: number;
};

export type TapResult = { score: number; terminalReason: "collision" | "time" };
export type ProceduralAction =
  | { type: "join"; name: string }
  | { type: "choose"; choiceId: string }
  | { type: "advance" }
  | { type: "tap_replay"; tapMs: number[] };

export type ProceduralGameView = {
  gameType: "procedural";
  id: string;
  surface: ProceduralDefinition["surface"];
  title: string;
  topic: string;
  phase: ProceduralPhase;
  round: number;
  totalRounds: number;
  players: { name: string; score: number; chosen: boolean }[];
  choiceRound?: { prompt: string; choices: { id: string; text: string }[]; myChoice: string | null; correctId?: string };
  tapDodge?: Omit<TapDodgeDefinition, "version" | "surface" | "title" | "topic" | "visual"> & { result?: TapResult };
};

export const isProceduralGame = (value: unknown): value is ProceduralGameState =>
  !!value && typeof value === "object" && (value as { type?: unknown }).type === "procedural";

export function newProceduralGame(id: string, spec: ProceduralDefinition, createdBy: string): ProceduralGameState {
  return { type: "procedural", id, spec, createdBy, phase: "lobby", round: 0, players: {}, choices: {}, scores: {}, created: Date.now() };
}

function copy(state: ProceduralGameState): ProceduralGameState {
  return {
    ...state,
    players: { ...state.players },
    choices: Object.fromEntries(Object.entries(state.choices).map(([round, answers]) => [round, { ...answers }])),
    scores: { ...state.scores },
  };
}

function currentRound(state: ProceduralGameState): ChoiceRoundsDefinition["rounds"][number] {
  if (state.spec.surface !== "choice_rounds" || state.round < 1) throw new Error("Choice round is not active");
  const round = state.spec.rounds[state.round - 1];
  if (!round) throw new Error("Choice round is unavailable");
  return round;
}

function completeChoiceRound(state: ProceduralGameState): ProceduralGameState {
  const next = copy(state);
  if (next.spec.surface !== "choice_rounds") throw new Error("Choice scoring is unavailable");
  const round = currentRound(next);
  const answers = next.choices[round.id] ?? {};
  const voters = Object.keys(next.players);
  if (!voters.length || !voters.every((voter) => answers[voter])) throw new Error("Every player must choose before reveal");
  const winners = next.spec.scoring === "correct"
    ? new Set(voters.filter((voter) => answers[voter] === round.correctId))
    : pluralityWinners(answers);
  for (const voter of winners) next.scores[voter] = (next.scores[voter] ?? 0) + 100;
  next.phase = "reveal";
  return next;
}

function pluralityWinners(answers: Record<string, string>): Set<string> {
  const counts = new Map<string, number>();
  for (const choice of Object.values(answers)) counts.set(choice, (counts.get(choice) ?? 0) + 1);
  const high = Math.max(...counts.values());
  const winningChoices = new Set([...counts].filter(([, count]) => count === high).map(([choice]) => choice));
  return new Set(Object.entries(answers).filter(([, choice]) => winningChoices.has(choice)).map(([voter]) => voter));
}

export function actProceduralGame(state: ProceduralGameState, voter: string, action: ProceduralAction): ProceduralGameState {
  if (action.type === "join") {
    if (state.players[voter]) return state;
    if (state.phase !== "lobby") throw new Error("Players can only join in the lobby");
    const next = copy(state);
    next.players[voter] = action.name.trim().slice(0, 40) || "Player";
    next.scores[voter] = 0;
    return next;
  }
  if (action.type === "advance") {
    if (state.spec.surface === "tap_dodge") {
      if (state.phase !== "lobby") return state;
      return { ...state, phase: "round", round: 1 };
    }
    if (state.phase === "lobby") {
      if (!Object.keys(state.players).length) throw new Error("At least one player must join");
      return { ...state, phase: "round", round: 1 };
    }
    if (state.phase === "round") return completeChoiceRound(state);
    if (state.phase === "reveal") {
      if (state.round >= state.spec.rounds.length) return { ...state, phase: "done" };
      return { ...state, phase: "round", round: state.round + 1 };
    }
    return state;
  }
  if (action.type === "choose") {
    if (state.spec.surface !== "choice_rounds" || state.phase !== "round") throw new Error("Choices are not active");
    if (!state.players[voter]) throw new Error("Join before choosing");
    const round = currentRound(state);
    if (!round.choices.some((choice) => choice.id === action.choiceId)) throw new Error("Choice is unavailable");
    const next = copy(state);
    next.choices[round.id] = { ...(next.choices[round.id] ?? {}), [voter]: action.choiceId };
    return next;
  }
  if (state.spec.surface !== "tap_dodge" || state.phase !== "round") throw new Error("Tap replay is not active");
  return { ...state, phase: "done", tapResult: replayTapRun(state.spec, action.tapMs) };
}

function randomUnit(seed: number, index: number): number {
  let value = (seed + Math.imul(index + 1, 0x6d2b79f5)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return (value >>> 0) / 0x100000000;
}

/** Replays an untrusted local tap trace using integer time and coordinates. */
export function replayTapRun(definition: TapDodgeDefinition, tapMs: number[]): TapResult {
  for (let index = 0; index < tapMs.length; index++) {
    const tap = tapMs[index];
    if (!Number.isInteger(tap) || tap < 0 || tap > definition.durationMs) throw new Error("Tap timestamps must be within the run");
    if (index && tap <= tapMs[index - 1]!) throw new Error("Tap timestamps must be ascending");
  }
  const tickMs = 50;
  let tapIndex = 0;
  let y = 500;
  let velocity = 0;
  let score = 0;
  const crossed = new Set<number>();
  for (let time = 0; time <= definition.durationMs; time += tickMs) {
    while (tapMs[tapIndex] !== undefined && tapMs[tapIndex]! <= time) {
      velocity = -100;
      tapIndex++;
    }
    velocity += 12;
    y += velocity;
    if (y < 0 || y > 1_000) return { score, terminalReason: "collision" };
    const obstacleCount = Math.floor(definition.durationMs / definition.obstacleIntervalMs) + 1;
    for (let index = 0; index < obstacleCount; index++) {
      const spawnMs = index * definition.obstacleIntervalMs;
      const crossMs = spawnMs + Math.floor((860_000 / definition.obstacleSpeed));
      if (crossed.has(index) || time < crossMs || time >= crossMs + tickMs) continue;
      crossed.add(index);
      const center = 180 + Math.floor(randomUnit(definition.seed, index) * 640);
      const top = center - Math.floor(definition.gapSize / 2);
      const bottom = center + Math.floor(definition.gapSize / 2);
      if (y < top || y > bottom) return { score, terminalReason: "collision" };
      score += 100;
    }
  }
  return { score, terminalReason: "time" };
}

export function simulateDefinition(definition: ProceduralDefinition): { phase: "done"; terminalReason?: TapResult["terminalReason"] } {
  if (definition.surface === "tap_dodge") {
    const canonicalTaps = Array.from({ length: Math.floor(definition.durationMs / 220) }, (_, index) => 150 + index * 220)
      .filter((tap) => tap <= definition.durationMs);
    return { phase: "done", terminalReason: replayTapRun(definition, canonicalTaps).terminalReason };
  }
  let state = newProceduralGame("simulation", definition, "simulator");
  state = actProceduralGame(state, "one", { type: "join", name: "One" });
  state = actProceduralGame(state, "two", { type: "join", name: "Two" });
  state = actProceduralGame(state, "one", { type: "advance" });
  let guard = definition.rounds.length * 3 + 1;
  while (state.phase !== "done" && guard-- > 0) {
    if (state.phase === "round") {
      const round = currentRound(state);
      state = actProceduralGame(state, "one", { type: "choose", choiceId: round.choices[0]!.id });
      state = actProceduralGame(state, "two", { type: "choose", choiceId: round.choices[0]!.id });
    }
    state = actProceduralGame(state, "one", { type: "advance" });
  }
  if (state.phase !== "done") throw new Error("Choice simulation did not reach a terminal state");
  return { phase: "done" };
}

export function viewProceduralGame(state: ProceduralGameState, voter: string): ProceduralGameView {
  const players = Object.entries(state.players).map(([id, name]) => ({
    name,
    score: state.scores[id] ?? 0,
    chosen: state.spec.surface === "choice_rounds" && state.round > 0
      ? state.choices[state.spec.rounds[state.round - 1]?.id ?? ""]?.[id] !== undefined
      : false,
  }));
  const view: ProceduralGameView = {
    gameType: "procedural",
    id: state.id,
    surface: state.spec.surface,
    title: state.spec.title,
    topic: state.spec.topic,
    phase: state.phase,
    round: state.round,
    totalRounds: state.spec.surface === "choice_rounds" ? state.spec.rounds.length : 1,
    players,
  };
  if (state.spec.surface === "choice_rounds" && state.round > 0) {
    const round = currentRound(state);
    view.choiceRound = {
      prompt: round.prompt,
      choices: round.choices,
      myChoice: state.choices[round.id]?.[voter] ?? null,
      ...(state.phase === "reveal" || state.phase === "done" ? { correctId: round.correctId } : {}),
    };
  }
  if (state.spec.surface === "tap_dodge") {
    const { seed, durationMs, obstacleIntervalMs, obstacleSpeed, gapSize } = state.spec;
    view.tapDodge = { seed, durationMs, obstacleIntervalMs, obstacleSpeed, gapSize, ...(state.tapResult ? { result: state.tapResult } : {}) };
  }
  return view;
}
