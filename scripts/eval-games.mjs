#!/usr/bin/env node
/**
 * Live, local prompt evaluation for generated games. Unlike test:games, this
 * deliberately calls the configured dev LLM; run the Worker and local LLM
 * proxy first. It never deploys or texts anyone because eval chats use the
 * simulator transport.
 *
 *   npm run llm                 # when DEV_LLM_BASE_URL points at this proxy
 *   npm run dev
 *   npm run eval:games
 */
const base = process.env.EVAL_BASE ?? "http://127.0.0.1:5173";
const stamp = Date.now();
const cases = [
  { name: "blackjack", prompt: "Make a blackjack game for a group of friends", kind: "blackjack" },
  { name: "trivia", prompt: "Make a five-question astronomy trivia game", kind: "trivia" },
];

const post = (path, body) => fetch(base + path, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const fail = (message) => { throw new Error(message); };

let passed = 0;
for (const item of cases) {
  const chat = `eval-game-${item.name}-${stamp}`;
  try {
    const created = await post(`/api/widget/${encodeURIComponent(chat)}/game`, {
      prompt: item.prompt,
      voter: "eval-player",
      name: "Evaluator",
    });
    if (!created.ok) fail(`create returned ${created.status}: ${(await created.text()).slice(0, 240)}`);
    const made = await created.json();
    if (!made.id) fail("create response had no game id");

    const read = await fetch(`${base}/api/widget/${encodeURIComponent(chat)}/game/${made.id}?voter=eval-player`);
    if (!read.ok) fail(`fetch returned ${read.status}`);
    const game = await read.json();
    if (game.kind !== item.kind) fail(`expected ${item.kind}, received ${game.kind}`);
    if (game.phase !== "lobby" || !game.title || !game.topic) fail(`invalid playable lobby: ${JSON.stringify(game)}`);
    if (item.kind === "blackjack" && !(game.totalRounds >= 3 && game.totalRounds <= 5)) {
      fail(`blackjack expected 3–5 rounds, received ${game.totalRounds}`);
    }
    if (item.kind === "trivia" && !(game.totalRounds >= 5 && game.totalRounds <= 6)) {
      fail(`trivia expected 5–6 questions, received ${game.totalRounds}`);
    }
    passed++;
    console.log(`PASS  ${item.name}  ${made.title}`);
  } catch (error) {
    console.log(`FAIL  ${item.name}  ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${passed}/${cases.length} game-generation evals passed`);
process.exitCode = passed === cases.length ? 0 : 1;
