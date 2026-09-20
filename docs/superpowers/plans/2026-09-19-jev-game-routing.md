# Jev Game Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make prompt-created games testable by routing every prompt through Jev, evaluating the routing against a checked-in corpus, and surfacing the selected route in the debug iMessage composer.

**Architecture:** Reuse the existing Vercel Gateway System One request pattern in `src/server/research-sources.ts`; Jev selects only registered game routes. OpenAI remains the existing engine-specific definition writer. The first slice does not add new game engines: it makes Trivia and Blackjack routing observable, testable, and safe to extend.

**Tech Stack:** Cloudflare Workers, TypeScript, Zod, Vercel AI Gateway / TypeSafe Jev, OpenAI SDK, Node test runner, SwiftUI / iMessage extension.

**Spec:** `docs/superpowers/specs/2026-09-19-prompt-generated-games-design.md`

## Global Constraints

- Keep OpenAI as the definition/content generator; Jev only classifies and validates choices.
- Use the existing `AI_GATEWAY_API_KEY`, `JEV_MODEL`, and `https://ai-gateway.vercel.sh/typesafe/v1/systemone` integration.
- Never log, commit, return, or render gateway secrets.
- Route only to registered engines; current registered engines are `trivia` and `blackjack`.
- An uncertain route must return a chooser-safe result, never silently create an arbitrary game.
- Generated UI uses only registered semantic visual tokens; it may not provide colors, fonts, or source code.
- Existing Trivia and Blackjack API behavior must remain playable.

---

### Task 1: Extract a reusable Jev System One client

**Files:**
- Create: `src/server/jev.ts`
- Modify: `src/server/research-sources.ts`
- Test: `scripts/research-sources.test.mjs`
- Test: `scripts/jev.test.mjs`

**Interfaces:**
- Consumes: `Env.AI_GATEWAY_API_KEY`, optional `Env.JEV_MODEL`, and the existing `traceOperation` convention.
- Produces: `hasJev(env)`, `requireJev(env)`, and `askJev(env, state, questions)`.
- `askJev` accepts JSON-safe `state` and a typed question map, posts only to the existing Vercel TypeSafe endpoint, validates the response with a caller-supplied Zod schema, and returns parsed answers plus token usage.

- [ ] **Step 1: Write the failing reusable-client tests**

Create `scripts/jev.test.mjs` with a mocked `fetch` that asserts the exact gateway URL, `Bearer` header presence without printing it, model `typesafe-ai/jev`, 30-second timeout, and parsed response. Include a missing-key test and an HTTP-401 test.

```js
await assert.rejects(
  askJev({}, { prompt: "test" }, { route: question }, ResponseSchema, fetch),
  /AI_GATEWAY_API_KEY is required/,
);
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node --experimental-strip-types --test scripts/jev.test.mjs`

Expected: FAIL because `src/server/jev.ts` does not exist.

- [ ] **Step 3: Implement the minimal shared client**

Move the existing safe POST behavior from `research-sources.ts` into `src/server/jev.ts`. Preserve its no-response-body logging rule, `AbortSignal.timeout(30_000)`, `traceOperation`, exact endpoint, and `JEV_MODEL === "typesafe-ai/jev"` guard. Export a small `JevEnv` interface instead of importing the full Worker `Env` type.

- [ ] **Step 4: Refactor research to consume the shared client**

Replace only the duplicated key check and System One POST in `research-sources.ts`; preserve research score schemas, batching, thresholds, fallback semantics, and existing public exports.

- [ ] **Step 5: Run focused regression tests**

Run:

```bash
node --experimental-strip-types --test scripts/jev.test.mjs
node --experimental-strip-types --test scripts/research-sources.test.mjs
node --experimental-strip-types --test scripts/research-jev-flow.test.mjs
```

Expected: all PASS; no network requests occur.

- [ ] **Step 6: Commit**

```bash
git add src/server/jev.ts src/server/research-sources.ts scripts/jev.test.mjs scripts/research-sources.test.mjs
git commit -m "refactor(jev): share system one client"
```

### Task 2: Add the bounded game-route contract and deterministic gate

**Files:**
- Create: `src/server/game-routing.ts`
- Modify: `src/server/game.ts`
- Modify: `src/server/agent.ts`
- Test: `tests/game-routing.test.ts`

