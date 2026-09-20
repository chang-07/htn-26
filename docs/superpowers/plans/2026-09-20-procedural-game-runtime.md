# Procedural Game Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and safely run original choice-round and one-thumb tap-dodge games from prompts in the native iMessage extension.

**Architecture:** Legacy Trivia and Blackjack remain untouched. A separate procedural state uses a versioned definition DSL, deterministic Worker simulators, and generic native surface renderers. Jev makes a bounded surface-or-abstain decision; OpenAI generates only the accepted surface's schema.

**Tech Stack:** Cloudflare Workers, TypeScript, Zod, Vercel AI Gateway / TypeSafe Jev, OpenAI SDK, Node test runner/esbuild, SwiftUI.

**Spec:** `docs/superpowers/specs/2026-09-20-procedural-game-runtime-design.md`

## Global Constraints

- Do not alter the JSON shape or behavior of stored legacy Trivia or Blackjack rows.
- Never generate or execute source code; definitions contain registered data only.
- Jev may return only `choice_rounds`, `tap_dodge`, or `needs_choice` for this release.
- The gateway key and provider response body must never be logged, returned, or committed.
- Invalid, uncertain, unsupported, missing-key, and copy-risk requests write no game row and send no card.
- Production native views expose no route or validation diagnostics.
- The phone-visible game state remains redacted; no private correct answer or unplayed tap seed is leaked unnecessarily.

---

### Task 1: Share the existing Jev transport without changing research behavior

**Files:**
- Create: `src/server/jev.ts`
- Modify: `src/server/research-sources.ts`
- Create: `tests/jev.test.ts`
- Modify: `scripts/test-games.mjs`

**Interfaces:**
- Produces `askJev<T>(env, state, questions, schema, fetchImpl?)` and `requireJev(env)`.
- `askJev` posts to `https://ai-gateway.vercel.sh/typesafe/v1/systemone`, uses the fixed `typesafe-ai/jev` model, 30-second abort signal, and parses the supplied Zod response schema.
- Research retains its exported `hasJev`, `scoreSources`, and `scoreCandidates` behavior.

- [ ] **Step 1: Write a failing transport test**

Create `tests/jev.test.ts`. Inject a fake fetch and assert URL, `POST`, JSON content type, redacted Bearer-header presence, fixed model, parsed answer, missing-key rejection, and a 401 rejection without response-body text.

```ts
await assert.rejects(
  () => askJev({}, { prompt: "hi" }, { surface: question }, ResponseZ, fakeFetch),
  /AI_GATEWAY_API_KEY is required/,
);
```

- [ ] **Step 2: Extend the TypeScript test runner and prove the test fails**

Make `scripts/test-games.mjs` bundle every `tests/*.test.ts` into the temporary output directory, then execute `node --test` on those bundles. Run `npm run test:games`; expect failure because `src/server/jev.ts` is absent.

- [ ] **Step 3: Implement the minimal transport**

Create `src/server/jev.ts` with a small `JevEnv` interface, `hasJev`, `requireJev`, and injected-fetch `askJev`. Move, rather than duplicate, `postJson`'s trace wrapper/no-body-on-error behavior. In `research-sources.ts`, keep research score schemas and batch policy but call the new client.

- [ ] **Step 4: Run focused regression checks**

Run:

```bash
npm run test:games
npm run typecheck
```

Expected: Jev transport and existing Blackjack immutability tests pass; no network request occurs.

- [ ] **Step 5: Commit**

```bash
git add src/server/jev.ts src/server/research-sources.ts tests/jev.test.ts scripts/test-games.mjs
git commit -m "refactor(jev): share typed gateway transport"
```

### Task 2: Add the procedural-definition DSL and deterministic simulators

**Files:**
- Create: `src/server/procedural-game.ts`
- Create: `tests/procedural-game.test.ts`

**Interfaces:**
- Produces `ProceduralDefinitionZ`, `ProceduralGameState`, `newProceduralGame`, `simulateDefinition`, `viewProceduralGame`, and `actProceduralGame`.
- `choice_rounds` contains 1-8 rounds, each with 2-4 choices and `scoring: "correct" | "plurality"`.
- `tap_dodge` contains `seed`, `durationMs`, `obstacleIntervalMs`, `obstacleSpeed`, `gapSize`, and bounded semantic visual tokens. Its score is computed only by `replayTapRun(definition, tapMs)`.

- [ ] **Step 1: Write failing definition/simulation tests**

Test that a valid plurality definition simulates join/choose/advance to `done`; a missing correct index, duplicate choice ids, impossible round count, out-of-range tap parameter, and a nonterminal route fail parsing or simulation. Test that the same tap timestamps always reproduce the same tap-dodge score and unsorted/out-of-window taps are rejected.

```ts
assert.equal(replayTapRun(tapDefinition, [100, 310, 740]).score,
             replayTapRun(tapDefinition, [100, 310, 740]).score);
assert.throws(() => replayTapRun(tapDefinition, [740, 310]), /ascending/);
```

