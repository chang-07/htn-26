import { z } from "zod";
import { askJev, type JevEnv } from "./jev";
import { askJson } from "./llm";
import {
  ChoiceRoundsDefinitionZ,
  ProceduralDefinitionZ,
  TapDodgeDefinitionZ,
  simulateDefinition,
  type ProceduralDefinition,
} from "./procedural-game";

export const GAME_SURFACES = ["choice_rounds", "tap_dodge"] as const;
export type GameSurface = (typeof GAME_SURFACES)[number];
const MIN_CONFIDENCE = 0.75;

const RouteAnswersZ = z.object({
  answers: z.object({
    surface: z.object({
      type: z.literal("choice"),
      choice: z.enum(["choice_rounds", "tap_dodge", "needs_choice"]),
      confidence: z.number().min(0).max(1),
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
    copyRisk: z.object({
      type: z.literal("noul"),
      noul: z.number().min(0).max(1),
    }),
  }),
});

export type AcceptedRoute = { status: "accepted"; surface: GameSurface; confidence: number; decisionVersion: 1 };
export type PendingRoute = { status: "needs_choice"; choices: GameSurface[]; confidence: number; decisionVersion: 1 };
export type CopyRiskRoute = { status: "copy_risk"; alternatives: GameSurface[]; confidence: number; decisionVersion: 1 };
export type GameRoute = AcceptedRoute | PendingRoute | CopyRiskRoute;

export type RouteDecision = { surface: GameSurface | "needs_choice"; confidence: number; copyRiskProbability: number };
type Evaluator = (env: JevEnv, state: unknown, questions: Record<string, unknown>) => Promise<unknown>;
type DefinitionGenerator = (env: Env, schema: z.ZodType, system: string, user: string) => Promise<unknown>;

const routeQuestions = {
  surface: {
    type: "choice",
    instructions: "Which registered game surface can faithfully express this request? Choose needs_choice when neither is a good fit.",
    criteria: {
      choice_rounds: "A short social or knowledge game where players select one of two to four written choices each round. Use for trivia, voting, ranking, and opinion prompts.",
      tap_dodge: "A solo one-thumb game where a player taps to avoid rhythmic moving obstacles. Use for original flap-like or obstacle-dodge challenges.",
      needs_choice: "The request needs a board, cards, free text, real-time multiplayer, copied rules, or another mechanic that these two surfaces cannot faithfully run.",
    },
  },
  copyRisk: {
    type: "noul",
    instructions: "Does the request ask to copy a named game, its recognizable rules, characters, assets, or protected presentation?",
    criteria: {
      true: "It requests a recognizable named game or a direct copy of its rules or presentation.",
      false: "It asks for an original game or only a broad mood, genre, or generic mechanic.",
    },
  },
};

const choices = (): GameSurface[] => [...GAME_SURFACES];

export function gateGameRoute(decision: RouteDecision): GameRoute {
  if (decision.copyRiskProbability >= 0.5) {
    return { status: "copy_risk", alternatives: choices(), confidence: decision.confidence, decisionVersion: 1 };
  }
  if (decision.surface === "needs_choice" || decision.confidence < MIN_CONFIDENCE) {
    return { status: "needs_choice", choices: choices(), confidence: decision.confidence, decisionVersion: 1 };
  }
  return { status: "accepted", surface: decision.surface, confidence: decision.confidence, decisionVersion: 1 };
}

const defaultEvaluator: Evaluator = (env, state, questions) => askJev(env, state, questions, RouteAnswersZ);

export async function classifyGamePrompt(env: JevEnv, prompt: string, evaluate: Evaluator = defaultEvaluator): Promise<GameRoute> {
  try {
    const result = RouteAnswersZ.parse(await evaluate(env, { prompt: prompt.trim().slice(0, 500), surfaces: GAME_SURFACES }, routeQuestions));
    return gateGameRoute({
      surface: result.answers.surface.choice,
      confidence: result.answers.surface.confidence,
      copyRiskProbability: result.answers.copyRisk.noul,
    });
  } catch {
    // A missing key, provider error, or malformed answer must not guess a game.
    return { status: "needs_choice", choices: choices(), confidence: 0, decisionVersion: 1 };
  }
}

const defaultDefinitionGenerator: DefinitionGenerator = async (env, schema, system, user) => {
  const { value } = await askJson(env, schema, system, user);
  return value;
};

/** Generate only the schema selected by an already-accepted route. */
export async function generateProceduralDefinition(
  env: Env,
  prompt: string,
  route: AcceptedRoute,
  generate: DefinitionGenerator = defaultDefinitionGenerator,
): Promise<ProceduralDefinition> {
  if (route.status !== "accepted" || !GAME_SURFACES.includes(route.surface)) throw new Error("Generation requires an accepted route");
  const schema = route.surface === "choice_rounds" ? ChoiceRoundsDefinitionZ : TapDodgeDefinitionZ;
  const value = schema.parse(await generate(
    env,
    schema,
    `Generate one original ${route.surface} game definition. Use only the supplied schema. The title, theme, prompts, choices, seed, pacing, and semantic visual tokens may be fresh. Do not copy named games, recognizable characters, assets, or exact rules. Do not include executable code, URLs, fonts, colors, or fields outside the schema.`,
    `Player request: ${prompt.trim().slice(0, 500)}`,
  ));
  const definition = ProceduralDefinitionZ.parse(value);
  simulateDefinition(definition);
  return definition;
}