**Interfaces:**
- Consumes: `askJev`, a game prompt, and the engine registry `trivia | blackjack`.
- Produces: `GameRoute = { kind: "trivia" | "blackjack"; genre: "turn" | "cards"; confidence: number; status: "accepted" | "needs_choice" | "copy_risk" }`.
- `classifyGamePrompt(env, prompt)` returns a route only from this union; `gateGameRoute(route)` determines whether generation can proceed.
- `generateGame(env, prompt, route)` receives the accepted `kind` and may generate only that discriminated-union schema.

- [ ] **Step 1: Write failing route tests**

Create `tests/game-routing.test.ts` with injected mocked Jev responses. Cover:

```ts
assert.deepEqual(await classifyGamePrompt(env, "Neon pigeon dodges office drones", fakeJev), {
  kind: "trivia", genre: "turn", confidence: 0.42, status: "needs_choice",
});
```

Also cover a high-confidence blackjack request, a low-confidence request, a named-copy-risk request, unknown answer keys, omitted answers, and invalid confidence values.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node scripts/test-games.mjs --test-name-pattern="game route"`

Expected: FAIL because the router does not exist.

- [ ] **Step 3: Implement `game-routing.ts`**

Declare all Jev choices in code. Ask separate bounded questions for engine kind, form factor, copy risk, and supportability. Validate every response with Zod; do not accept unknown answer keys. Gate rules:

```ts
const MIN_CONFIDENCE = 0.75;
if (copyRisk) return { ...route, status: "copy_risk" };
if (!supported || confidence < MIN_CONFIDENCE) return { ...route, status: "needs_choice" };
return { ...route, status: "accepted" };
```

Use a fixed original-game instruction for copy-risk prompts; it must reject exact names/rules but retain generic requested mood.

- [ ] **Step 4: Make game creation use the gate without changing current play**

In `agent.ts`, classify before `generateGame`. Accepted routes call `generateGame` with the chosen engine. `needs_choice` and `copy_risk` return a typed non-game result to the widget endpoint; they do not write a `games` SQLite row or send a Linq card. Persist the accepted route beside the game state for diagnostics.

- [ ] **Step 5: Add route metadata to the safe game view**

Extend `GameView` with optional `debugRoute` containing only kind, genre, confidence, and status. Populate it only for localhost/dev requests; regular game-card responses remain free of diagnostics.

- [ ] **Step 6: Run focused verification**

Run:

```bash
npm run test:games
npm run typecheck
node --experimental-strip-types --test tests/game-routing.test.ts
```

Expected: all PASS; existing Blackjack immutability test still passes.

- [ ] **Step 7: Commit**

```bash
git add src/server/game-routing.ts src/server/game.ts src/server/agent.ts tests/game-routing.test.ts
git commit -m "feat(games): route prompts through Jev"
```

### Task 3: Add the checked-in classification corpus and opt-in live eval

**Files:**
- Create: `tests/fixtures/game-routing-cases.json`
- Create: `scripts/eval-game-routing.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Test: `scripts/eval-game-routing.test.mjs`

**Interfaces:**
- Consumes: a case `{ id, prompt, expectedKinds, expectedStatus, minConfidence }`.
- Produces: one JSON-line report per case plus an aggregate accuracy, confident-error, uncertainty, and latency summary.
- `npm run eval:game-routing` requires `AI_GATEWAY_API_KEY`; it never creates games, sends cards, or mutates D1.

- [ ] **Step 1: Write a failing fixture/parser test**

Create a corpus with at least twelve cases: four clear Blackjack, four clear Trivia, two ambiguous arcade/board prompts, one named-copy-risk prompt, and one nonsense prompt. Write a test that rejects missing IDs, duplicate IDs, empty prompts, nonregistered expected kinds, and confidence outside 0–1.

- [ ] **Step 2: Run the parser test and verify it fails**

Run: `node --test scripts/eval-game-routing.test.mjs`

Expected: FAIL because the fixture/parser does not exist.

- [ ] **Step 3: Implement the corpus loader and live runner**

Load the checked-in cases, call the Jev classifier directly, and print redacted lines such as:

```text
PASS blackjack-casino  kind=blackjack confidence=0.91 latency=112ms
FAIL neon-dodge        expected=needs_choice got=accepted kind=trivia confidence=0.83
```

Exit nonzero on a route mismatch, a confidence-threshold violation, or a provider error. Print no authorization headers, raw gateway payloads, or secrets.

- [ ] **Step 4: Add the npm command and documentation**

Add `"eval:game-routing": "node scripts/eval-game-routing.mjs"`. Document the local secret requirement, that the command spends Gateway usage, and that it is classification-only.

- [ ] **Step 5: Run deterministic and live-gated verification**

