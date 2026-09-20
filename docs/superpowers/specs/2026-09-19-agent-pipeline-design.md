# A two-stage agent pipeline: triage, then a specialist

Written 2026-09-19 on the `agent-pipeline` branch, off `main` at 50a72f1.

## The problem

Every model call in a turn today sends the same thing: the whole system prompt
(11.6 KB, about 100 rules covering venues, trips, shopping, money, profiles,
matchmaking, games and music) and all 45 tool schemas. A turn is two to four of
those calls. Two costs follow:

- **Latency and tokens.** A turn that answers "what should I bring" pays for
  the flight rules and the intro rules on every step. The 2026-09-19
  parallel-agent pass made the tool *calls* overlap; the model calls are still
  each as large as they can be.
- **Wrong tool.** With 45 tools in front of it, the model has sent hotel asks
  to `research` (minutes long, ends in "nothing found") often enough that the
  code now carries a regex backstop for it (`research-routing.ts`). The
  structural fix is for the trip specialist not to have `research` at all.

## The shape

```
webhook ─► ingestMessage ─► schedule ─► runTurn ─► think()
                                                      │
                                    ┌─────────────────┴──────────────────┐
                                    │ stage 1: route                      │
                                    │  wake reason decides ─or─ triage    │
                                    │  agent (small JSON call, no tools,  │
                                    │  runs alongside aboutPeople)        │
                                    └─────────────────┬──────────────────┘
                                                      │ lanes
                                    ┌─────────────────┴──────────────────┐
                                    │ stage 2: specialist                 │
                                    │  the existing tool loop, with       │
                                    │  systemFor(lanes), laneToolNames    │
                                    │  (all the same guards and runTool)  │
                                    └────────────────────────────────────┘
```

The specialist is not a new loop. It is `think()` as it stands, given a
narrower prompt and a narrower tool list. Every guard in it (one message per
piece of work, the send ceiling, duplicate-send swallowing, the question
window, concurrent lookups) is untouched, and so is `runTool`.

## Lanes

A lane is a named slice of the system prompt plus the tools that slice talks
about. Lanes live in `src/server/lanes.ts`, a pure module with no Durable
Object in it, so the split can be tested on its own.

| Lane | Tools | Prompt covers |
|---|---|---|
| `core` (always on) | `send_message`, `remember_area`, `remember_name`, `remember_fact`, `request_location`, `read_locations`, `propose_plan`, `get_votes` | voice, do-the-work-then-speak, multi-part asks, no announcing, the same-reply concurrency line, area and location, ballots and votes, what "About the people" is for, group sleep rules, NOOP |
| `venues` | `research`, `check_availability`, `book_option`, `show_venue`, `find_locations`, `get_weather`, `ask_rsvp`, `record_rsvp`, `get_rsvps`, `lock_headcount` | research (and that flights, stays, events are never research), booking through `book_option`, weather for outdoor plans, RSVPs |
| `trip` | `search_flights`, `search_stays`, `find_events`, `add_to_itinerary`, `watch_flight`, `confirm_item`, `find_locations`, `get_weather` | segments, one ballot at a time, prices quoted exactly, `add_to_itinerary` not `book_option`, confirm and watch |
| `shop` | `shop_search`, `shop_build_cart`, `shop_drop_cart`, `show_shopping_list`, `set_delivery`, `ask_rsvp`, `record_rsvp`, `get_rsvps`, `lock_headcount` | one cart per store, the known stores, headcount sizing, delivery, that paying is not the agent's job |
| `money` | `mark_paid`, `add_expense`, `drop_expense`, `show_invoice` | the invoice, expenses, payment setup words |
| `people` | `save_profile`, `send_profile_link`, `forget_person`, `join_match_pool`, `find_matches`, `request_intro`, `answer_intro`, `introduce_match` | profiles and onboarding, the match pool, intros without identifying anyone |
| `fun` | `make_game`, `add_song`, `show_playlist` | games and the playlist |

`ask_rsvp` and the headcount tools appear in two lanes on purpose: a cart is
sized to the headcount, and a venue booking needs one too. Every tool in
`toolSchemas` belongs to at least one lane, and a test enforces that, so a
tool added later without a lane fails the build rather than vanishing from the
model's view.

The union of every lane's prompt is today's prompt, reorganised. The `single`
mode (below) and the fallback path both use that union, so the worst case of
this change is the current behaviour.

## Stage 1: routing

Routing has four sources, tried in this order:

1. **The wake reason.** A `votes_in` turn's job is fixed: `core`, plus `trip`
   when the winner is a flight, stay or event (that is exactly when the
   prompt tells it to call `add_to_itinerary`), plus `venues` otherwise (the
   winner may need `book_option`). An `availability_in` turn only speaks:
   `core`. No model call.
2. **Sticky lanes.** A short message (eight words or fewer, no link) that
   arrives inside the window of a question the agent asked is the answer to
   it, and reuses the lanes of the turn that asked. "Friday" or "Sam,
   sam@example.com" costs no triage call. A long message in that window is a
   new ask and is triaged.
3. **The triage agent.** Otherwise a small structured call through `askJson`:
   no tools, about a tenth of the specialist's prompt. It sees the last eight
   transcript lines, one line of plan status, whether there are carts, an
   itinerary and research findings, whether this is a direct chat, and the
   lane catalogue with a one-line description each. It returns
   `{ lanes: string[], why: string }`. Unknown lane names are dropped; an
   empty or invalid answer means "every lane".
4. **Fallback.** If triage throws or takes longer than its budget (8 s), the
   turn runs with every lane, and the route event says so.

