# Test plan

Written Saturday 19 Sept, ~05:00. Demo is Sunday morning.

The code is further along than the testing. Almost everything below "Tier 0" has
only ever run in the simulator, on a Claude model, in a one-to-one chat — and the
demo is a **group chat**, on **`gpt-5-mini`**, on **real phones**. Each of those
three differences has already produced a bug the simulator could not show (the
eight-message loop only happened on `gpt-5-mini`). The tiers are ordered so the
cheapest tests that can change the design run first.

## Where things stand

| Area | Built | Proven on |
|---|---|---|
| Wake gate (@mention / reply / answer window) | yes | simulator only — never a real iMessage group |
| Plan card, tapback voting, ticket photos | yes | real phone, one-to-one; fallback rendering only (no Agent Apps) |
| Research (Browserbase) | yes | real phone, one-to-one |
| Availability check (browser pilot, read-only) | yes | simulator → real venue site |
| Booking (browser pilot) | yes | simulator → real venue site, dry run to the payment page |
| Shopify multi-store carts + shopping list | yes | simulator → real stores; cart card never sent through real Linq |
| Profiles, DM onboarding, `/p/<token>` form | yes (parallel session) | simulator; see that session's notes |
| Presence: read receipts, typing, contact card | yes (parallel session) | unknown on a real phone |
| RSVP / headcount tickets | yes (parallel session) | simulator |
| Invoice: who owes whom (ticket, live page section, `add_expense`) | yes | `npm test` for the math; simulator for the auto-post and tools; page eyeballed in headless Chrome |
| Matchmaking (`join_match_pool`, `find_matches`, `introduce_match`) | tools + card exist | **never run** — Vectorize has no local mode |
| Run viewer `/runs` | yes | local + production API; page not checked in a browser since the fix |
| Production on `gpt-5-mini` | deployed, current | **one turn ever** (the loop bug); nothing since |

## Tier 0 — smoke test (2 min, no phone, run constantly)

```sh
npm run smoke            # 14 deterministic checks, no LLM, no network
npm run smoke -- --net   # + real Shopify (tunnel must be up)
npm run smoke -- --llm   # + two model-driven turns on the dev LLM
```

Run after every pull and before every deploy. Several sessions edit this tree at
once; this is what catches one breaking another. **A failing smoke test blocks a
deploy.** If a bug is found by hand later, add a check for it here.

## Tier 1 — the two unknowns that can change the design (30 min, needs 2 iPhones)

Linq stays pointed at the laptop (`node scripts/linq-webhook.mjs use trycloudflare`),
so this costs nothing. Watch `curl 'localhost:5173/api/dev/logs?chat=<id>'`.

**1a. Real group chat.** Create an iMessage group: the agent's number + two people.

| Do | Pass |
|---|---|
| Each person texts the number once first (inbound-first rule) | agent can post in the group afterwards |
| Chat among yourselves, no mention, ~6 messages | agent silent; log shows `message.stored`, no `turn.start` |
| `@`-mention the agent (pick it from the mention list) with a request | log shows `message.in` with `"wake":"mention"`; reply uses what was said earlier |
| Long-press one of its messages → Reply | `"wake":"reply"` |
| Answer a question it asked, without mentioning it | `"wake":"answer"` |
| Both people tapback the plan card | two `vote.cast`, card count reads `2/2`, then **one** line naming the winner |

If `"wake":"mention"` never appears, Linq is not flagging mentions the way its
SDK types say, and the trigger needs redesigning — find out now, not Sunday.

**1b. The card with Agent Apps installed.** On one phone tap "Open in Agent Apps"
and install it. Send a fresh plan card. Screenshot what it looks like with and
without the app. Decide: is the card good enough, or do the ticket photos carry
the design and the card is just the vote target?

## Tier 2 — full flows on a real phone (1–2 h)

Still on the laptop agent. One flow at a time; note every awkward message, not
just failures — tone problems are demo problems.

1. **Plan → research → vote → availability.** "@plan dinner friday, ramen,
   4 of us" → it asks where you are once → research returns real places →
   card + ticket → vote → ask "does it have space at 7?" → `check_availability`
   returns real times. *Pass:* no invented venue, no repeated question, area
   remembered on the next request.