Run:

```bash
node --test scripts/eval-game-routing.test.mjs
npm run typecheck
```

Run `npm run eval:game-routing` only when `AI_GATEWAY_API_KEY` is configured; record the visible classification report rather than raw responses.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/game-routing-cases.json scripts/eval-game-routing.mjs scripts/eval-game-routing.test.mjs package.json README.md
git commit -m "test(games): add Jev routing eval corpus"
```

### Task 4: Surface the route in a Debug Game Lab on iPhone

**Files:**
- Modify: `ios/MessagesExtension/GameViews.swift`
- Modify: `ios/MessagesExtension/PreviewFixtures.swift`
- Modify: `ios/PreviewApp/PreviewsApp.swift`
- Test: Xcode build and physical-device run

**Interfaces:**
- Consumes: the game-create response `{ id?, title?, route?: { kind, genre, confidence, status }, choices?: string[] }`.
- Produces: a `#if DEBUG` Game Composer result panel that shows the route/score and, for `needs_choice`, the returned safe choices.
- Production builds preserve the current short success/error composer copy and do not expose diagnostics.

- [ ] **Step 1: Add failing Swift fixture shapes**

Extend the debug-only response fixture with one accepted Blackjack route and one `needs_choice` route. Compile before changing the Codable response; expected failure is missing route fields.

- [ ] **Step 2: Add the smallest debug result model and UI**

Decode optional route data in `GameComposerView`. Under `#if DEBUG`, show a compact label such as `Route: cards / blackjack · 91%` after a successful generation. For `needs_choice`, show the server-provided choices as buttons that resubmit the original prompt plus selected direction. Do not add arbitrary client-side game routing.

- [ ] **Step 3: Update SwiftUI preview gallery**

Add previews for accepted, uncertain, and request-failure Game Lab states. Use local fixture values only; previews never call the Worker.

- [ ] **Step 4: Verify the native loop**

In Xcode, build `Plan` for the connected iPhone. In a Debug build, submit one clear Blackjack prompt and one ambiguous arcade prompt against the reachable Worker. Confirm the first displays its accepted route and card, and the second displays a chooser rather than a broken card.

- [ ] **Step 5: Commit**

```bash
git add ios/MessagesExtension/GameViews.swift ios/MessagesExtension/PreviewFixtures.swift ios/PreviewApp/PreviewsApp.swift
git commit -m "feat(ios): show debug game routing"
```

### Task 5: Establish the first component-library boundary before adding engines

**Files:**
- Modify: `ios/MessagesExtension/GameViews.swift`
- Modify: `ios/MessagesExtension/PreviewFixtures.swift`
- Test: Xcode previews and existing iPhone flow

**Interfaces:**
- Consumes: existing `GameView.kind` and a future renderer ID.
- Produces: a shared `GameChrome` (title, topic, players, score, phase/result treatment) and isolated `TriviaRenderer` / `BlackjackRenderer` views.
- Future genre renderers implement the same presentation boundary without changing the composer, networking, or lobby shell.

- [ ] **Step 1: Create compilation-preserving renderer fixtures**

Capture the current Trivia and Blackjack lobby/round/reveal states in previews. These are the visual baseline and must render unchanged before the split.

- [ ] **Step 2: Extract only shared chrome**

Move title/topic, player-score treatment, waiting state, and common error treatment into `GameChrome`. Keep engine-specific controls and content in the existing trivia/blackjack functions, renamed to explicit renderer views. Do not change layout tokens or gameplay behavior.

- [ ] **Step 3: Verify visual parity**

Open the previews side by side and run the installed app. Confirm the lobby, trivia answer/reveal, and blackjack hit/stand/reveal screens have unchanged interactions and no desktop-specific layout regression.

- [ ] **Step 4: Commit**

```bash
git add ios/MessagesExtension/GameViews.swift ios/MessagesExtension/PreviewFixtures.swift
git commit -m "refactor(ios): isolate game renderers"
```

## Plan self-review

- Spec coverage: Jev routing, gate behavior, eval corpus, visual Game Lab, existing-engine preservation, and component boundaries map to Tasks 1–5. New social/board/card/arcade engines remain deliberately out of this first testability slice; their selection follows corpus and visual evidence.
- No-placeholder check: the plan names concrete files, types, commands, tests, and commit boundaries for every task.
- Type consistency: `GameRoute` and its diagnostic representation use the same `kind`, `genre`, `confidence`, and `status` keys across Worker, eval runner, and Swift debug UI.
