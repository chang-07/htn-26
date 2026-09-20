# Prompt-generated games: routing, engines, and evaluation

## Goal

Turn a natural-language request into an original, short, social game that has
the quick, phone-native form factor of an iMessage mini-game without copying
an existing game's rules, name, or assets.

The product must make a reliable distinction between:

1. choosing a supported game form;
2. authoring content inside that form; and
3. running and rendering the resulting game.

## Non-goals for the first implementation

- Running generated Swift, JavaScript, shader, or physics code.
- Cloning named third-party games or their exact rules.
- Real-time networked arcade multiplayer.
- A generic arbitrary-game runtime that promises to render unknown mechanics.

## Assumptions

- The existing OpenAI path remains the generative model used to author game
  definitions and content.
- TypeSafe Jev is invoked through Vercel AI Gateway and is used for typed,
  calibrated classification and validation only.
- The Cloudflare Worker remains the public API and source of truth for game
  state. The iMessage extension remains a native renderer.
- Initial synchronous arcade games are single-player score challenges; social
  turn games may be asynchronous.

## End-to-end flow

```
prompt
  -> Jev route decision
  -> deterministic route gate
  -> engine-specific OpenAI definition generation
  -> schema validation and deterministic simulation
  -> persisted game and iMessage card
  -> native component renderer
```

Jev never authors a game. OpenAI never selects an unrestricted renderer. The
server owns all game rules, state changes, and scoring.

## Jev routing contract

Jev receives the prompt plus the currently enabled routes. It returns a typed
choice and calibrated confidence for each question:

- `genre`: `social`, `word`, `board`, `cards`, or `arcade`.
- `mechanic`: a currently registered engine ID, such as `trivia`,
  `blackjack`, `secret_vote`, `word_chain`, `grid_capture`, or `tap_dodge`.
- `sync`: `async_turns`, `live_room`, or `solo_score`.
- `copyRisk`: whether the request seeks to duplicate a named game or
  recognisable protected presentation.
- `supported`: whether the requested mechanic can be rendered by the enabled
  component library.

The route gate is ordinary TypeScript:

- A supported choice at or above the configured confidence threshold proceeds
  to that engine.
- A supported choice below the threshold produces 2-3 short game-form choices
  for the requester rather than silently guessing.
- Copy-risk requests preserve the desired energy/theme but require an original
  mechanic and title.
- Unsupported requests become the nearest supported option only after the
  requester chooses it; they are never represented as a playable game.

The first release uses one threshold for all routes. Per-route thresholds may
be introduced only after the labeled corpus shows meaningful calibration
differences.

## Engine registry

The current Trivia and Blackjack implementations become registry entries. A
registry entry provides:

- an engine ID and typed definition schema;
- a typed state schema and deterministic reducer;
- legal player actions;
- a `view()` projection safe for each player;
- a simulation harness; and
- the renderer ID the iMessage client must use.

No engine may depend on another engine's internal state. Shared lobby,
players, scores, timers, results, persistence, and routing remain outside the
engine.

### First renderer/component families

| Family | Shared components | Candidate original mechanics |
| --- | --- | --- |
| Shared | lobby, player chips, score table, timer, results, retry/error | all games |
| Turn | prompt card, choices, vote controls, turn status | secret vote, ranking, word chain |
| Board | grid, pieces, paths, hidden-information treatment | grid capture, territory puzzle |
| Cards | hand, deck, discard, action card | original card/showdown games |
| Arcade | canvas, one-thumb control, run score, results | tap-dodge, lane switch, rhythm tap |

All visual values are semantic tokens. Generated definitions may choose a
bounded `mood`, `accent`, `iconStyle`, and `layout`; the native app maps those
to its existing colors, typography, spacing, shapes, and motion. Definitions
cannot supply arbitrary colors, fonts, assets, or UI source.

## Definition generation and validation

Once the route is selected, an engine-specific generator receives only that
engine's schema, prompt, allowed visual tokens, player/sync constraints, and
the original-game rule. It returns a structured definition.

Before persistence, the Worker must:

1. parse the definition with its engine schema;
2. confirm referenced UI primitives are registered;
3. run a deterministic full-game simulation with representative players;
4. reject impossible states, unavailable actions, score overflows, and paths
   that cannot reach a terminal result; and
5. optionally ask Jev whether the generated definition still matches the
   original prompt and chosen route.

Failures are reported as a generation retry or a short alternative picker;
they never create a half-playable game card.

## Evaluation rubric

The repository owns a versioned labeled corpus. Each case contains a prompt,
an expected route, allowed alternate routes when genuinely ambiguous, a
minimum confidence, and a reason.

The corpus has, for every enabled route:

- clear direct prompts;
- creative paraphrases;
- deliberately ambiguous prompts;
- unsupported-mechanic prompts;
- copy-risk prompts; and
- adversarial/nonsensical prompts.

The runner records selected route, confidence, gate outcome, latency, and
pass/fail. Reports include route accuracy, inappropriate confident-route rate,
abstention quality, and a confusion matrix. A confident incorrect classification
counts as worse than an uncertainty that correctly opens the picker.

Generator evaluation is separate: it runs the selected definition through
schema validation and simulation, then records which component family and
visual tokens were selected. Routing success must not mask a broken game.

## Visual and human review

Debug builds expose a Game Lab through the existing Make a Game flow. It shows
the prompt, Jev decision/confidence, selected engine, and validation outcome,
then renders the game exactly as a user sees it. It supports rerunning a prompt
and recording a mismatch reason.

SwiftUI previews form a permanent component gallery. Every registered renderer
has fixtures for lobby, active interaction, waiting, reveal, completion, and
failure. These previews are the fast no-network visual loop; the connected
iPhone is the end-to-end loop against a reachable Worker.

## Rollout order

1. Add the Jev client, routing types, labeled classification corpus, and report
   runner without changing current game creation.
2. Route existing Trivia and Blackjack through the registry and verify behavior
   parity with current tests.
3. Add shared/turn components and one original social engine.
4. Add the Arcade family and one `tap_dodge` engine as a solo-score challenge.
5. Add Game Lab metadata and component gallery fixtures.
6. Use corpus failures and visual reviews to choose each subsequent engine.

## Acceptance criteria

- Existing Trivia and Blackjack flows remain playable.
- Every generated game selects a registered engine and native renderer.
- Unsupported or uncertain prompts reach a visible chooser rather than a
  broken game.
- The classification eval runs deterministically from a checked-in corpus;
  live Jev calls are opt-in and report confidence/latency.
- Every engine passes a deterministic simulation before a game is stored.
- Every renderer has fixture coverage for its major states and can be inspected
  in Xcode previews and on a connected iPhone.
