# Multiplayer Landing and Design Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Commit the uncommitted sandbox multiplayer runtime and runner posters, make the sandbox path verifiable with curl, put generated web games on the recent-games shelf, and reconcile every colour and voice source to `src/theme.ts` and the house voice.

**Architecture:** Phase 0 lands work that already exists in the working tree as two clean commits. Phase 1 adds a localhost seed route so the sandbox serve path, CSP, runtime injection and compare-and-swap endpoint can be checked without a model. Phase 2 closes two demo-visible gaps in the sandbox tier. Phase 3 is docs, one Swift token bug, the native green swap, and two copy lines. No new dependencies, no schema changes, no new Cloudflare bindings.

**Tech Stack:** Cloudflare Workers, TypeScript 5.9, Zod 4, Node 22 test runner, SwiftUI (iOS 16+), xcodegen, curl.

**Spec:** `docs/superpowers/specs/2026-09-22-multiplayer-landing-and-design-consistency.md`

## Global Constraints

- Work on a branch: `git checkout -b feature/multiplayer-landing` from `main`. The dirty working tree carries over; that is intended.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Commit subjects follow the repo style: `type(scope): lowercase clause`, no trailing period.
- `npm run typecheck` exits 0 and `npm test` reports `fail 0` after every server task.
- After every Swift task: `cd ios && xcodebuild -project Plan.xcodeproj -scheme PlanPreviews -destination 'generic/platform=iOS' -derivedDataPath build-preview CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E 'error:|BUILD'` prints `** BUILD SUCCEEDED **` and no `error:` lines.
- Palette source of truth is the `PALETTE` object in `src/theme.ts`. No rendering code changes its values.
- `say()` strings are lowercase, contain no em-dash, and never use the pronoun `I`.
- Do not touch `stash@{0}`, `.visflow/`, or `ios/build-preview/` beyond adding the latter two to `.gitignore`.
- Never `git add .` or `git add -A`. Every add names its files.

## Review Focus

1. A generated page with neither `</head>` nor `<body` gets the runtime prepended. The existing test covers only `</head>`; Task 1 adds the other two paths.
2. A `game_web_meta:<id>` row whose `game_web_state:<id>` is missing or blank must list the game with zero players and no phase, never throw. Task 4 guards `getMeta` returning `undefined` and skips rows whose value is `""`.
3. Two phones PUT the same `expectedRevision` at once: exactly one gets 200 and one gets 409. The Durable Object is single-threaded and `gameWebPutState` is one synchronous read-compare-write, so this holds by construction; Task 3 checks the sequential case with curl.
4. Tapping a web game on the shelf while `recallChat()` returns nil (extension opened cold) must do nothing rather than crash. Task 4 mirrors the `guard let known` from the `.game` case.
5. A `make_game` tool description that still says "trivia" steers the model into calling the tool for trivia only. Task 9 rewrites it; `scripts/tools.test.mjs` runs to confirm no snapshot depends on the old string.

---

## Phase 0: land the working tree

### Task 1: Fix the runtime test and commit the multiplayer server work

**Files:**
- Modify: `scripts/game-web-runtime.test.mjs`
- Add: `src/server/game-web-runtime.ts` (untracked, already complete)
- Add: `scripts/game-web-runtime.test.mjs`
- Commit as-is: `src/server/agent.ts`, `src/server/index.ts`

**Interfaces:**
- Produces: `injectWhimMultiplayer(html: string): string`, `shouldBuildWebGame(prompt: string, route: { status: string }): boolean`, `WHIM_MULTIPLAYER_RUNTIME: string` from `src/server/game-web-runtime.ts`, all consumed by Tasks 3 and 5.

- [ ] **Step 1: Branch**

```bash
cd ~/Documents/GitHub/htn-26
git checkout -b feature/multiplayer-landing
git status --short
```

Expected: six `M` lines and five `??` lines, unchanged from `main`.

- [ ] **Step 2: Run the failing test to see the exact failure**

```bash
node --test scripts/game-web-runtime.test.mjs 2>&1 | grep -E 'not ok|expected:'
```

Expected: `not ok 3 - runtime exposes join, save, and poll helpers` and `expected: /WHIM\.ready/`.

- [ ] **Step 3: Replace the third test and add the two injection paths**

Replace the entire contents of `scripts/game-web-runtime.test.mjs` with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { injectWhimMultiplayer, shouldBuildWebGame, WHIM_MULTIPLAYER_RUNTIME } from "../src/server/game-web-runtime.ts";

test("injectWhimMultiplayer adds the runtime before </head>", () => {
  const html = "<html><head><title>T</title></head><body></body></html>";
  const out = injectWhimMultiplayer(html);
  assert.match(out, /window\.WHIM/);
  assert.ok(out.indexOf("window.WHIM") < out.indexOf("</head>"));
});

test("injectWhimMultiplayer falls back to after <body> when there is no head", () => {
  const html = "<html><body class=\"x\"><p>hi</p></body></html>";
  const out = injectWhimMultiplayer(html);
  assert.ok(out.indexOf("<body class=\"x\">") < out.indexOf("window.WHIM"));
  assert.ok(out.indexOf("window.WHIM") < out.indexOf("<p>hi</p>"));
});

test("injectWhimMultiplayer prepends when there is neither head nor body", () => {
  const html = "<html><p>bare</p></html>";
  const out = injectWhimMultiplayer(html);
  assert.ok(out.startsWith("<script>"));
  assert.ok(out.indexOf("window.WHIM") < out.indexOf("<p>bare</p>"));
});

test("shouldBuildWebGame routes copy-risk and multiplayer board games to web", () => {
  assert.equal(shouldBuildWebGame("uno for our group", { status: "copy_risk" }), true);
  assert.equal(shouldBuildWebGame("two player tic tac toe with friends", { status: "needs_choice" }), true);
  assert.equal(shouldBuildWebGame("quick trivia about cats", { status: "needs_choice" }), false);
  assert.equal(shouldBuildWebGame("chess with friends", { status: "accepted" }), false);
});