Triage runs concurrently with `aboutPeople` (the People Durable Object RPC)
and the rest of context assembly, so its cost is only what exceeds that work.

Two harness rules sit on top of whatever triage says, because the harness
already knows better:

- A direct chat with onboarding still pending, or with an intro waiting to be
  answered, always has `people` on.
- In a group chat, triage may answer with no lanes at all: it means nobody
  asked the agent anything. That ends the turn silently without the large
  model call, which is what the NOOP path costs today. In a direct chat every
  message is addressed to the agent, so an empty answer is treated as `core`.

The route is recorded as a `turn.route` event with the lanes, the source
(`reason`, `sticky`, `triage`, `fallback`, `single`), the triage tokens and its duration, so
`/runs` shows what the turn was scoped to and how much the routing cost.
`turn.start` also carries the lanes.

## Stage 2: the specialist

`think()` takes the lanes and asks `lanes.ts` for two things:

- `systemFor(lanes)`: the common block plus the selected lanes' blocks, in a
  fixed order, so the prompt for a given lane set is byte-identical across
  turns (and therefore cacheable by the provider).
- `openAiTools(laneToolNames(lanes))`: `openAiTools` now takes an optional tool list and
  memoises the JSON schema array per lane-set key, keeping the once-per-isolate
  build from the parallel-agent pass.

`runTool` is unchanged and still knows every tool. If the model somehow names
a tool outside its lanes (it cannot; the provider rejects unknown tool names
against the list it was sent), the existing "Unknown tool" path answers.

## Switching it off

`AGENT_PIPELINE` in `wrangler.jsonc` vars: `lanes` (default) or `single`.
`single` skips routing and runs today's full prompt and tool list. It exists
so a demo-day regression has a one-line rollback that needs no code change.

## What is not in this change

- **Parallel specialists.** Running the trip and shop lanes as two concurrent
  loops that a third call merges was considered and dropped: two loops racing
  to `propose_plan` is the "second ballot replaces the first" bug seen on
  2026-09-19, and thread order depends on sends completing in sequence.
  Lookups that can overlap already do (`tool-concurrency.ts`), and a
  multi-lane ask runs one loop with the union of those lanes, which is where
  those overlapping lookups happen today.
- **Changing any rule's wording.** Rules move between blocks; none is
  rewritten. Prompt tuning is a separate job.
- **The 2 s batching delay, one research run at a time, research internals.**
  Unchanged, for the reasons in the parallel-agent analysis.

## Testing

- `scripts/lanes.test.mjs`: every tool has a lane; `core` is always included;
  `systemFor(all)` contains a marker sentence from every block and
  `systemFor(["core"])` contains none of the lane-only markers; the same lane
  set in any order yields the same prompt string; `toolsFor` returns the same
  array identity for the same lanes.
- `scripts/triage.test.mjs`: the pure parts of routing. Reason-based routes
  for `votes_in` with and without a trip winner and for `availability_in`;
  the harness overrides (onboarding, pending intro, empty answer in a group vs
  a direct chat); unknown lane names dropped; a malformed answer falls back to
  every lane.
- `npm run typecheck`, `npm test`, `npm run smoke` on the worktree's own dev
  server.
- Live, on the dev proxy (haiku), the same asks under `AGENT_PIPELINE=single`
  and `lanes`, read from `turn.route`, `turn.step` and `turn.end` in
  `/api/dev/logs`: a direct hotel ask, a group shopping ask, a group message
  that is not for the agent. What is compared: wall time to `turn.end`,
  tokens, and which tools were called.
- Deployed to the staging Worker and the same probes run there before the PR
  is called ready.

## Measured

Five asks, one fresh simulator chat each, on the production model
(gpt-5.6-luna, `LLM_PROFILE=demo`) from the worktree's dev server, once in
each mode. Numbers are the `turn.end` event's `ms` and `tokens` (lanes mode
includes triage in both). One run each, so treat the latency column as
indicative; the token column is deterministic in shape.

| Ask | single: ms / tokens | lanes: ms / tokens | lanes chosen | What differed |
|---|---|---|---|---|
| direct chat, first message "thanks, that was perfect!" | 1816 / 8280, **silent** | 8785 / 14190, replied | people (harness: onboarding) | single mode said nothing to a first direct message, which the prompt forbids; lanes mode saved the profile and introduced itself over four steps |
| group, "@whim lol you're the best, thanks" | 3079 / 8324, silent | 1411 / 612, silent | none | same outcome, one small call instead of the full one |
| group, picnic weather at Trinity Bellwoods | 6140 / 16818 | 6548 / 7657 | venues | same tools (find_locations then a reply); triage's 1.1 s offset by cheaper steps |
| group, balloons and a banner from partycity.com for 6 | 1682 / 8358 | 1923 / 4684 | shop | both asked one clarifying question |
| group, YYZ to YVR Oct 10 to 13 plus a hotel | 6618 / 16827 | 2839 / 7440 | trip | both asked which year and airport; lanes mode did it in half the time |

Per specialist step the full prompt is about 8.3k input tokens on this model;
a single-lane step is 3.3k to 4k. Triage itself took 1.1 to 2.1 s and about
600 tokens on every ask, and chose the right lane every time.

On the free dev proxy (`npm run llm`, haiku through `claude -p`) every model
call carries a fixed 4 to 5 s process start, so there triage is pure added
latency and the 8 s budget is needed; the token savings are the same. That
proxy also counts the full prompt at about 15k tokens.

Also run: `npm test` (155), `npm run typecheck`, `npm run smoke` on the
worktree's server in lanes mode, all green.
