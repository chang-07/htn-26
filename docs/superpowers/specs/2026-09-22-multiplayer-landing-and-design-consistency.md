# Multiplayer landing and design consistency

## Goal

Land the sandbox multiplayer runtime that exists only in the working tree,
prove it works without spending model tokens, surface generated web games
where people look for them, and bring every colour and voice source back to
one set before the demo video is shot.

## State of the tree on 2026-09-22

`main` is dirty. Two unrelated features are interleaved in the same files and
neither is committed.

**Multiplayer runtime, untracked and unwired on `main`.**

- `src/server/game-web-runtime.ts` is untracked. It holds the `window.WHIM`
  runtime (lobby, compare-and-swap saves, 1.2 s polling), `injectWhimMultiplayer`,
  and `shouldBuildWebGame`.
- `src/server/agent.ts` (modified): routes copy-risk, board-game and multiplayer
  prompts to the sandbox via `shouldBuildWebGame`; the generator prompt now
  describes the `WHIM` API instead of a raw state URL.
- `src/server/index.ts` (modified): injects the runtime into every served page.
- `ios/MessagesExtension/MessagesViewController.swift` (modified, first hunk):
  appends `?player=<device name>` when opening a web game.
- `scripts/game-web-runtime.test.mjs` is untracked and one of its three tests
  fails on a wrong regex (`/WHIM\.ready/` against source that spells it
  `ready:`). The runtime is fine; the assertion is wrong.

On committed `main`, the sandbox tells the model about a GET/PUT state URL and
leaves it to write its own sync. No runtime, no player identity, no routing
for multiplayer wording. "Setting up multiplayer" means landing this work.

**Camera Runner result posters, uncommitted.**

- `InfiniteRunnerView.swift`: `RunnerCardBanner` replaced by
  `RunnerResultWidget` with won / lost / challenge outcomes.
- `MessagesViewController.swift` (remaining hunks): `sendRunnerChallenge`
  builds `result`, `run`, `vs` query params and per-outcome captions.
- `PreviewsApp.swift`: gallery entries for won and lost posters.
- `Plan.xcodeproj/project.pbxproj`: xcodegen output adding the
  `kerenel_Cards_seperated` resource folder already declared in `project.yml`.

**Verified on the dirty tree:** `npm run typecheck` exits 0. `npm test` is
178 of 179 with the one regex failure above. `xcodebuild` of `PlanPreviews`
for `generic/platform=iOS` with signing off reports `BUILD SUCCEEDED`.

## Decisions

**Two commits, not one.** Server multiplayer wiring and iOS runner posters are
separate features and get separate commits. `MessagesViewController.swift`
carries hunks of both; it lands whole in the runner commit and that commit's
message says so. Splitting the file with patch surgery is possible but not
worth the failure mode.

**Prove the sandbox by seeding, not by generating.** A localhost-only
`/api/dev/seedwebgame` route plants an HTML document straight into the chat
object, mirroring `/api/dev/seedgame`. That makes the serve path, the CSP, the
runtime injection and the compare-and-swap endpoint all checkable with curl
and no model.

**Web games join the recent-games shelf.** `gamesList` reads only the `games`
table, so sandbox games never appear in the drawer. The fix stores a small
`game_web_meta:<id>` record at creation and unions it in, with `surface: "web"`
so the extension routes to `/game-web/` instead of `/game/`.

**Jev's verdict gets logged on the sandbox path.** Nothing records that a game
was routed there for copy risk. One `note` line at routing time fixes the
audit gap.

**The palette source of truth is `src/theme.ts`.** `card.ts`, `Landing.css`
and `DesignSystem.swift` already agree with it. `docs/card-design.md` and
`docs/widget-rubric.md` do not, and the rubric names the stale doc as its R1
source, so the rubric currently gates on colours the code never renders.
Fix the two docs; touch no rendering code for this.

**The native brand green goes.** `Whim.green` (`#179B6B`) and `Whim.greenDeep`
(`#0E6F4C`) appear in ten places in SwiftUI and nowhere in the cards or the
web. `theme.ts` states accents are pink and teal only, and provides `cactus`
(`#1f5f4f`) as an illustration-only colour. Mapping: text and chip tints to
`mintInk`; fills and gradients to `mintInk` and `mint`; the runner's cactus
obstacles to a new `Whim.cactus` matching `theme.ts`. The `"mint"` visual
token in `GameViews.swift` currently returns `Whim.green`; it returns
`Whim.mint`.

**The `make_game` tool description describes the router.** It still reads
"Generate a trivia game", written before the surface router and the sandbox
tier existed, and steers the model toward calling it for trivia only.

**The agent's voice stays lowercase.** The `say()` strings are deliberately
lowercase and terse. Two have drifted to a capital `I` and an em-dash. They
are rewritten in the house voice. The full 39-line pass with `no-ai-slop` is a
separate session.

**Commit trailer.** 29 of Luka's 43 commits in this repo carry a
`Co-Authored-By: Claude` trailer, so commits made under this plan carry
`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Out of scope, listed so nobody re-derives them

- Browser fallback player identity. A link-card player has no `?player=` and
  every such player is "Player", colliding into one lobby entry. Only hits
  phones without the extension; the demo phones have it.
- The three unreachable `copy_risk` branches (`agent.ts:1990`, `agent.ts:3105`,
  `GameViews.swift:913`). Dead since the sandbox exit was added above them.
- A copy guard in the sandbox generator prompt. Product decision.
- The full `no-ai-slop` pass over all 39 `say()` lines and the 167-line
  persona.
- `gsap`, `motion`, `ogl` in `package.json`, unused.
- The `stash@{0}` from `feature/imessage-extension`. Leave it.
