# Procedural iMessage Game Runtime

## Goal

Let a person describe an original short game in the iMessage composer and
receive a playable native card. A prompt must generate a new definition at
request time; it must not merely choose a pre-authored trivia or Blackjack
variant.

## Product boundary

The app will generate game **definitions**, never executable Swift,
JavaScript, shaders, or arbitrary network actions. The native extension and
Worker implement a small, versioned runtime. A definition can use only the
runtime's registered surfaces, actions, scoring rules, and visual tokens.

This lets requests such as "a chaotic pigeon game where I dodge office
furniture" create a fresh tap-dodge configuration, while rejecting a request
whose mechanics are not representable safely.

## Existing behavior and migration

`trivia` and `blackjack` are currently named hardcoded engines. They remain
readable and playable without a data migration. The new procedural path is a
separate discriminated state and view contract. No existing game row changes
shape.

## Runtime v1

V1 has two renderer surfaces:

| Surface | Generated definition controls | Player actions | Intended prompts |
| --- | --- | --- | --- |
| `choice_rounds` | title, prompt copy, 2-4 choices, round count, scoring mode, visual tokens | join, choose, advance | trivia, quick vote, ranking, social prompts |
| `tap_dodge` | title, theme, deterministic seed, run length, obstacle rhythm, difficulty, visual tokens | start, tap replay submission | one-thumb obstacle / flap-like challenges |

`choice_rounds` is not named trivia or voting. `scoring: "correct"` records a
predeclared correct choice; `scoring: "plurality"` records the majority
choice. The generator fills the definition, not the reducer or the UI.

`tap_dodge` is a single-player score challenge in v1. The iPhone runs a local
deterministic animation, then submits timestamped taps. The Worker replays the
same fixed-point simulation from the stored seed and accepts only its computed
score. A score claim without a valid replay is rejected.

## Creation flow

```
prompt
  -> Jev capability decision
  -> deterministic gate
  -> OpenAI procedural-definition generation
  -> Zod validation + simulation
  -> persisted game + iMessage card
  -> native surface renderer
```

Jev receives a single bounded `surface` Choice question with choices
`choice_rounds`, `tap_dodge`, and `needs_choice`; and a separate Noul
copy-risk question. The chosen surface and Noul probability must be interpreted by a
deterministic gate:

- `copyRisk = true` returns original alternatives and does not generate a
  game.
- `needs_choice`, low confidence, malformed results, an absent gateway key,
  or unsupported surface returns a picker result and does not write a game.
- an accepted surface is passed to the OpenAI generator with only that
  surface's schema.

The route record retains `surface`, `confidence`, `status`, and a stable
decision version. It never retains authorization headers or raw provider
responses.

## API contract

`POST /api/widget/:chat/game` becomes a tagged response:

```ts
type CreateGameResponse =
  | { status: "created"; id: string; title: string; route: AcceptedRoute }
  | { status: "needs_choice"; promptId: string; choices: SurfaceChoice[]; route: PendingRoute }
  | { status: "copy_risk"; promptId: string; alternatives: SurfaceChoice[]; route: PendingRoute };
```

An opaque, short-lived `promptId` stores the original prompt and approved
surface server-side. A follow-up POST sends `{ promptId, surface }`; it never
concatenates a client-provided instruction onto the original prompt.

`GET /api/widget/:chat/game/:id` returns the legacy `GameView` for legacy
games or a tagged `ProceduralGameView` for procedural games. The extension
switches on that tag before decoding surface fields.

## Definition validation and simulation

Each definition has a strict Zod schema with bounded strings, round counts,
choice counts, durations, difficulty, seed, and semantic visual tokens. The
Worker validates referenced actions and runs its surface simulator before
writing SQLite state.

For `choice_rounds`, the simulator joins representative players, chooses a
legal option per round, advances through terminal state, and verifies bounded
scores. For `tap_dodge`, the simulator checks numeric bounds and runs a
canonical no-input and valid-input replay. The simulator is a runtime contract,
not a model judgment.

## Native rendering

The extension has one `ProceduralGameView` shell and two surface renderers.
They receive an already-redacted view; generated data can choose only semantic
tokens mapped to the existing native palette and typography. Debug builds show
route, validation outcome, and a concise definition summary in Game Lab.

The iPhone is the visual/end-to-end loop. Xcode previews use static fixtures
for chooser, both procedural lobbies, active choice round, and tap-dodge
completion. Production does not show route diagnostics.

## Evaluation

The repository owns two checked-in corpora:

1. routing prompts with expected surface/status and allowed alternatives;
2. definition fixtures that must parse and simulate without a model call.

The deterministic suite validates corpora, gates, simulators, and HTTP
response shapes. The opt-in live Jev suite reports route accuracy, abstention
quality, confident errors, and latency. It must be run only with
`AI_GATEWAY_API_KEY` configured and must not create cards or mutate D1.

## Acceptance criteria

- Existing Trivia and Blackjack games continue to play unchanged.
- A clear social-choice prompt creates a fresh `choice_rounds` definition.
- A clear one-thumb obstacle prompt creates a fresh `tap_dodge` definition.
- Ambiguous, unsupported, or copy-risk prompts return a safe picker with no
  game row or card.
- Every accepted definition parses and reaches a terminal simulation before
  persistence.
- Debug builds show route/validation metadata and render fixtures locally;
  production cards expose no diagnostics.
