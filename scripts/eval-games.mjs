#!/usr/bin/env node
/**
 * Live, local prompt evaluation for generated games. Unlike test:games, this
 * deliberately calls Jev and the configured dev LLM; run the Worker and local
 * LLM proxy first. It never deploys or texts anyone because eval chats use the
 * simulator transport. An abstention is resolved by the evaluator choosing the
 * requested safe surface, exactly as the iPhone picker does.
 *
 *   npm run llm                 # when DEV_LLM_BASE_URL points at this proxy
 *   npm run dev
 *   npm run eval:games
 */
const base = process.env.EVAL_BASE ?? "http://127.0.0.1:5173";
const stamp = Date.now();
const cases = [
  { name: "late-night-takes", prompt: "Make an original five-round group game where we vote on late-night food takes", surface: "choice_rounds" },
  { name: "space-quiz", prompt: "Make a short original astronomy quiz for friends", surface: "choice_rounds" },
  { name: "office-dodge", prompt: "Make an original one-thumb game where a courier dodges flying office furniture", surface: "tap_dodge" },
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
    let made = await created.json();
    if (made.status === "needs_choice") {
      const selected = await post(`/api/widget/${encodeURIComponent(chat)}/game`, {
        promptId: made.promptId,
        surface: item.surface,
        voter: "eval-player",
        name: "Evaluator",
      });
      if (!selected.ok) fail(`picker returned ${selected.status}: ${(await selected.text()).slice(0, 240)}`);
      made = await selected.json();
    }
    if (made.status !== "created" || !made.id) fail(`expected created game, received ${JSON.stringify(made)}`);

    const read = await fetch(`${base}/api/widget/${encodeURIComponent(chat)}/game/${made.id}?voter=eval-player`);
    if (!read.ok) fail(`fetch returned ${read.status}`);
    const game = await read.json();
    if (game.gameType !== "procedural" || game.surface !== item.surface) fail(`expected ${item.surface}, received ${JSON.stringify(game)}`);
    if (game.phase !== "lobby" || !game.title || !game.topic || !game.visual) fail(`invalid playable lobby: ${JSON.stringify(game)}`);

    const act = async (sub, body = {}) => {
      const response = await post(`/api/widget/${encodeURIComponent(chat)}/game/${made.id}/${sub}`, { voter: "eval-player", ...body });
      if (!response.ok) fail(`${sub} returned ${response.status}: ${(await response.text()).slice(0, 240)}`);
      return response.json();
    };
    const round = await act("advance");
    if (item.surface === "choice_rounds") {
      if (round.phase !== "round" || round.choiceRound?.correctId !== undefined) fail(`choice round leaked or failed: ${JSON.stringify(round)}`);
      const revealed = await act("choose", { choiceId: round.choiceRound.choices[0].id });
      if (revealed.phase !== "reveal" || (revealed.choiceRound?.correctId ?? null) === null && revealed.choiceRound?.correctId !== undefined) {
        fail(`choice round did not reveal safely: ${JSON.stringify(revealed)}`);
      }
    } else {
      const done = await act("tap_replay", { tapMs: [150, 400, 650, 900] });
      if (done.phase !== "done" || !done.tapDodge?.result) fail(`tap replay did not terminate: ${JSON.stringify(done)}`);
    }
    passed++;
    console.log(`PASS  ${item.name}  ${made.title} (${item.surface})`);
  } catch (error) {
    console.log(`FAIL  ${item.name}  ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${passed}/${cases.length} game-generation evals passed`);
process.exitCode = passed === cases.length ? 0 : 1;
