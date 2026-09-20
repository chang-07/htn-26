import assert from "node:assert/strict";
import test from "node:test";
import { bjHit, type GameState } from "../src/server/game";

const blackjack = {
  version: 1 as const,
  kind: "blackjack" as const,
  title: "Local table",
  topic: "Test table",
  rounds: 3,
  startingChips: 500,
};

function roundState(): GameState {
  return {
    id: "game-1",
    spec: blackjack,
    createdBy: "luka",
    phase: "round",
    round: 1,
    players: { luka: "Luka" },
    answers: {},
    scores: { luka: 500 },
    bj: {
      hands: {
        luka: { cards: ["9♠", "7♥"], done: false, bust: false },
        __shoe: { cards: ["2♦"], done: true, bust: false },
      },
      dealer: ["K♣", "6♦"],
    },
    created: 0,
  };
}

test("a hit leaves the previous blackjack state unchanged", () => {
  const before = roundState();

  const after = bjHit(before, "luka");

  assert.deepEqual(before.bj?.hands.luka.cards, ["9♠", "7♥"]);
  assert.deepEqual(before.bj?.hands.__shoe.cards, ["2♦"]);
  assert.deepEqual(after.bj?.hands.luka.cards, ["9♠", "7♥", "2♦"]);
  assert.deepEqual(after.bj?.hands.__shoe.cards, []);
});