- [ ] **Step 2: Run and verify red**

Run `npm run test:games`; expect the test to fail because the DSL module does not exist.

- [ ] **Step 3: Implement the two-surface DSL**

Add strict discriminated Zod schemas with `version: 1`, string/array numeric bounds, `mood`/`accent` token unions, and no arbitrary asset, URL, font, or code fields. Implement immutable reducers for choice rounds. Use integer milliseconds/fixed-point arithmetic for tap replay; return computed score and terminal result, not client score.

- [ ] **Step 4: Run deterministic checks**

Run:

```bash
npm run test:games
npm run typecheck
```

Expected: all parser, simulation, and legacy game tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/procedural-game.ts tests/procedural-game.test.ts
git commit -m "feat(games): add procedural game definitions"
```

### Task 3: Route prompts, generate one accepted definition, and gate every other case

**Files:**
- Create: `src/server/game-routing.ts`
- Create: `tests/game-routing.test.ts`
- Modify: `src/server/procedural-game.ts`

**Interfaces:**
- Produces `classifyGamePrompt(env, prompt, ask?)`, `gateRoute(route)`, and `generateProceduralDefinition(env, prompt, route)`.
- `Route` is a tagged union: accepted `choice_rounds | tap_dodge`, `needs_choice`, or `copy_risk`.
- The route accepts only one Jev choice question and one copy-risk Boolean question; confidence is the surface answer's confidence.

- [ ] **Step 1: Write failing routing tests with injected Jev answers**

Cover a high-confidence social-choice prompt, a high-confidence obstacle prompt, low confidence, explicit `needs_choice`, malformed answer keys, copy-risk, and missing gateway key. Assert no generator invocation occurs unless status is `accepted`.

```ts
assert.deepEqual(
  gateRoute({ status: "accepted", surface: "tap_dodge", confidence: 0.42, copyRisk: false }),
  { status: "needs_choice", choices: ["choice_rounds", "tap_dodge"] },
);
```

- [ ] **Step 2: Run and verify red**

Run `npm run test:games`; expect failure because `game-routing.ts` does not exist.

- [ ] **Step 3: Implement the bounded Jev decision and gate**

Use `askJev` with `surface` choices `choice_rounds`, `tap_dodge`, `needs_choice`; include definitions that distinguish a social/prompt-choice activity from a one-thumb obstacle activity. Ask `copyRisk` as a Boolean. Require confidence `>= 0.75`, and have gate functions return short fixed surface labels for chooser results. Do not ask Jev to generate alternatives.

- [ ] **Step 4: Generate and validate the selected surface only**

Use `askJson` with `ProceduralDefinitionZ` narrowed to the accepted surface. Supply the original-prompt rule and semantic-token list. Parse and call `simulateDefinition` before returning the definition.

- [ ] **Step 5: Run focused verification**

Run:

```bash
npm run test:games
npm run typecheck
```

Expected: rejection paths never call OpenAI; accepted fixtures parse and simulate.

- [ ] **Step 6: Commit**

```bash
git add src/server/game-routing.ts src/server/procedural-game.ts tests/game-routing.test.ts
git commit -m "feat(games): route prompts to procedural surfaces"
```

### Task 4: Make the widget API persist only accepted procedural games

**Files:**
- Modify: `src/server/agent.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/game.ts`
- Create: `tests/procedural-widget.test.ts`

**Interfaces:**
- `gameCreate` returns `CreateGameResponse`, never a thrown expected routing outcome.
- Create endpoint accepts either `{ prompt, voter, name }` or `{ promptId, surface, voter, name }`.
- `gameFetch` returns `LegacyGameView | ProceduralGameView`; action endpoint accepts `choose`, `advance`, `tap_replay`, plus legacy actions.

- [ ] **Step 1: Write failing HTTP/agent contract tests**

Use mocked classifier/generator dependencies to prove: `created` persists one row and calls `sendGameCard`; `needs_choice` and `copy_risk` persist no row/send no card; chooser follow-up uses the stored prompt and only an allowed surface; tap replay response exposes Worker-computed score.

- [ ] **Step 2: Run and verify red**

Run `npm run test:games`; expect the new tagged response contract to fail.

- [ ] **Step 3: Implement a separate procedural stored-state guard**

Use `isProceduralGame` to branch legacy versus procedural rows rather than changing legacy `GameState`. Store short-lived pending prompt records in the agent's existing SQLite state with an expiry timestamp. Ensure expired/unknown prompt IDs return `needs_choice`, never a raw error or original prompt.

- [ ] **Step 4: Implement endpoint response/action unions**

Return HTTP 200 for `created`, `needs_choice`, and `copy_risk`; use 400 only for malformed request bodies. Keep legacy response payloads byte-for-byte equivalent. Pass only `tapMs` arrays to `tap_replay`; ignore client-supplied scores.

- [ ] **Step 5: Run full Worker verification**

Run:

```bash
npm run test:games
npm run test
npm run typecheck
git diff --check
```

Expected: old game tests still pass; only accepted definitions create cards.

- [ ] **Step 6: Commit**

```bash
git add src/server/agent.ts src/server/index.ts src/server/game.ts tests/procedural-widget.test.ts
git commit -m "feat(games): serve procedural game cards"
```

### Task 5: Render procedural games and the safe chooser in the iMessage extension

**Files:**
- Modify: `ios/MessagesExtension/GameViews.swift`
- Modify: `ios/MessagesExtension/MessagesViewController.swift`
- Modify: `ios/MessagesExtension/PreviewFixtures.swift`
- Modify: `ios/PreviewApp/PreviewsApp.swift`
- Test: Xcode `Plan` build and connected-device run

**Interfaces:**
- Decodes a tagged create response before decoding surface data.
- Adds `ProceduralGameView` with `ChoiceRoundsRenderer` and `TapDodgeRenderer`.
- `#if DEBUG` Game Lab shows route status/confidence and definition summary; release builds show only player-facing copy.

