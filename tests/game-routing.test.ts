import assert from "node:assert/strict";
import test from "node:test";
import { classifyGamePrompt, gateGameRoute, generateProceduralDefinition, type AcceptedRoute } from "../src/server/game-routing";

const choiceAnswer = (choice: "choice_rounds" | "tap_dodge" | "needs_choice", confidence: number, copyRisk = 0) => ({
  answers: {
    surface: {
      type: "choice",
      choice,
      confidence,
      probabilities: { choice_rounds: 0.1, tap_dodge: 0.8, needs_choice: 0.1 },
    },
    copyRisk: { type: "noul", noul: copyRisk },
  },
});

test("the deterministic gate abstains below the confidence floor", () => {
  assert.deepEqual(
    gateGameRoute({ surface: "tap_dodge", confidence: 0.42, copyRiskProbability: 0.02 }),
    { status: "needs_choice", choices: ["choice_rounds", "tap_dodge"], confidence: 0.42, decisionVersion: 1 },
  );
});

test("a typed high-confidence Jev choice becomes an accepted surface", async () => {
  const route = await classifyGamePrompt(
    { AI_GATEWAY_API_KEY: "test-key" },
    "Make a fast one-thumb pigeon game that dodges office furniture",
    async () => choiceAnswer("tap_dodge", 0.93),
  );

  assert.deepEqual(route, { status: "accepted", surface: "tap_dodge", confidence: 0.93, decisionVersion: 1 });
});

test("copy-risk and malformed answers never become a playable route", async () => {
  const copied = await classifyGamePrompt(
    { AI_GATEWAY_API_KEY: "test-key" },
    "Make Flappy Bird exactly",
    async () => choiceAnswer("tap_dodge", 0.99, 0.92),
  );
  assert.deepEqual(copied, { status: "copy_risk", alternatives: ["choice_rounds", "tap_dodge"], confidence: 0.99, decisionVersion: 1 });

  const malformed = await classifyGamePrompt(
    { AI_GATEWAY_API_KEY: "test-key" },
    "Make something strange",
    async () => ({ answers: { surface: { type: "choice", choice: "board", confidence: 1, probabilities: {} } } }),
  );
  assert.deepEqual(malformed.status, "needs_choice");
});

test("a missing gateway key returns a picker rather than guessing", async () => {
  const route = await classifyGamePrompt({}, "Make a game about Toronto");
  assert.deepEqual(route, { status: "needs_choice", choices: ["choice_rounds", "tap_dodge"], confidence: 0, decisionVersion: 1 });
});

test("definition generation never invokes OpenAI for a nonaccepted route", async () => {
  let calls = 0;
  const pending = { status: "needs_choice", choices: ["choice_rounds", "tap_dodge"], confidence: 0.4, decisionVersion: 1 } as unknown as AcceptedRoute;

  await assert.rejects(
    () => generateProceduralDefinition({} as Env, "Make an unknown game", pending, async () => {
      calls++;
      return {};
    }),
    /accepted route/,
  );
  assert.equal(calls, 0);
});