2. **Booking, dry run.** Give a name and email when asked → "book it".
   *Pass:* "watch the browser" link opens a live view; ends in **handoff** with a
   line stating date, time, party size and price, the venue link, and a
   screenshot. **Use a far-out date, and run this at most two or three times:**
   every run holds a real slot at a real business for a while.
3. **Shopping.** "get a card game and some soda for 6" → two stores, two cart
   cards, quantities sized to the headcount → "what's the total" → shopping-list
   ticket → tap a checkout link on the phone and confirm it opens the store's
   real checkout with the right items. Do **not** pay.
4. **RSVP.** `ask_rsvp` ticket → thumbs up/down from two phones → headcount
   locks → ticket closes itself.
5. **Onboarding + profile** (parallel session's feature). Fresh number DMs the
   agent → one question at a time → `/p/<token>` link arrives → facts show up in
   a later group plan ("vegetarian" reaches the research brief). Also: "forget
   me" deletes it.
6. **Failure paths, on purpose.** Ask for a venue with no online booking; kill
   the tunnel mid-research and bring it back; ask it something out of scope.
   *Pass:* it says what happened in plain words and never goes silent after
   promising something (research watchdog: 3 min; workflow crash handler).

## Tier 3 — production rehearsal on the demo model (45 min, costs cents)

```sh
npm run smoke && npm run deploy
node scripts/linq-webhook.mjs use workers.dev
npx wrangler tail            # and /runs?token=<RUNS_TOKEN> on the workers.dev URL
```

Re-run Tier 1a and flows 1–3 of Tier 2 against production. Specifically watch for
what `gpt-5-mini` does differently from Claude:

- more than one message per turn (guarded in code — confirm `extraSendBlocked`
  is rare, not constant)
- ignoring "ask where they are first" or "never invent a venue"
- weak tool choice: skipping `remember_area`, `remember_name`, `check_availability`
- leaked reasoning in plain content (dropped in code — check `turn.content_dropped`)
- read `tokens` on each `turn.end` and work out the real cost of one demo run

**Decide the demo model here.** If `gpt-5-mini` is visibly worse, try
`gpt-5.6-luna` (cheaper and 4× faster, but needs `reasoning_effort: "none"` for
tool calls, which the code does not send yet) or a larger GPT model. Opus on the
dev profile showed how good the agent can be; pick the OpenAI model closest to it
that the credits allow. Switch back with `use trycloudflare` when done.

## Tier 4 — demo rehearsal (Sunday early, 2 h)

1. Write the demo script: exact messages, who sends them, from which phone.
   Keep it inside what passed in Tier 3. Pick the venue and the stores in
   advance; confirm the venue's booking site is not IP-blocked from Browserbase.
2. Run it start to finish **twice on production**, from a clean chat each time
   (a new group = a new agent with empty memory).
3. Record the second run as a **backup video**.
4. Pre-demo checklist: laptop not required (production only) · Linq on
   `workers.dev` · `BOOKING_DRY_RUN` still `"true"` unless you truly mean to pay
   · OpenAI spend limit set · Agent Apps installed on every demo phone ·
   everyone in the demo group has texted the number once · `/runs` open on a
   second screen for the judges.

## Decide today, not Sunday

- **Matchmaking: build or cut.** Tools and the intro card exist; the flow has
  never run and cannot be tested locally. If it stays, it needs its own Tier 2
  flow on production today.
- **Browserbase credits.** Residential proxies need a paid plan; two of three
  venues tried block datacenter IPs. Ask the sponsor. Without them, choose the
  demo venue from sites that are known to load.
- **Linq location sharing.** Returns 403 on this account tier. Ask in their
  Discord if you want "somewhere central to all of us".
- **R2.** Still disabled on the Cloudflare account; enabling it adds a product
  to the prize-track write-up.

## Rules while several sessions share this repo

- `npm run smoke` before you commit anything that touches `agent.ts`.
- Never save a config file (`wrangler.jsonc`, `.env`) in a half-finished state:
  the dev server restarts into it, fails, and stays dead until restarted by hand.
- One session deploys. Say so before you do.
- Do not rewrite history, stash, or reset while others have uncommitted work in
  the tree — it happened once and cost an hour.
