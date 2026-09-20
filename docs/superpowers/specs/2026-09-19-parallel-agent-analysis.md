# Parallelising the agent: where the time goes, and what was changed

Written 2026-09-19 on the `parallel-agent` branch (worktree off `main` at d64d9bb; rebased onto #40, #42, #43 to #46 and then #47 to #50 the same evening).

The question: which parts of the agentic flow are serial today but need not be,
and which of those are worth changing before the demo. Every item below was
read in the code, not assumed; the "verified" column says how the change was
checked.

## The critical path of one turn

```
Linq webhook ─► ingestMessage ─► schedule(2s) ─► runTurn ─► think()
                    │                                         │
                    └─ waitUntil(acknowledge)                 ├─ aboutPeople (People DO RPC)
                       markRead → typing → contactCard        ├─ step 1: [typing] → LLM → tools (in order)
                       (was serial; now parallel)             ├─ step 2: [typing] → LLM → tools
                                                              └─ … until no tool calls
                                                                  finally: offerProfileCard → stopTyping
```

Latency the user feels = 2 s batching delay + N model calls + tool time on the
path to the first `send_message`. Everything after the first send is invisible
to them (the typing bubble is already down), except that it holds the turn
lock, which delays a follow-up message's turn.

## What was serial, and what was done about it

| # | Where | Before | After | Why it is safe | Verified by |
|---|---|---|---|---|---|
| 1 | `agent.ts` tool loop → `tool-concurrency.ts` | Only `shop_search` and `find_matches` ran concurrently when a step had several of them | Every pure network lookup runs concurrently: `search_flights`, `search_stays`, `find_events`, `find_locations`, `get_weather` join the set. The rule is its own module | These read nothing from agent state that another tool in the same step could change; they only fetch and return. Speaking, posting cards, reading the tally and editing the plan stay in order | `scripts/tool-concurrency.test.mjs` (5 tests: both lookups start before either is awaited, ordered tools never start early, a lone lookup is left alone, a failing lookup is neither lost nor unhandled). A live turn on the dev proxy (haiku) ran flights then hotels in separate steps, so the overlap itself was not seen live: the dev model issues one call per step. The loop mechanism is unchanged from `main`, where it already served two-store searches on the production model |
| 2 | `agent.ts` `typing()` before each model call | Awaited a Linq HTTP call before every model call after the first minute | Fired without waiting; the model call starts at once | `startTyping` never throws (it goes through `quietly`) and its result was only logged | smoke; `--llm` turn |
| 3 | `agent.ts` `acknowledge()` | read receipt → typing bubble → contact card, one after the other | All three at once | Independent best-effort Linq calls; `typingAt` is set synchronously before the call as before | smoke (`presence` event still logs all three) |
| 4 | `agent.ts` `runTurn` finally | profile card offer, then stop typing | Both at once | Unrelated messages; order in the thread does not matter (one is a card, the other clears a bubble) | smoke |
| 5 | `agent.ts` `startPay` | profile read → wallet check | Both at once | Independent reads, both needed before the first branch | smoke pay guards |
| 6 | `agent.ts` `find_matches` | profile → pairedWith → (semantic ∥ lexical) | (profile ∥ pairedWith) → (semantic ∥ lexical) | `pairedWith` needs only the handle | typecheck; not live (Vectorize is remote) |
| 7 | `agent.ts` `bookingFinished` | booked text → rename/icon/background → screenshot | booked text ∥ dressing → screenshot | Dressing posts no message, so it cannot reorder the thread; the screenshot still follows the text | smoke "chat becomes the plan" |
| 8 | `agent.ts` `checkWatches` | For each watch: fetch status, then post lines | Fetch every status at once, then post lines in itinerary order | Posting stays ordered; only the network reads overlap. Failures are still counted per item | live: an order watch and a flight watch seeded in one chat, `/api/dev/watch` fired; `watch.check active:2`, both handled, 4.3 s wall for both (one proxied fetch alone is ~4 s) |
| 9 | `tools/index.ts` `openAiTools()` | Regenerated 45 JSON schemas from zod on every model call | Built once per isolate | Schemas are static | unit test: same array identity |
| 10 | `tools/shopify.ts` `endpointFor` | Fetched the store's `/.well-known/ucp` manifest before every UCP call (search, cart, cancel) | Manifest cached per store per isolate for 10 min, with in-flight de-duplication; a refusal is never cached and a call that cannot reach the endpoint drops the entry | The manifest changes on the scale of deploys; the cache is per isolate and short-lived | `scripts/shopify.test.mjs` (4 tests, mocked fetch counting manifest reads); `smoke --net` through a quick tunnel against explodingkittens.com, drinkolipop.com and urbanstems.com: two carts, real names, all green |
| 11 | `research.ts` plan | specialist routing (LLM) → query planning (LLM), serial | Both steps under `Promise.all`; when a specialist is picked, the last planned query is replaced by a `site:` query for it | Cloudflare Workflows cache steps by name and their own docs run several `step.do` under `Promise.all`. The model used to write the site query; now it is deterministic. Same query count, same cost | `scripts/research-jev-flow.test.mjs`: a routing mock that only answers once planning has started (serial code falls back after 2 s and the test catches the fallback event), and a deep run with a specialist whose fourth search is the `site:luma.com` query and whose search count is still 4. Not run live: no `AI_GATEWAY_API_KEY` on this machine |
| 12 | `research.ts` read | 4 pages at a time, even through the Browserbase Fetch API which has no tabs | 4 when a browser session is open (tabs time each other out), otherwise 8 | Probed live: 8 concurrent Fetch calls returned in 2.9 s with no 429 and no per-call slowdown | `scratchpad/bb-probe.mjs` run 2026-09-19 |
| 13 | `index.ts` `/card?t=` | Fetched the plan state from the agent DO, then the ticket | Ticket only; the plan state was never used on that path | Read the code path | smoke ticket render |

## Looked at and deliberately left alone

- **The 2 s batching delay** before a turn (`schedule(2, "runTurn")`). It is
  the single largest fixed cost on the path, but it is what turns a burst of
  three texts into one reply instead of three. Halving it is a product call,
  not an engineering one. Exposed nothing; flagged here.
- **One research run at a time.** A multi-part ask ("dinner, then a spa") is
  one brief. Running two research workflows concurrently means per-run
  progress keys, a watchdog per run, and a context that merges reports. Worth
  doing after the demo; too much surface to change the night before.
- **Overlapping `say()` with the next model call.** Would save ~0.5 s per
  message but the model is told whether the send succeeded, and thread order
  depends on sends completing in sequence. Not worth the failure modes.
- **Reading profile links in parallel** (`social.ts`). Two Instagram tabs on
  the bot's one signed-in context is how that account gets challenged.
- **The browser pilot's step loop.** observe → decide → act is inherently
  serial; each step needs the page the last one produced.
- **Card PNG caching.** Every `/card` request renders because R2 is off. That
  is a caching problem with a planned fix (enable R2), not a parallelism one.
- **The final model call after the last `send_message`.** It usually returns
  NOOP, but it is what lets "text, then work, then text" happen, which the
  loop explicitly protects.

## What was run

- `npm test`: 122 tests (110 on `main` + 12 new), all passing.
- `npm run typecheck`, `npm run build`: clean.
- `SMOKE_BASE=http://127.0.0.1:5176 npm run smoke -- --net` from the worktree's
  own dev server behind a quick tunnel: every check green, including the live
  Browserbase ones (`search_flights`, `watch_flight` bad-ident revert), the
  real Shopify stores and a research workflow launch.
- One model-driven direct-chat turn on the dev proxy: presence logged all three
  results, the turn replied normally with two lookups and one text.
- `/api/dev/watch` with two seeded watches: both checked in one wave.
- Browserbase Fetch probe at 4 and 8 concurrent calls: no throttling.

## The phone said "checking… when the results return", then "came up empty again"

Reported mid-branch, from production, for a Toronto hotel on Sept 20 and a
Toronto → Vancouver flight that night. Investigated before touching anything:

- The two sources answer for exactly those queries from here: 10 Toronto
  hotels for the 20th (adults 1), a WestJet fare for that evening. So the
  data exists and the parsers work against today's Google pages.
- The production model (gpt-5.6-luna, probed directly with the agent's real
  system prompt and tool list, original and new) routes both asks straight to
  `search_stays` / `search_flights`. It does not send them to research.
- Therefore the tools ran in production and either failed or came back empty
  there. Their failure text was "did not answer this time. Say so in one line
  and offer to try again", which the model rendered as "came up empty again…
  I'll retry", and a genuinely empty parse says "showed nothing for those
  dates", which reads the same. Neither told the person the real cause.
- Production runs on a teammate's Cloudflare account, so its logs are not
  readable from this machine. The distinguishing event is in the run viewer
  (`/runs`, with `RUNS_TOKEN`) or `npx wrangler tail`: `source.failed` with
  the error (a 401/402 means the Browserbase key or plan on that account is
  not the one probed here), or `source.empty` with the page `title` (a
  consent or interstitial page means Google is serving that proxy something
  else).

What changed so the next occurrence is honest and diagnosable:

| Where | Before | After |
|---|---|---|
| `agent.ts` `sourceFailure` | "did not answer this time… offer to try again" | Carries the cause (status code and host) and tells the model it is a system problem: say the lookup isn't working, do not say nothing matched, do not ask for different dates |
| `research.ts` (PR #40, merged meanwhile) | A missing Jev key failed every run in 0 ms with "say the search came up empty" | Research runs without the key: the LLM picks sources and options go unscored. This branch's own "unavailable" signal for that case was dropped on rebase, since nothing triggers it any more |
| `agent.ts` research tool + `research-routing.ts` | A hotel or flight brief would start a minutes-long run that ends in "nothing found" | Refused with the tool to call instead; venue briefs that merely mention a hotel or a flight still go to research (13 cases in `research-routing.test.mjs`) |
| system prompt + `research` description | "To find real places, call research" | Flights, stays and events are named as never research |

## On the production model, through the real loop

After the branch was rebased onto #40 (research runs without the Jev key)
and #42 (widgets, games), the worktree's server was pointed at the demo
profile (gpt-5.6-luna) and driven through `/api/dev/*`:

| Ask | What happened |
|---|---|
| "hotel in Toronto next Sunday Sept 20, one night" (fresh direct chat) | `search_stays` returned 3 hotels for the 20th; a ballot was posted |
| "flights Toronto → Vancouver tonight, one person" (fresh direct chat) | The model chose to run first-contact onboarding instead ("what should I call you?") and never searched. Pre-existing behaviour of a brand-new direct chat; the phone that reported the problem is long past onboarding |
| quick research, "late night ramen for 4 on Friday", downtown Toronto | 22 s end to end through #40's LLM fallback: 2 queries planned alongside routing in 2.2 s, 15 hits, 3 pages fetched in one wave, 2 read, a ballot of two ramen places posted |
| "flights YYZ→YVR and a hotel in downtown Vancouver, cheapest of each" | Without the batching line: the two lookups came one step apart. With it: one step, both in flight together, direct and group chat. Group waited 15.2 s for both instead of 29.3 s; direct 19.2 s instead of 34.9 s. In a third try the model still split them, so the line raises the odds, it does not guarantee |

The batching line was chosen by probing the model directly with the agent's
prompt and tools, three tries each: without it, both calls in one reply 1
time in 3; with it, 3 in 3.

Seen along the way, not changed here: asked for flights and a hotel at
once, the model calls `propose_plan` twice a few seconds apart, and the
second ballot replaces the first, so the flight ballot is gone before anyone
can vote. The prompt says one ballot at a time; the model reads that as one
after another. Worth a rule in code (refuse a second ballot while one is
open with no votes) before a trip demo.

## Did main's later commits fix the phone?

Main then gained #43 (a failed research run no longer poisons the next, and
cannot be retried until someone texts) and #46 (production's Jev key is set
but the gateway answers 401; scoring errors now fall back to LLM selection
instead of failing the run). That is the loop the phone was in: research
died at scoring in 0 ms, the model re-announced and retried, and every
failure read as "came up empty".

Main at #46 was checked out on its own, pointed at the demo profile
(gpt-5.6-luna) and driven through `/api/dev/*` with this machine's keys:
hotels for Sept 20 (3 results, ballot posted), flights tomorrow (3), flights
plus a hotel in one ask (Flair CA$164 and a $137 hotel, both lookups in one
step that time), and a quick research run in 11.6 s. So with a Browserbase
key that behaves like this one, main fixes it. What cannot be verified from
this account is production's own Browserbase key; `source.failed` in its run
log would say if that is the remaining problem.

This branch was rebased onto that main (one conflict, in the research tool
handler: main's retry block and this branch's travel redirect now sit one
after the other).

## How to see the difference

`/runs` shows each tool as a span with a start and duration. On a turn that
calls two lookups, the spans now overlap; before they were end to end.