test("runtime defines the lobby, save, and poll entry points", () => {
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\bready:\s*async function/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\bsetGame:\s*function/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\bpatchGame:\s*function/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\bonRemote:\s*function/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /window\.WHIM\.startPolling\(\)/);
});

test("runtime reads the player from the query and caps it at 32 characters", () => {
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /params\.get\("player"\)/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /\.slice\(0, 32\)/);
});
```

- [ ] **Step 4: Run the file, then the whole suite**

```bash
node --test scripts/game-web-runtime.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'
npm run typecheck; echo "typecheck exit=$?"
```

Expected: file reports `tests 6`, `pass 6`, `fail 0`. Suite reports `tests 182`, `pass 182`, `fail 0`. Typecheck exit 0.

- [ ] **Step 5: Commit the server half**

```bash
git add src/server/game-web-runtime.ts scripts/game-web-runtime.test.mjs src/server/agent.ts src/server/index.ts
git diff --cached --stat
```

Expected: four files. `agent.ts` around +19/-11, `index.ts` +2/-1, the other two as new.

```bash
git commit -m "feat(games): WHIM multiplayer runtime injected into every sandbox game

The generated page gets a shared lobby, compare-and-swap saves and a 1.2 s
poll spliced into its head at serve time, never stored. The generator prompt
describes that API instead of a raw state URL. Named board games and any
multiplayer wording route to the sandbox alongside copy-risk prompts.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: Commit the runner posters and quiet the tree

**Files:**
- Commit as-is: `ios/MessagesExtension/InfiniteRunnerView.swift`, `ios/MessagesExtension/MessagesViewController.swift`, `ios/PreviewApp/PreviewsApp.swift`, `ios/Plan.xcodeproj/project.pbxproj`
- Modify: `.gitignore`

- [ ] **Step 1: Confirm the Swift builds before committing it**

```bash
cd ~/Documents/GitHub/htn-26/ios
xcodebuild -project Plan.xcodeproj -scheme PlanPreviews -destination 'generic/platform=iOS' -derivedDataPath build-preview CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E 'error:|BUILD'
cd ..
```

Expected: `** BUILD SUCCEEDED **`, no `error:` lines.

- [ ] **Step 2: Ignore the two untracked build and tracker directories**

Append to `.gitignore`, after the `**/xcuserdata/` line:

```
ios/build-preview/
.visflow/
```

- [ ] **Step 3: Verify the tree is now quiet apart from the four Swift files**

```bash
git status --short
```

Expected: exactly `M .gitignore` plus the four `M` iOS files. No `??` lines.

- [ ] **Step 4: Commit**

```bash
git add .gitignore ios/MessagesExtension/InfiniteRunnerView.swift ios/MessagesExtension/MessagesViewController.swift ios/PreviewApp/PreviewsApp.swift ios/Plan.xcodeproj/project.pbxproj
git commit -m "feat(ios): runner result posters, and web games open with the player named

RunnerCardBanner becomes RunnerResultWidget: won, lost, or challenge is the
picture, with the score line under it, in the transcript bubble and as the
MSMessage image. The card URL carries result, run and vs so the poster
re-renders from the URL alone.

Also in MessagesViewController: a /game-web/ card opens with
?player=<device name> appended, so the WHIM lobby knows who joined. Same
file, so it lands here rather than with the server half.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

## Phase 1: prove the sandbox without a model

### Task 3: A localhost seed route for web games

**Files:**
- Modify: `src/server/agent.ts:1888-1930` (`gameWebCreate`, `buildWebGame`)
- Modify: `src/server/index.ts:572-577` (after the `seedgame` block in `handleDev`)
- Create: `scripts/fixtures/web-game.json`
- Modify: `README.md` (one line under the simulator section)

**Interfaces:**
- Produces: `PlanAgent.devCreateWebGame(html: string, title?: string): Promise<{ id: string; title: string }>` and a private `storeWebGame(id, html, title)` shared with `buildWebGame`. Task 4 extends `storeWebGame`.

- [ ] **Step 1: Write the fixture the curl checks will send**

Create `scripts/fixtures/web-game.json`:

```json
{
  "chat": "demo",
  "title": "Seeded lobby",
  "html": "<html><head><title>Seeded lobby</title></head><body><h1 id=who>joining</h1><script>(async()=>{const s=await WHIM.ready();document.getElementById('who').textContent=WHIM.players().map(p=>p.name).join(', ');WHIM.onRemote(st=>{document.getElementById('who').textContent=st.players.map(p=>p.name).join(', ')});})();</script></body></html>"
}
```

- [ ] **Step 2: Start the dev server in a second terminal and confirm the route does not exist yet**

Terminal 2: `npm run dev`. Then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:5173/api/dev/seedwebgame -H 'content-type: application/json' -d @scripts/fixtures/web-game.json
```

Expected: `404`.

- [ ] **Step 3: Pull the storage lines out of `buildWebGame` into a shared helper, and add the dev entry point**

In `src/server/agent.ts`, inside `buildWebGame`, replace these three lines:

```ts
    this.setMeta(`game_web:${id}`, html);
    this.setMeta(`game_web_state:${id}`, JSON.stringify({ revision: 0, state: null }));
    const title = (html.match(/<title>([^<]{1,64})<\/title>/i)?.[1] ?? prompt.slice(0, 48)).trim();
    this.note("info", "game_web.created", { id, title, bytes: html.length });
```

with:

```ts
    const title = (html.match(/<title>([^<]{1,64})<\/title>/i)?.[1] ?? prompt.slice(0, 48)).trim();
    this.storeWebGame(id, html, title);
```

