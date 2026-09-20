import assert from "node:assert/strict";
import test from "node:test";
import {
  ProceduralDefinitionZ,
  actProceduralGame,
  newProceduralGame,
  replayTapRun,
  simulateDefinition,
  viewProceduralGame,
} from "../src/server/procedural-game";

const choiceDefinition = {
  version: 1 as const,
  surface: "choice_rounds" as const,
  title: "Late-night takes",
  topic: "Pick the group’s most controversial opinion",
  visual: { mood: "electric", accent: "violet", icon: "spark" },
  scoring: "plurality" as const,
  rounds: [{
    id: "round-1",
    prompt: "Which snack survives a road trip?",
    choices: [
      { id: "chips", text: "Chips" },
      { id: "gummies", text: "Gummies" },
      { id: "trail", text: "Trail mix" },
    ],
  }],
};

const tapDefinition = {
  version: 1 as const,
  surface: "tap_dodge" as const,
  title: "Pigeon Paperwork Panic",
  topic: "Dodge flying office furniture",
  visual: { mood: "bright", accent: "coral", icon: "bird" },
  seed: 273,
  durationMs: 15_000,
  obstacleIntervalMs: 1_500,
  obstacleSpeed: 280,
  gapSize: 320,
};

test("a plurality definition reaches done through legal actions", () => {
  let game = newProceduralGame("choice-1", ProceduralDefinitionZ.parse(choiceDefinition), "luka");
  game = actProceduralGame(game, "luka", { type: "join", name: "Luka" });
  game = actProceduralGame(game, "chang", { type: "join", name: "Chang" });
  game = actProceduralGame(game, "luka", { type: "advance" });
  game = actProceduralGame(game, "luka", { type: "choose", choiceId: "trail" });
  game = actProceduralGame(game, "chang", { type: "choose", choiceId: "trail" });

  assert.equal(game.phase, "reveal");
  assert.deepEqual(game.scores, { luka: 100, chang: 100 });

  game = actProceduralGame(game, "luka", { type: "advance" });
  assert.equal(game.phase, "done");
});

test("definition parsing rejects mechanics outside the registered surfaces", () => {
  assert.throws(() => ProceduralDefinitionZ.parse({
    ...choiceDefinition,
    scoring: "correct",
  }));
  assert.throws(() => ProceduralDefinitionZ.parse({
    ...choiceDefinition,
    rounds: [{ ...choiceDefinition.rounds[0], choices: [
      { id: "same", text: "First" },
      { id: "same", text: "Second" },
    ] }],
  }));
  assert.throws(() => ProceduralDefinitionZ.parse({ ...tapDefinition, obstacleIntervalMs: 50 }));
});

test("every accepted definition has a deterministic terminal simulation", () => {
  assert.equal(simulateDefinition(ProceduralDefinitionZ.parse(choiceDefinition)).phase, "done");
  assert.ok(simulateDefinition(ProceduralDefinitionZ.parse(tapDefinition)).terminalReason);
});

test("tap replays compute a stable score and reject noncanonical timestamps", () => {
  const first = replayTapRun(ProceduralDefinitionZ.parse(tapDefinition), [150, 380, 620, 890]);
  const second = replayTapRun(ProceduralDefinitionZ.parse(tapDefinition), [150, 380, 620, 890]);

  assert.deepEqual(first, second);
  assert.throws(() => replayTapRun(ProceduralDefinitionZ.parse(tapDefinition), [740, 310]), /ascending/);
  assert.throws(() => replayTapRun(ProceduralDefinitionZ.parse(tapDefinition), [16_000]), /within the run/);
});

test("the native view gets visual tokens and never gets a correct answer before reveal", () => {
  const definition = ProceduralDefinitionZ.parse({
    ...choiceDefinition,
    scoring: "correct",
    rounds: [{ ...choiceDefinition.rounds[0], correctId: "chips" }],
  });
  let game = newProceduralGame("view-1", definition, "luka");
  game = actProceduralGame(game, "luka", { type: "join", name: "Luka" });
  game = actProceduralGame(game, "luka", { type: "advance" });

  const round = viewProceduralGame(game, "luka");
  assert.equal(round.joined, true);
  assert.equal(round.visual.accent, "violet");
  assert.equal(round.choiceRound?.correctId, undefined);

  game = actProceduralGame(game, "luka", { type: "choose", choiceId: "chips" });
  assert.equal(viewProceduralGame(game, "luka").choiceRound?.correctId, "chips");
});