- [ ] **Step 1: Add fixtures that do not call the Worker**

Create accepted choice, accepted tap-dodge, `needs_choice`, and `copy_risk` fixtures. Add both surface states to the Preview App gallery.

- [ ] **Step 2: Make the composer decode the tagged response**

Replace the `Made { id, title }` assumption with a `CreateGameResponse` enum. Render safe-choice buttons for accepted picker labels; POST only `promptId` and the label. Keep current generic error behavior for malformed/transport responses.

- [ ] **Step 3: Add the generic surface shell and choice renderer**

Switch from a legacy game kind to a tagged view. Render title/topic/player scores from common fields, then use generated choice text only in registered choice controls. Do not add generated colors, fonts, images, or source.

- [ ] **Step 4: Add deterministic one-thumb tap-dodge rendering**

Use the stored seed and fixed time step to render obstacles. Record tap offsets from run start. At terminal state submit sorted offsets to `tap_replay`, then display the Worker-computed score. The client must not send or trust a score value.

- [ ] **Step 5: Add debug-only route panel**

Under `#if DEBUG`, show `surface`, rounded confidence, and validation status in Game Lab. Verify no route fields are displayed by production view code.

- [ ] **Step 6: Verify the native loop**

Build `Plan` in Xcode and run it on the connected iPhone. Test a social-choice prompt, a pigeon tap-dodge prompt, an ambiguous prompt, and a named-copy prompt. Confirm only the first two post cards.

- [ ] **Step 7: Commit**

```bash
git add ios/MessagesExtension/GameViews.swift ios/MessagesExtension/MessagesViewController.swift ios/MessagesExtension/PreviewFixtures.swift ios/PreviewApp/PreviewsApp.swift
git commit -m "feat(ios): render procedural game surfaces"
```

### Task 6: Add deterministic corpora and opt-in live routing evaluation

**Files:**
- Create: `tests/fixtures/procedural-routes.json`
- Create: `scripts/eval-procedural-routing.mjs`
- Create: `scripts/eval-procedural-routing.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Corpus rows contain `id`, `prompt`, `expectedStatuses`, `allowedSurfaces`, and `reason`.
- `npm run eval:procedural-routing` makes read-only Jev calls only when `AI_GATEWAY_API_KEY` is set.

- [ ] **Step 1: Write failing fixture validation tests**

Reject duplicate IDs, blank prompt/reason, invalid surface, unknown status, and empty allowed surfaces for `accepted` rows. Include twelve cases: clear choice, clear tap-dodge, ambiguous, unsupported, copy-risk, and nonsense.

- [ ] **Step 2: Run and verify red**

Run `node --test scripts/eval-procedural-routing.test.mjs`; expect failure because the loader is absent.

- [ ] **Step 3: Implement fixture loader and live evaluator**

Print one redacted result per case with route, confidence, status, and latency. Exit nonzero on route mismatch or provider failure. Do not create agents, cards, games, or D1 rows.

- [ ] **Step 4: Document local and phone testing**

Add the local secret requirement, usage cost note, deterministic commands, and the requirement that the Worker be reachable from the phone (a deployed dev Worker or a tunnel) to the README.

- [ ] **Step 5: Verify and commit**

Run:

```bash
node --test scripts/eval-procedural-routing.test.mjs
npm run test:games
npm run typecheck
git diff --check
```

Then commit:

```bash
git add tests/fixtures/procedural-routes.json scripts/eval-procedural-routing.mjs scripts/eval-procedural-routing.test.mjs package.json README.md
git commit -m "test(games): evaluate procedural routing"
```

## Plan self-review

- Spec coverage: separate legacy compatibility, two procedural surfaces, bounded Jev routing, typed picker API, simulation, native debug loop, and deterministic/live evaluation map to Tasks 1-6.
- Placeholder scan: all tasks name concrete files, interfaces, commands, test cases, and commit boundaries.
- Type consistency: `choice_rounds`, `tap_dodge`, `needs_choice`, `copy_risk`, `promptId`, and `tap_replay` are used consistently across routing, API, native rendering, and evaluation.