Then add these two methods directly after `buildWebGame`'s closing brace:

```ts
  /** Writes a generated web game and its empty state. Shared by the builder and the dev seed. */
  private storeWebGame(id: string, html: string, title: string) {
    this.setMeta(`game_web:${id}`, html);
    this.setMeta(`game_web_state:${id}`, JSON.stringify({ revision: 0, state: null }));
    this.note("info", "game_web.created", { id, title, bytes: html.length });
  }

  /** Local smoke-test entry point: plants an HTML game with no model call and no card. */
  async devCreateWebGame(html: string, title?: string): Promise<{ id: string; title: string }> {
    const id = crypto.randomUUID().slice(0, 12);
    const name = (title ?? html.match(/<title>([^<]{1,64})<\/title>/i)?.[1] ?? "dev web game").trim();
    this.storeWebGame(id, html, name);
    return { id, title: name };
  }
```

- [ ] **Step 4: Add the route in `handleDev`**

In `src/server/index.ts`, directly after the `/api/dev/seedgame` block (the one ending `return Response.json(await agent.devCreateGame(...));` and its closing `}`), add:

```ts
  if (url.pathname === "/api/dev/seedwebgame") {
    const html = body.html;
    if (typeof html !== "string" || !/<html[\s>]/i.test(html)) return new Response("html with an <html> tag is required", { status: 400 });
    return Response.json(await agent.devCreateWebGame(html, typeof body.title === "string" ? body.title : undefined));
  }
```

- [ ] **Step 5: Typecheck, then seed and walk the whole serve path**

```bash
npm run typecheck; echo "typecheck exit=$?"
```

Expected: exit 0. The dev server hot-reloads; if it does not, restart it. Then:

```bash
ID=$(curl -s -X POST localhost:5173/api/dev/seedwebgame -H 'content-type: application/json' -d @scripts/fixtures/web-game.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')
echo "id=$ID"
```

Expected: a 12-character id.

```bash
curl -s -D - localhost:5173/game-web/demo/$ID -o /tmp/served.html | grep -iE '^(HTTP|content-security-policy|cross-origin-opener)'
grep -c 'window.WHIM.startPolling' /tmp/served.html
grep -c '<script>' /tmp/served.html
```

Expected: `HTTP/1.1 200`, a `content-security-policy` line beginning `sandbox allow-scripts; default-src 'none'`, `cross-origin-opener-policy: same-origin`, then `1` (the runtime is present once), then `2` (the injected runtime plus the fixture's own script).

```bash
curl -s localhost:5173/game-web/demo/$ID/state
```

Expected: `{"revision":0,"state":null}`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PUT localhost:5173/game-web/demo/$ID/state -H 'content-type: application/json' -d '{"expectedRevision":0,"state":{"players":[{"id":"a","name":"A"}],"game":null}}'
curl -s -o /dev/null -w '%{http_code}\n' -X PUT localhost:5173/game-web/demo/$ID/state -H 'content-type: application/json' -d '{"expectedRevision":0,"state":{"players":[{"id":"b","name":"B"}],"game":null}}'
curl -s localhost:5173/game-web/demo/$ID/state
```

Expected: `200`, then `409` (stale revision), then `{"revision":1,"state":{"players":[{"id":"a","name":"A"}],"game":null}}`. The second writer lost and the first writer's state stands.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS localhost:5173/game-web/demo/$ID/state
curl -s -D - -o /dev/null localhost:5173/game-web/demo/$ID/state | grep -i 'access-control-allow-origin'
```

Expected: `204`, then `access-control-allow-origin: *`.

- [ ] **Step 6: Document the route and run the suite**

In `README.md`, in the simulator curl block that starts with `curl -X POST localhost:5173/api/dev/message`, add one more example after it:

```sh
# plant a generated web game without a model; the id serves at /game-web/demo/<id>
curl -X POST localhost:5173/api/dev/seedwebgame -H 'content-type: application/json' \
  -d @scripts/fixtures/web-game.json
```

```bash
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'
```

Expected: `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/server/agent.ts src/server/index.ts scripts/fixtures/web-game.json README.md
git commit -m "feat(dev): seed a web game without a model

/api/dev/seedwebgame plants an HTML document into the chat object the same
way the builder does, so the serve path, the sandbox policy, the injected
runtime and the compare-and-swap endpoint can all be checked with curl.
buildWebGame and the seed share one storeWebGame.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

## Phase 2: demo-visible sandbox gaps

### Task 4: Web games on the recent-games shelf

**Files:**
- Modify: `src/server/agent.ts` (`storeWebGame` from Task 3, and `gamesList`)
- Modify: `ios/MessagesExtension/HomeView.swift:6-9`, `:56`, `:150`, `:174`
- Modify: `ios/MessagesExtension/MessagesViewController.swift:161-165`

**Interfaces:**
- Consumes: `storeWebGame(id, html, title)` from Task 3.
- Produces: `gamesList()` entries now include `{ surface: "web" }` rows. `HomeRoute.webGame(String)` in Swift.

- [ ] **Step 1: See the shelf miss a web game**

With the dev server up and the `$ID` from Task 3 still seeded:

```bash
curl -s localhost:5173/api/widget/demo/games
```

Expected: `[]`. The web game is stored but not listed.

- [ ] **Step 2: Record creation time alongside the HTML**

In `src/server/agent.ts`, in `storeWebGame`, add one line after the `game_web_state` write:

```ts
    this.setMeta(`game_web_meta:${id}`, JSON.stringify({ title, ts: Date.now() }));
```

- [ ] **Step 3: Union web games into `gamesList`**

Replace the whole `gamesList` method with:

```ts
  async gamesList() {
    const native = this.sql<{ json: string; ts: number }>`SELECT json, ts FROM games ORDER BY ts DESC LIMIT 8`
      .map((row) => {
        const g = JSON.parse(row.json) as StoredGame;
        return {
          id: g.id,
          title: g.spec.title,
          surface: isProceduralGame(g) ? g.spec.surface : g.spec.kind,
          phase: g.phase,
          players: Object.keys(g.players).length,
          ts: row.ts,
        };
      });
    // Sandbox games live in meta, not the games table. A blank value is a
    // cleared key and is skipped; a missing state row lists as an empty lobby.
    const web = this.sql<{ key: string; value: string }>`SELECT key, value FROM meta WHERE key LIKE 'game_web_meta:%' AND value != ''`
      .map((row) => {
        const id = row.key.slice("game_web_meta:".length);
        const meta = JSON.parse(row.value) as { title: string; ts: number };
        const raw = this.getMeta(`game_web_state:${id}`);
        const state = raw ? (JSON.parse(raw) as { state: { players?: unknown[]; game?: unknown } | null }).state : null;
        return {
          id,
          title: meta.title,
          surface: "web",
          phase: state?.game ? "play" : "lobby",
          players: state?.players?.length ?? 0,
          ts: meta.ts,
        };
      });
    return [...native, ...web].sort((a, b) => b.ts - a.ts).slice(0, 8);
  }
```

- [ ] **Step 4: Typecheck, re-seed, and read the shelf**

```bash
npm run typecheck; echo "typecheck exit=$?"
curl -s -X POST localhost:5173/api/dev/seedwebgame -H 'content-type: application/json' -d @scripts/fixtures/web-game.json > /dev/null
curl -s localhost:5173/api/widget/demo/games | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).map(g=>`${g.surface} ${g.phase} ${g.players} ${g.title}`).join("\n")'
```

Expected: exit 0, then at least one line `web lobby 0 Seeded lobby`. The game seeded in Task 3 has no meta row and stays unlisted; that is correct, the key was added after it.

Now seed a definition game too and confirm both kinds list, newest first:

```bash
curl -s -X POST localhost:5173/api/dev/seedgame -H 'content-type: application/json' -d '{"chat":"demo","voter":"dev","name":"Dev","spec":{"version":1,"kind":"trivia","title":"Four cats","topic":"cats","questions":[{"q":"How many legs on a cat?","options":["2","3","4","5"],"correct":2},{"q":"A cat says what sound?","options":["moo","meow","woof","oink"],"correct":1},{"q":"Cats are what kind of animal?","options":["bird","fish","mammal","reptile"],"correct":2},{"q":"A baby cat is a what?","options":["pup","kit","calf","cub"],"correct":1}]}}' > /dev/null
curl -s localhost:5173/api/widget/demo/games | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).map(g=>`${g.surface} ${g.title}`).join("\n")'
```

Expected: first line `trivia Four cats`, second line `web Seeded lobby`.

- [ ] **Step 5: Route web games from the shelf on iOS**

In `ios/MessagesExtension/HomeView.swift`, change the enum at lines 6 to 9 to:

```swift
enum HomeRoute {
    case plan, cart, playlist, runner, slots
    case game(String)
    case webGame(String)
}
```

At line 56, change the shelf's closure from `{ onRoute(.game($0)) }` to:

```swift
                    RecentGamesView(base: base, chat: chat) { id, web in onRoute(web ? .webGame(id) : .game(id)) }
```

At line 150, change `let onOpen: (String) -> Void` to:

```swift
    let onOpen: (String, Bool) -> Void
```

At line 174, change `Button { onOpen(game.id) } label: {` to:

```swift
                        Button { onOpen(game.id, game.surface == "web") } label: {
```

In `ios/MessagesExtension/MessagesViewController.swift`, directly after the `case .game(let id):` block (which ends at the `present(url: known.base.appendingPathComponent("game/\(known.chat)/\(id)"))` line), add:

```swift
                case .webGame(let id):
                    guard let known = self.recallChat() else { return }
                    if self.presentationStyle == .compact { self.requestPresentationStyle(.expanded) }
                    self.present(url: known.base.appendingPathComponent("game-web/\(known.chat)/\(id)"))
```

`present(url:)` already handles a `/game-web/` path and appends the player name.

- [ ] **Step 6: Build**

```bash
cd ios && xcodebuild -project Plan.xcodeproj -scheme PlanPreviews -destination 'generic/platform=iOS' -derivedDataPath build-preview CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E 'error:|BUILD'; cd ..
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'
```

Expected: `** BUILD SUCCEEDED **`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add src/server/agent.ts ios/MessagesExtension/HomeView.swift ios/MessagesExtension/MessagesViewController.swift
git commit -m "feat(games): generated web games show on the recent-games shelf

gamesList read only the games table, so a sandbox game never appeared in the
drawer. A game_web_meta row now records title and time at creation, the list
unions it in with surface \"web\", and the shelf routes those to /game-web/.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: Log Jev's verdict on the sandbox path

**Files:**
- Modify: `src/server/agent.ts:36` (import), `:1875` (call site), `:1888` (`gameWebCreate` signature)

- [ ] **Step 1: Confirm nothing records the route today**

```bash
grep -n 'game_web.routed' src/server/agent.ts; echo "matches above: expect none"
```

- [ ] **Step 2: Thread the route into `gameWebCreate` and note it**

In the import on line 36, add `type GameRoute` so it reads:

```ts
import { GAME_SURFACES, classifyGamePrompt, generateProceduralDefinition, type AcceptedRoute, type CopyRiskRoute, type GameRoute, type GameSurface, type PendingRoute } from "./game-routing";
```

Change the call site in `gameCreate` from `return this.gameWebCreate(prompt);` to:

```ts
    if (shouldBuildWebGame(prompt, route)) return this.gameWebCreate(prompt, route);
```

Change the signature and add one note as the first statement of the body:

```ts
  async gameWebCreate(prompt: string, route: GameRoute): Promise<GameCreateResponse> {
    const id = crypto.randomUUID().slice(0, 12);
    const title = prompt.trim().slice(0, 48);
    this.note("info", "game_web.routed", { id, route: route.status, confidence: route.confidence });
```

- [ ] **Step 3: Typecheck and test**

```bash
npm run typecheck; echo "typecheck exit=$?"
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'
grep -n 'game_web.routed' src/server/agent.ts
```

Expected: exit 0, `fail 0`, one match.

- [ ] **Step 4: Commit**

```bash
git add src/server/agent.ts
git commit -m "fix(games): record why a prompt went to the sandbox

game_web.created carried only id, title and bytes, so nothing in run history
said whether Jev sent the prompt there for copy risk or for multiplayer
wording. One line at routing time now does.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

## Phase 3: design language

### Task 6: Palette docs match the code

**Files:**
- Modify: `docs/card-design.md:34-35`
- Modify: `docs/widget-rubric.md:18`

- [ ] **Step 1: See the stale values**

```bash
grep -n '#efe7d6\|#1f5f4f\|#241f17\|#f0ece2' docs/card-design.md docs/widget-rubric.md
```

Expected: four matches across the two files.

- [ ] **Step 2: Rewrite the ticket table**

In `docs/card-design.md`, replace lines 34 and 35:

```
| Ground | `#efe7d6` cream | `#1f5f4f` deep green |
| Ink | `#241f17` | `#f0ece2` |
```

with:

```
| Ground | `#faf9f6` paper | `#84efc4` teal |
| Ink | `#282827` | `#153c30` |
```

Directly under the table (after the `| Perforation |` row), add one line:

```
Values are `PALETTE` in `src/theme.ts`; `card.ts`, `Landing.css` and `DesignSystem.swift` read from or match it.
```

- [ ] **Step 3: Rewrite the rubric line**

In `docs/widget-rubric.md`, replace line 18:

```
- [5] Only the two grounds exist: cream `#efe7d6` open, green `#1f5f4f` done.
```

with:

```
- [5] Only the two grounds exist: paper `#faf9f6` open, teal `#84efc4` done, per `PALETTE` in `src/theme.ts`.
```

- [ ] **Step 4: Verify no stale hex remains in docs**

```bash
grep -rn '#efe7d6\|#241f17\|#f0ece2' docs/ src/ ios/ ; echo "matches above: expect none"
grep -n '#1f5f4f' docs/ src/theme.ts
```

Expected: no matches for the first three. Exactly one match for `#1f5f4f`, in `src/theme.ts` as `cactus`.

- [ ] **Step 5: Commit**

```bash
git add docs/card-design.md docs/widget-rubric.md
git commit -m "docs: palette docs name the colours the code renders

card-design.md and the widget rubric still quoted the pre-theme cream and
deep green, so the rubric's R1 gated on values card.ts never draws.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: The mint token returns mint

**Files:**
- Modify: `ios/MessagesExtension/GameViews.swift:219`

- [ ] **Step 1: See the bug**

```bash
sed -n '217,221p' ios/MessagesExtension/GameViews.swift
```

Expected: a `switch` over accent names where `case "mint": return Whim.green`.

- [ ] **Step 2: Fix the one line**

Change line 219 from `case "mint": return Whim.green` to:

```swift
        case "mint": return Whim.mint
```

- [ ] **Step 3: Build**

```bash
cd ios && xcodebuild -project Plan.xcodeproj -scheme PlanPreviews -destination 'generic/platform=iOS' -derivedDataPath build-preview CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E 'error:|BUILD'; cd ..
```

Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add ios/MessagesExtension/GameViews.swift
git commit -m "fix(ios): a game asking for mint gets mint

The visual token mapped to the native brand green instead of Whim.mint.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: Retire the native brand green

**Files:**
- Modify: `ios/MessagesExtension/DesignSystem.swift:14-22`, `:28`, `:93`
- Modify: `ios/MessagesExtension/HomeView.swift:108`
- Modify: `ios/MessagesExtension/GameViews.swift:267`, `:496`, `:745`
- Modify: `ios/MessagesExtension/InfiniteRunnerView.swift:570-573`

This is the one task with a visual outcome nobody has seen yet. It is last in the phase so everything before it lands even if this one is reverted.

- [ ] **Step 1: Count the sites to retire**

```bash
grep -c 'Whim\.green\b\|Whim\.greenDeep' ios/MessagesExtension/*.swift | grep -v ':0'
```

Expected: `DesignSystem.swift:3` (two declarations plus `tileGradient`), `HomeView.swift:1`, `GameViews.swift:4`, `InfiniteRunnerView.swift:3`.

- [ ] **Step 2: Replace the declarations**

In `ios/MessagesExtension/DesignSystem.swift`, replace lines 15 to 21:

```swift
    /// Brand green (the ticket PNGs' W tile).
    static let green = Color(red: 0x17 / 255, green: 0x9B / 255, blue: 0x6B / 255)
    static let greenDeep = Color(red: 0x0E / 255, green: 0x6F / 255, blue: 0x4C / 255)

    static var tileGradient: LinearGradient {
        LinearGradient(colors: [green, greenDeep], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
```

with:

```swift
    /// Illustration colour only (cactus art), matching `cactus` in src/theme.ts. Never a UI accent.
    static let cactus = Color(red: 0x1F / 255, green: 0x5F / 255, blue: 0x4F / 255)

    static var tileGradient: LinearGradient {
        LinearGradient(colors: [mintInk, mint], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
```

- [ ] **Step 3: Replace each use**

| File:line | From | To |
|---|---|---|
| `DesignSystem.swift:28` | `var chipTint: Color = Whim.green` | `var chipTint: Color = Whim.mintInk` |
| `DesignSystem.swift:93` | `.fill(i < current ? Whim.green : Color(uiColor: .systemFill))` | `.fill(i < current ? Whim.mintInk : Color(uiColor: .systemFill))` |
| `HomeView.swift:108` | `.foregroundStyle(Whim.green)` | `.foregroundStyle(Whim.mintInk)` |
| `GameViews.swift:267` | `chipTint: g.isProcedural ? gameTint(g) : Whim.green)` | `chipTint: g.isProcedural ? gameTint(g) : Whim.mintInk)` |
| `GameViews.swift:496` | `LinearGradient(colors: [Whim.greenDeep, Whim.green.opacity(0.65)],` | `LinearGradient(colors: [Whim.mintInk, Whim.mint],` |
| `GameViews.swift:745` | `.background(Whim.green.opacity(0.07),` | `.background(Whim.mintInk.opacity(0.07),` |
| `InfiniteRunnerView.swift:570` | `Capsule().fill(Whim.greenDeep).frame(width: 14, height: obstacleHeight)` | `Capsule().fill(Whim.cactus).frame(width: 14, height: obstacleHeight)` |
| `InfiniteRunnerView.swift:571` | `Capsule().fill(Whim.greenDeep).frame(width: 10, height: obstacleHeight * 0.45)` | `Capsule().fill(Whim.cactus).frame(width: 10, height: obstacleHeight * 0.45)` |
| `InfiniteRunnerView.swift:573` | `Capsule().fill(Whim.greenDeep).frame(width: 10, height: obstacleHeight * 0.38)` | `Capsule().fill(Whim.cactus).frame(width: 10, height: obstacleHeight * 0.38)` |

Line numbers are as of Task 7's commit; use the `From` text to locate each.

- [ ] **Step 4: Confirm nothing references the retired names, then build**

```bash
grep -n 'Whim\.green\b\|Whim\.greenDeep' ios/MessagesExtension/*.swift ios/PreviewApp/*.swift; echo "matches above: expect none"
cd ios && xcodebuild -project Plan.xcodeproj -scheme PlanPreviews -destination 'generic/platform=iOS' -derivedDataPath build-preview CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E 'error:|BUILD'; cd ..
```

Expected: no matches, `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Look at it once**

Build and run the `PlanPreviews` scheme in Xcode for Mac Catalyst (`open ios/Plan.xcodeproj`, select the PlanPreviews scheme and "My Mac (Mac Catalyst)", Run). In the gallery, open "Home · linked", any game screen with a lobby chip, and "Runner · sheet". Check three things: chips and progress dots are dark teal on paper and readable; the hidden card back is a dark-to-mint gradient; runner obstacles are the deep cactus green. If any of the three reads wrong, revert this task alone with `git checkout -- ios/` and note it in the handoff; the other seven commits stand.

- [ ] **Step 6: Commit**

```bash
git add ios/MessagesExtension/DesignSystem.swift ios/MessagesExtension/HomeView.swift ios/MessagesExtension/GameViews.swift ios/MessagesExtension/InfiniteRunnerView.swift
git commit -m "style(ios): native views use the theme's mint and mint ink, not a private green

Whim.green and greenDeep appeared in ten places on the phone and nowhere in
the cards or the web. Chips, dots and gradients now take mintInk and mint
from the shared palette; the runner's cactus obstacles take the theme's
illustration-only cactus.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: The `make_game` description describes the router

**Files:**
- Modify: `src/server/tools/index.ts:322-323`

- [ ] **Step 1: See the stale text**

```bash
sed -n '322,323p' src/server/tools/index.ts
```

Expected: a string beginning `"Generate a trivia game and post its card.`

- [ ] **Step 2: Replace the string**

Replace the `make_game:` description value with:

```ts
  make_game:
    "Generate a game and post its card. Call it for any ask to play a game, with or without a topic. The router picks a quick-choice group game, a one-thumb dodge game, or a generated web game; a named board game or a multiplayer ask becomes a web game. Takes ~10 seconds; the card handles joining and playing. Never recite questions or rules in chat.",
```

- [ ] **Step 3: Typecheck and run the tool tests**

```bash
npm run typecheck; echo "typecheck exit=$?"
node --test scripts/tools.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)'
```

Expected: exit 0, `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/server/tools/index.ts
git commit -m "fix(tools): make_game no longer promises trivia

The description predates the surface router and the sandbox tier.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: Two `say()` lines return to the house voice

**Files:**
- Modify: `src/server/agent.ts:1894`, `:3474`

- [ ] **Step 1: Find the drift**

```bash
grep -nE 'this\.say\(".*(\bI\b|—)' src/server/agent.ts
```

Expected: exactly two lines, 1894 and 3474.

- [ ] **Step 2: Rewrite both**

Line 1894, change the string inside `this.say(...)` from:

```
that game build fizzled — give me the prompt once more and I'll take another run at it
```

to:

```
that game didn't build. send the prompt again and i'll retry
```

Line 3474, change the string from:

```
that didn't work on my end, sorry. something broke while I was on the booking site.
```

to:

```
that didn't work on my end. something broke on the booking site, sorry
```

- [ ] **Step 3: Verify the voice rule holds across every `say()`**

```bash
grep -nE 'this\.say\(".*(\bI\b|—)' src/server/agent.ts; echo "matches above: expect none"
npm run typecheck; echo "typecheck exit=$?"
```

Expected: no matches, exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/server/agent.ts
git commit -m "fix(agent): two replies drop the capital I and the dash

Every other say() line is lowercase and says the consequence. These two had
drifted.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: A phone is one player, named once

Added 2026-09-22 after Task 2's review. Both of that review's Important findings share one root cause: since iOS 16, `UIDevice.current.name` returns the model string ("iPhone") unless the app holds the `com.apple.developer.device-information.user-assigned-device-name` entitlement, which this project does not have and cannot get before the demo. Every phone therefore joins a web-game lobby as `?player=iPhone`; the runtime's lobby dedupes by name, so two phones collapse into one player and multiplayer does not work on real devices. The runner card says "iPhone won", and its transcript poster renders the viewer's own avatar on every phone because the URL carries no sender identity.

This task runs immediately after Task 2, before Task 3, because the spec's goal is proven multiplayer and nothing in Tasks 3 to 10 depends on it.

**Files:**
- Modify: `ios/MessagesExtension/DesignSystem.swift` (append a `Player` enum at the end of the file)
- Modify: `ios/MessagesExtension/MessagesViewController.swift` (the `/game-web/` branch, the `/runner` branch, `sendRunnerChallenge`, plus one new helper method)
- Modify: `ios/MessagesExtension/InfiniteRunnerView.swift` (two new parameters on `InfiniteRunnerView`, one line in `compact`)
- Modify: `src/server/game-web-runtime.ts` (`idFor`, a new `myId`, `ensurePlayer`, `ready`, `WHIM.myId`)
- Modify: `src/server/agent.ts` (one line added to the generator prompt inside `buildWebGame`)
- Modify: `scripts/game-web-runtime.test.mjs` (one new test)

**Interfaces:**
- Produces: `Player.name: String`, `Player.id: String`, `Player.hasName: Bool` in Swift, from `DesignSystem.swift`. Query params on `/game-web/` URLs: `player` (display name) and `pid` (stable id). Query params on `/runner` card URLs: `who` (sender's display name) and `by` (sender's `Player.id`). In the runtime, `WHIM.myId()` returns the `pid` when the URL carries one.

- [ ] **Step 1: See the defect in the source**

```bash
grep -n 'UIDevice.current.name' ios/MessagesExtension/MessagesViewController.swift
grep -n 'p.name === me' src/server/game-web-runtime.ts
```

Expected: two matches in Swift (the `/game-web/` branch and `sendRunnerChallenge`); two matches in the runtime (`ensurePlayer` and `ready`).

- [ ] **Step 2: The identity helper**

Append to the end of `ios/MessagesExtension/DesignSystem.swift`:

```swift
/// Who this phone is, for lobbies and cards. iOS 16 returns "iPhone" for the
/// device name without a restricted entitlement, so the name is asked once
/// and stored; the id is the vendor identifier, stable per install.
enum Player {
    static let nameKey = "whim.player.name"

    static var hasName: Bool {
        guard let stored = UserDefaults.standard.string(forKey: nameKey) else { return false }
        return !stored.trimmingCharacters(in: .whitespaces).isEmpty
    }

    static var name: String {
        if hasName, let stored = UserDefaults.standard.string(forKey: nameKey) {
            return stored.trimmingCharacters(in: .whitespaces)
        }
        return UIDevice.current.name
    }

    static var id: String {
        let raw = UIDevice.current.identifierForVendor?.uuidString ?? "anon"
        return String(raw.lowercased().filter { $0.isLetter || $0.isNumber }.prefix(8))
    }
}
```

- [ ] **Step 3: Ask once, at the moment identity matters**

In `ios/MessagesExtension/MessagesViewController.swift`, add this method to the class (next to `expandFromTranscript` is fine):

```swift
    /// Runs `then` once a display name exists. Asks the first time, on the
    /// expanded sheet, because an alert cannot present over the compact drawer.
    private func withPlayerName(then: @escaping () -> Void) {
        if Player.hasName { then(); return }
        if presentationStyle != .expanded { requestPresentationStyle(.expanded) }
        let alert = UIAlertController(title: "What should the group call you?", message: nil, preferredStyle: .alert)
        alert.addTextField { $0.placeholder = "Your name"; $0.autocapitalizationType = .words }
        alert.addAction(UIAlertAction(title: "Save", style: .default) { _ in
            let typed = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespaces) ?? ""
            if !typed.isEmpty { UserDefaults.standard.set(typed, forKey: Player.nameKey) }
            then()
        })
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { _ in then() })
        present(alert, animated: true)
    }
```

- [ ] **Step 4: Web games carry the name and a stable id**

In the `/game-web/` branch of `present(url:)`, replace the block from `var playURL = target` through `showWeb(playURL)` with:

```swift
            withPlayerName { [weak self] in
                guard let self else { return }
                var playURL = target
                if var comps = URLComponents(url: target, resolvingAgainstBaseURL: false) {
                    var items = (comps.queryItems ?? []).filter { $0.name != "player" && $0.name != "pid" }
                    items.append(URLQueryItem(name: "player", value: Player.name))
                    items.append(URLQueryItem(name: "pid", value: Player.id))
                    comps.queryItems = items
                    playURL = comps.url ?? target
                }
                self.showWeb(playURL)
            }
```

- [ ] **Step 5: Runner cards carry the sender**

In `sendRunnerChallenge`, change `let who = UIDevice.current.name` to `let who = Player.name`, and add two items to the `items` array right after the `result` item:

```swift
            URLQueryItem(name: "who", value: who),
            URLQueryItem(name: "by", value: Player.id),
```

Then wrap the whole body of `sendRunnerChallenge` (from `guard let conversation` through `requestPresentationStyle(.compact)`) in `withPlayerName { [weak self] in guard let self else { return } ... }` so the name is asked before the first card is ever sent.

In the `/runner` branch of `present(url:)`, read the two new params and pass them through:

```swift
            let who = comps?.queryItems?.first(where: { $0.name == "who" })?.value
            let by = comps?.queryItems?.first(where: { $0.name == "by" })?.value
            host(AnyView(InfiniteRunnerView(presentation: presentation, challengeScore: target, result: result, postedScore: run, versusScore: vs, senderName: who, isMine: by == nil || by == Player.id, onChallenge: { [weak self] score, challenge in
                self?.sendRunnerChallenge(score, against: challenge)
            })))
```

- [ ] **Step 6: The poster shows the sender's face only on the sender's phone**

In `ios/MessagesExtension/InfiniteRunnerView.swift`, add two stored properties to `InfiniteRunnerView` next to `versusScore`:

```swift
    /// The sender's display name, from the card URL.
    var senderName: String? = nil
    /// Whether this phone sent the card; only then is the local avatar the right face.
    var isMine: Bool = true
```

In `compact`, change `face: avatar` on the `RunnerResultWidget` call to:

```swift
                    face: isMine ? avatar : nil,
```

`senderName` is carried for the next task that wants it; this task changes no widget text.

- [ ] **Step 7: The runtime keys the lobby on the id**

In `src/server/game-web-runtime.ts`, inside the runtime string, replace:

```js
  var me = (params.get("player") || "Player").slice(0, 32);
```

with:

```js
  var me = (params.get("player") || "Player").slice(0, 32);
  var pid = (params.get("pid") || "").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 16);
```

Replace the `idFor` function with:

```js
  function idFor(name) {
    if (pid) return pid;
    var s = String(name).replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
    return s.slice(0, 10) || ("p" + Math.random().toString(36).slice(2, 8));
  }
  var myId = idFor(me);
```

In `ensurePlayer`, change the lookup and the new-entry id:

```js
    var mine = players.find(function (p) { return p.id === myId; });
    if (!mine) {
      mine = { id: myId, name: me, joinedAt: Date.now() };
      players.push(mine);
    }
```

In `ready`, change `!state.players.some(function (p) { return p.name === me; })` to `!state.players.some(function (p) { return p.id === myId; })`.

Change `myId: function () { return idFor(me); },` to `myId: function () { return myId; },`.

- [ ] **Step 8: Tell the generator to compare ids, not names**

In `src/server/agent.ts`, inside `buildWebGame`'s system prompt, directly after the line `- WHIM.players() — everyone who opened the game in this chat`, add:

```
- WHIM.myId() — this player's stable id; compare ids for turn ownership and scores, never names (two players can share a name)
```

- [ ] **Step 9: Test the runtime change in the file's existing style**

Append to `scripts/game-web-runtime.test.mjs`:

```js
test("runtime keys the lobby on a stable id, using pid when the phone supplies one", () => {
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /params\.get\("pid"\)/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /var myId = idFor\(me\)/);
  assert.match(WHIM_MULTIPLAYER_RUNTIME, /p\.id === myId/);
  assert.doesNotMatch(WHIM_MULTIPLAYER_RUNTIME, /p\.name === me/);
});
```

- [ ] **Step 10: Verify everything**

```bash
grep -c 'UIDevice.current.name' ios/MessagesExtension/MessagesViewController.swift
grep -n 'p.name === me' src/server/game-web-runtime.ts; echo "matches above: expect none"
npm run typecheck; echo "typecheck exit=$?"
npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'
cd ios && xcodebuild -project Plan.xcodeproj -scheme PlanPreviews -destination 'generic/platform=iOS' -derivedDataPath build-preview CODE_SIGNING_ALLOWED=NO build 2>&1 | grep -E 'error:|BUILD'; cd ..
```

Expected: `0`, no matches, exit 0, `tests 183` / `fail 0`, `** BUILD SUCCEEDED **`.

- [ ] **Step 11: Commit**

```bash
git add ios/MessagesExtension/DesignSystem.swift ios/MessagesExtension/MessagesViewController.swift ios/MessagesExtension/InfiniteRunnerView.swift src/server/game-web-runtime.ts src/server/agent.ts scripts/game-web-runtime.test.mjs
git commit -m "fix(games): a phone is one player, named once

iOS 16 returns \"iPhone\" for the device name without a restricted
entitlement, so every phone joined a lobby as the same player and the
runtime, which keyed on name, merged them. The extension now asks for a
name the first time it matters and stores it; web-game URLs carry that
name plus a stable vendor id, and the lobby keys on the id. Runner cards
carry the sender too, so the poster shows the local avatar only on the
phone that sent it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Done when

```bash
git log --oneline main..feature/multiplayer-landing
```

shows ten commits. `git status --short` is empty. `npm test` reports `fail 0`. The PlanPreviews build succeeds. `curl localhost:5173/api/widget/demo/games` lists a `web` row.

## Needs a Cloudflare login first

`npm run dev` could not start on the machine this plan ran on. The `PEOPLE_INDEX` Vectorize binding in `wrangler.jsonc` is `remote: true`, which needs a cloud preview session, and `wrangler whoami` showed the Hack Western account (`2080c38e…`) rather than the account this Worker deploys to (`f8f3d57a…`). Tasks 3 and 4 were therefore committed on typecheck, `npm test` and the Swift build alone; their HTTP checks did not run. After `wrangler logout && wrangler login` into the right account:

1. `npm run runs:migrate` if the local D1 has never been created, then `npm run dev` in a second terminal.
2. Run Task 3, Step 5 top to bottom. Every command has its expected output beside it.
3. Run Task 4, Step 4: seed the web game, seed the trivia game, read the shelf.

## Still needs a phone

None of the above verifies inside real Messages. Before filming, cable each phone, run `./ios/install-phone.sh`, then on each phone:

1. Open any web-game card, dismiss the extension, and open it again. The first open runs straight through with the name "iPhone" so the sheet is never blank; the second open is from a live view, so the "What should the group call you?" alert appears. Save a name. This is a one-time step per phone.
2. Generate fresh game cards for the test. A card created before commit `3f91fff` holds lobby entries keyed by display name and will show a ghost player that never takes a turn.

Then with two devices in one chat: a web game card opens expanded, both saved names appear in the lobby, a move on one phone shows on the other within about two seconds, and the recent-games shelf lists it.
