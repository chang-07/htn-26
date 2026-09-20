# Whim — an iMessage group-chat planning agent

An agent that lives in an iMessage group chat. It brainstorms a hangout with the
group, posts a card to vote on, books the winner, and builds Shopify carts for
anything the group needs. It runs entirely on Cloudflare Workers.

Browserbase site skills are managed by a selective planning subagent; named-place and weather tools support outdoor plans. See [routing, supported skills, and setup](docs/browserbase-planning.md).

## Architecture

```
iMessage group chat
   │  Linq webhook (HMAC-signed)
   ▼
Worker  src/server/index.ts ── verifies, routes by chat id, returns 200 at once
   │  RPC
   ▼
PlanAgent  (Durable Object, one per chat)          src/server/agent.ts
   ├─ private SQLite: transcript, handles, votes
   ├─ public state ──WebSocket──► vote page (useAgent)   src/client/
   ├─ schedule(): batches bursts of texts into one turn; nudges non-voters
   ├─ LLM tool loop (OpenAI, or a free dev provider)     src/server/llm.ts
   │     ├─ propose_plan · get_votes
   │     ├─ research ──► ResearchWorkflow (durable, minutes-long)
   │     │                 └─ Browserbase: search, read pages   src/server/browser.ts
   │     ├─ shop_search · shop_build_cart   → Shopify UCP (JSON-RPC, no key)
   │     ├─ join_match_pool · find_matches  → Workers AI embeddings + Vectorize
   │     └─ book_option ──► BookingWorkflow (durable, retried)
   │                          └─ browser pilot on Browserbase (src/server/pilot.ts)
   └─ card PNG: workers-og, cached in R2 per plan version  src/server/card.ts
```

| Cloudflare product | What it does here |
|---|---|
| Workers | Webhook ingress, routing, card rendering, serving the vote page |
| Durable Objects (Agents SDK) | One stateful agent per chat: memory, state, scheduling |
| Workflows | The booking run: multi-step, survives restarts, never books twice |
| Browser Rendering | Fallback browser when no Browserbase key is set |
| Vectorize + Workers AI | Interest embeddings and nearest-neighbour matchmaking |
| R2 | Rendered card images |

## Running it

### First time

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in a model — see below
npm run runs:migrate             # local database behind the run viewer
```

### Every time

Two terminals. The second is only needed if you are using your Claude plan as
the model.

```sh
npm run dev      # terminal 1 — the Worker and the pages, on http://localhost:5173
npm run llm      # terminal 2 — only for the "Claude plan" row below
```

### Where the model comes from

`LLM_PROFILE` is `dev` in `wrangler.jsonc`, so local runs use whatever
`DEV_LLM_*` points at. Pick one and put it in `.dev.vars`:

| You want | Set | Costs |
|---|---|---|
| Your Claude plan | `DEV_LLM_BASE_URL=http://127.0.0.1:11435/v1`, `DEV_LLM_MODEL=haiku`, and run `npm run llm` | nothing (uses your subscription) |
| Ollama | `DEV_LLM_BASE_URL=http://localhost:11434/v1`, `DEV_LLM_MODEL=<model>` | nothing |
| Workers AI | `DEV_LLM_BASE_URL=https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1` plus a token | pennies |
| OpenAI — what deploys use | leave `DEV_LLM_*` blank, set `OPENAI_API_KEY` | credits |

> **Leaving `DEV_LLM_*` blank does not mean "no model".** It falls back to
> OpenAI and spends credits. `llm.ts` logs `llm profile.fallback` when this
> happens — worth grepping for if a local test costs money unexpectedly.

### Drive it without a phone

With no `LINQ_API_KEY` set the Linq transport is **dry**: sends are logged, not
delivered. These routes are localhost-only and 404 on the deployed Worker.

```sh
# send a message to the agent, as if someone texted it
curl -X POST localhost:5173/api/dev/message -H 'content-type: application/json' \
  -d '{"chat":"demo","from":"+15550001111","text":"dinner friday? ramen downtown"}'

# tapback on the plan card ("on":"photo" for the ticket photo above it — both count)
curl -X POST localhost:5173/api/dev/react -H 'content-type: application/json' \
  -d '{"chat":"demo","from":"+15550001111","reaction":"like"}'

# run any agent tool directly — no model call, no tokens
curl -X POST localhost:5173/api/dev/tool -H 'content-type: application/json' \
  -d '{"chat":"demo","tool":"propose_plan","args":{"title":"Friday dinner","options":[{"title":"A"},{"title":"B"}]}}'

curl 'localhost:5173/api/dev/source?kind=flights&from=YYZ&to=YVR&depart=2026-10-10'   # one browse.sh recipe, no model

# start a research run without going through the model
curl -X POST localhost:5173/api/dev/research -H 'content-type: application/json' \
  -d '{"chat":"demo","brief":"late night ramen","near":"Toronto","depth":"quick"}'

curl 'localhost:5173/api/dev/dump?chat=demo'      # state, transcript, votes
curl 'localhost:5173/api/dev/logs?chat=demo'      # that chat's event history, as text
```

### Where to look

| Open | What it is |
|---|---|
| `localhost:5173/runs` | **the run viewer** — every turn as a graph of cards. Start here when something looks wrong |
| `localhost:5173/w/demo` | the vote page for chat `demo`, live over WebSocket |
| `localhost:5173/card/demo` | the plan card as a PNG, exactly as the chat sees it |
| `localhost:5173/live/demo` | the browser, live, while a booking or research run is going |

The run viewer needs no token on localhost. On the deployed Worker it does —
see `RUNS_TOKEN` in the secrets table.

### Real iMessage from your laptop

Keep hot reload and the free dev LLM, but receive real texts: expose the dev
server with a quick tunnel and point a Linq webhook subscription at it.

```sh
cloudflared tunnel --url http://127.0.0.1:5173    # prints https://<words>.trycloudflare.com
```

Put that URL in `.env` as `PUBLIC_BASE_URL`, create a Linq webhook subscription
for `message.received` + `reaction.added` targeting
`<url>/api/webhooks/linq`, and store the `signing_secret` from the create
response as `LINQ_WEBHOOK_SECRET` — Linq shows it once and it cannot be fetched
again. Restart `npm run dev` so the new values load.

The URL changes whenever the tunnel restarts, which means a new subscription and
secret each time. If the tunnel answers 404 for everything, an existing
`~/.cloudflared/config.yml` is hijacking it: move it aside. Chat ids that are not
UUIDs always stay on the dry transport, so the simulator never texts anyone even
with a live key.

### When the agent wakes

In a group the agent sleeps while people talk. Every message is stored in its
memory, but the model runs only when a message is addressed to it, so chatter
costs no tokens and draws no interjections — and when it is called on, it has
already read the whole conversation.

| Wakes the model | How it is detected |
|---|---|
| An @mention of the agent | Linq marks each mention with `is_me` — no name or wake word |
| An inline reply to one of its messages | `reply_to.message_id` matches a text or card the agent sent |
| An answer to a question it just asked | any message within 3 minutes of its question, until it next speaks (max 3 wakes) |
| Anything in a one-to-one chat | there is nobody else it could be for |

Votes, research results and booking results wake it too, as before. In the logs
a sleeping message is `message.stored`; a waking one is `message.in` with a
`wake` reason. Test the gate in the simulator with `"group": true` plus
`"mention": true` or `"replyTo": "last"` on `/api/dev/message`.

### Location — cities and distances, never coordinates

In a one-to-one chat where the agent doesn't know where someone is, it offers a
choice: type it, or share location. Only after they say yes does it call
`request_location`, which makes their phone show Apple's share prompt.

When they accept, the agent reads the share **once**, keeps `locality` plus the
region ("Toronto, ON, Canada") as their area, and immediately ends the share
from its side so it has no way to look again. Coordinates and street addresses
are never stored or logged — `readLocation` in `linq.ts` drops them before
anything else sees them.

- **A share they start themselves is read too, and left running.** Sharing from
  the conversation is consent to be read — but the share is theirs, so the agent
  keeps the city and does not end it. (The first version ignored these, which
  left someone who had said "here's my location" with an agent acting as if
  they hadn't.) Only a share the agent *asked for* is ended after one read.
- **"How far apart are we" works in a group.** Reading works anywhere; only
  *asking* is one-to-one. `read_locations` gives the model a city per person and
  a rounded distance per pair. The distance is computed inside `linq.ts`, so
  coordinates never reach the model, the log or storage — `location.read` in
  run history carries counts only.
- **1:1 iMessage only** — an Apple limit. The tool refuses in a group before
  anything is sent.
- **Two ways it hears back.** The `location.sharing.started` webhook is the fast
  path; a timer at 25s, 90s and 4min covers subscriptions made before that
  event was added. Bring an old subscription up to date, keeping its secret:
  `node scripts/linq-webhook.mjs events`
- **Needs the feature on the Linq account.** Without it Linq answers `403`,
  code `2011`, and the agent just asks them to type instead.
- **If a share stays empty:** it was probably started from the standalone Find My
  app, which binds it to their Apple ID email rather than the number. They need
  to re-share from inside the Messages conversation.

Try it without a phone:

```sh
curl -X POST localhost:5173/api/dev/tool -H 'content-type: application/json' \
  -d '{"chat":"demo","tool":"request_location","args":{}}'
curl -X POST localhost:5173/api/dev/location -H 'content-type: application/json' \
  -d '{"chat":"demo","from":"+15550001111","locality":"Toronto","region":"ON, Canada"}'
```

### Presence — read receipts, typing, a name and a face

When a message wakes the agent it marks the chat read and raises the typing
bubble at once (`presence` in the logs), seconds before the model answers. The
bubble is refreshed through long turns and dropped if the turn ends in silence.
A successful booking lands with confetti.

The name and photo are a Linq contact card, set once per number:

```sh
node scripts/linq-contact-card.mjs set "Whim"   # photo: <PUBLIC_BASE_URL>/card/avatar.png
node scripts/linq-contact-card.mjs show
```

The agent then offers the card to each chat the first time it is woken there.
All of this is best-effort and iMessage-only; failures are logged, never thrown.

### The chat becomes the plan

The moment a booking is confirmed, the group chat itself changes: it is renamed
after the outing, its icon becomes the plan's stamp, and its background changes
— so the thread list reads `🍜 Friday dinner · Kinton Ramen` instead of three
numbers, and opening it feels like the plan is already underway.

```
booked ─▶ chats.update  { display_name: "🍜 Friday dinner · Kinton Ramen" }
       ─▶ chats.update  { group_chat_icon: <base>/card/<chat>/icon.png }   the emoji over the venue, in the ticket's green
       ─▶ chats.background.set { type: "dynamic", style: "aurora" }
```

The emoji is the model's: `propose_plan` takes an optional `emoji` with the
ballot (🍜 ramen, 🎳 bowling); anything that is not one falls back to 📍. The
name is `src/dressing.ts` (pure, `npm test`), the icon is `renderPlanIcon` in
`card.ts`, and the three calls are `dressChat` in `linq.ts`. Everything is
code, never the model, and the same footing as presence: each call is
best-effort, a direct chat is left alone (a name and an icon are group things),
and Linq applies the change asynchronously — the phones catch up a moment after
the confetti. The outcome of each call is one `chat.dressed` log line.

```sh
open 'http://localhost:5173/api/dev/card?kind=icon&emoji=🎳&venue=The%20Ballroom'   # the icon, from sample data
curl -X POST localhost:5173/api/dev/booked -H 'content-type: application/json' \
  -d '{"chat":"demo"}'      # land a confirmed booking without a browser: ticket, confetti, and the chat's new name
```

`/api/dev/booked` is also the safety net for a live demo run from the laptop
(tunnel up, real chat id): if the venue's site is slow, the booked outcome can
be landed by hand and everything downstream — the ticket, the renamed chat,
the invoice — still happens for real. Like every `/api/dev/*` route it answers
only on localhost, so it is not there on the deployed Worker.

### Pairing — "find me someone to climb with"

In a direct chat, someone in the match pool can ask to be paired up
(`src/server/intros.ts` has the flow). Nobody's name or number reaches the other
person until both have said yes:

```
A's DM  find_matches  -> candidates as ref + blurb, no names   (Vectorize; shared-word scan if it is down)
        request_intro -> B is asked privately in B's DM         (one open ask per person)
B's DM  answer_intro  -> no:  A hears "no luck", never who
                         yes: a new group chat with both, and the match ticket
```

Without the model, in the simulator (both people need a saved profile with
`matchOptIn`, which needs one message from each first):

```sh
tool() { curl -s -X POST localhost:5173/api/dev/tool -H 'content-type: application/json' -d "$1"; }
tool '{"chat":"a","tool":"find_matches","args":{"who":"Ana","lookingFor":"someone to climb with"}}'
tool '{"chat":"a","tool":"request_intro","args":{"candidate":"c1","common":[{"text":"climbing"}]}}'
tool '{"chat":"b","tool":"answer_intro","args":{"answer":"yes"}}'
```

An ask nobody answers lapses after 48 hours and the asker is told. Each person
has one ask out, and is asked about one, at a time; a pair is never offered twice.

Vectorize has no local emulation, so its binding is `remote`: `npm run dev`
searches the real index (dev and prod share one pool — "forget me" removes test
people). It takes a minute or two to index a new profile, so every search also
runs an instant shared-word scan of the People store and merges the two; that
scan alone is what runs without a Cloudflare login.

### Logging — "why didn't it reply?"

Every hop logs one line in the same shape, `scope event {fields}`:

```
linq   webhook.received       {"type":"message.received","chat":"62c58f3a"}
agent  message.in             {"chat":"62c58f3a","from":"…5178","chars":38,"group":false}
agent  turn.start             {"chat":"62c58f3a","llm":"dev/gpt-oss:20b","history":4}
agent  tool                   {"chat":"62c58f3a","tool":"get_votes","args":"{}","ms":2}
agent  turn.end               {"chat":"62c58f3a","outcome":"silent","ms":4210,"tokens":1873,...}
```

Each chat's agent also keeps its last 300 events in its own SQLite, because the
console scrolls away and `wrangler tail` only shows what happens while you watch:

```sh
curl 'localhost:5173/api/dev/logs?chat=<chat id>'
```

Reading a turn: `turn.end` carries the `outcome` — `replied`, `silent` (the model
chose not to answer; expected in group chats), `llm_failed`, or `max_steps` —
plus `tokens`, so an expensive turn is obvious. No `webhook.received` line at
all means Linq never reached you: check the tunnel and the subscription URL.
`webhook.rejected` means the signing secret does not match the subscription.
Phone numbers are masked and message bodies are logged as lengths only.
Deployed, the same lines appear in `npx wrangler tail` and in Workers Logs.

Simulator chat ids (anything that is not a UUID) always use the dry Linq
transport, even with a live `LINQ_API_KEY`, so testing never texts anyone.

### Run viewer — what the agent did, turn by turn

`/runs` is a live view of every run across every chat: sessions and their runs
in a rail on the left, the selected run as a tape in the middle — one row per
step, with whatever the step produced printed under it — and a plain-English
explanation of the selected step on the right. It fills in step by step while a
turn is happening, so a text sent to the number shows up a moment later. It has
a night mode for projecting, and it is the same ticket design as the cards.

```sh
open http://localhost:5173/runs        # deployed: https://<worker>/runs
```

A **run** is one agent turn — everything between `turn.start` and `turn.end` —
plus its lead-in: the inbound message that woke it, or the research callback
that landed first. Those arrive before the turn opens, so the recorder holds
them and the turn adopts them; that is why a run's `trigger` reads
`message.in` or `research.finished` rather than always `turn.start`. Events
nothing ever adopts (a workflow reporting into a silent chat) become a run of
their own after two minutes instead of being dropped.

The store is D1, written by one `RunHub` Durable Object so the chats are not
independent writers racing on the same tables. The hub is also the socket the
viewer holds, so the same rows that get written get broadcast.

```
PlanAgent.note() ──> RunRecorder ──waitUntil──> RunHub ──> D1 (runs, run_events)
  (per chat)         groups into runs           (one)   └─> WebSocket -> /runs
```

Nothing new is exposed: these are the lines `note()` already logged, with phone
numbers masked and bodies as lengths. But unlike `/api/dev/*` this is reachable
on the deployed Worker, so set a token if that matters:

```sh
npx wrangler secret put RUNS_TOKEN     # then /runs?token=… , or a Bearer header
```

Unset, the viewer is open — fine locally, a deliberate choice anywhere else.

The JSON behind it, if you want to script against it:

```
GET /api/runs?chat=&outcome=&level=&before=&limit=   newest first, `before` pages
GET /api/runs/chats                                  chats that have runs
GET /api/runs/<runId>                                the run and its events
WS  /agents/run-hub/global                           hello | run.open | events | run.close
```

The schema lives in `migrations/0001_runs.sql`. It is not applied automatically:

```sh
npm run runs:migrate           # local
npm run runs:migrate:remote    # before the first deploy
```

Each chat's DO still keeps its own 300-event ring buffer for `/api/dev/logs`;
D1 is the durable, cross-chat copy that survives eviction.

### Research — real options from the live web

The `research` tool starts `ResearchWorkflow` (`src/server/research.ts`), which
uses Browserbase Search and Fetch and reports back to the chat's agent when done:

```
plan ─▶ search ─▶ select ─▶ read + extract ─▶ synthesize ─▶ agent.researchFinished()
LLM     Search     Jev       Fetch + LLM       LLM           model gets a turn, posts the card
```

The model decides what to look for and what the pages mean; fixed code does the
navigation, so a run is bounded. `DEPTH` in `research.ts` is the whole budget:
`quick` is 2 searches and 3 pages, `deep` is 4 and 8. Addresses, prices and
links in the report are copied from per-page extractions, never from the
ranking step's retelling.

With `AI_GATEWAY_API_KEY` set, research uses Jev scoring through Vercel AI Gateway; without it, the LLM
picks which results to read and extracted options go unscored (`research.jev_fallback` in the run log). Jev scores each search
result's metadata for relevance to the brief, and returns confidence in that
judgment separately. Defaults are relevance >= 2 on a 0–3 rubric and confidence
>= 0.5; tune `RESEARCH_MIN_RELEVANCE` and `RESEARCH_MIN_CONFIDENCE` against real
results. These are initial thresholds, not calibrated guarantees. `JEV_MODEL`
may be omitted or set to `typesafe-ai/jev`; other models are rejected. Requests use Vercel's TypeSafe-compatible endpoint
`https://ai-gateway.vercel.sh/typesafe/v1/systemone`; a direct TypeSafe key is no
longer used. Scores are recorded in `research.selected` with provider
`jev-vercel-gateway`.

Create a key in the Vercel AI Gateway dashboard and set `AI_GATEWAY_API_KEY` in
`.env` or `.dev.vars` for local development; for the deployed Cloudflare Worker,
run `npx wrangler secret put AI_GATEWAY_API_KEY` and deploy the updated code.
Vercel's [model catalog](https://vercel.com/ai-gateway/models) lists Jev as free
as of September 19, 2026, although its individual model page still lists a
per-token price. Check the Gateway dashboard for current pricing and limits.
This changes only Jev scoring; other research services retain their own billing.

Only passing results reach Fetch, sorted by relevance, with at most two URLs
per hostname and the existing page budget. If every result is rejected, the run
reports that explicitly instead of fetching poor matches. Provider errors and
malformed scores also cannot silently bypass the Jev gate. Search metadata does
not establish current availability, price, or factual accuracy; extraction still
uses the fetched page as evidence.

Source URLs are normalized and deduplicated before scoring. Jev evaluates up to
16 results per request with at most two requests in flight, using bounded metadata
rather than full pages. Every extracted option—including Browserbase skill listings,
menus, trails and events—is scored again against the actual planning constraints in
one shared stage before synthesis. Candidate scores are recorded in
`research.candidates_scored`; only passing candidates reach the response model.
Identical candidate evidence is evaluated once per call while retaining its source
attribution. New runs always receive fresh judgments.

Without an AI Gateway key, research stops before searching or opening a browser;
there is no general-LLM or unscored fallback. Provider errors, omitted judgments and
all-rejected batches also stop the run rather than weakening the gate. Without a
Browserbase key, search and page reading use the existing browser path, with the
same Jev gates. The Search/Fetch API path creates no watchable browser
session; booking continues to use browser sessions.

Run the isolated, mocked provider/selection checks with
`node --experimental-strip-types --test scripts/research-sources.test.mjs`.

Run the pipeline without waiting for the model to choose it:

```sh
curl -X POST localhost:5173/api/dev/research -H 'content-type: application/json' \
  -d '{"chat":"demo","brief":"birthday dinner for 8, ~$60pp, one vegetarian","near":"King West, Toronto","depth":"quick"}'
curl 'localhost:5173/api/dev/logs?chat=demo'     # research.planned / searched / read / finished
curl 'localhost:5173/api/dev/dump?chat=demo'     # .research is the full report
curl 'localhost:5173/api/dev/browse?q=ramen+waterloo'   # just the browser: one search, or ?url= for one page
```

On the browser fallback path, `research.finished` logs a replay link per
Browserbase session. Search/Fetch runs expose stage and score logs instead.
On the original local dev model a quick run took 2-4
minutes, nearly all of it LLM time on page extraction; it is much faster on the
demo profile. Without `BROWSERBASE_API_KEY`, `src/server/browser.ts` falls back
to Cloudflare Browser Rendering, which search engines tend to block.

### Reading the links people share — `src/server/social.ts`

When someone gives the agent their socials (in onboarding, or on the profile
form), it reads them and keeps a few interests on their profile, so plans and
matches fit them: "had a look at your instagram: rock climbing, big wall
routes, Yosemite. i'll plan with that in mind."

- **Only links a person gave about themselves, in their own chat, are ever
  read.** Nothing takes a handle from a group, a contact list or another person.
  "The account is public" is not the permission; the owner asking is.
- **They are told what was read**, and `forget my links` (handled in code, not by
  the model) deletes the links and everything derived from them. `forget me`
  deletes the whole profile.
- The summariser may only note tastes and hobbies. It is barred from inferring
  health, religion, politics, sexuality, ethnicity, relationships, money or
  where someone lives, and returns nothing rather than pad.
- Public sites (Letterboxd, GitHub, a personal page) are read logged out.
  **Instagram needs a login**, so it goes through the bot's own throwaway
  account, held in a persistent Browserbase context:

```sh
node scripts/ig-login.mjs     # prints a live-view link; log in BY HAND; it saves itself
```

  The password is typed into the remote browser by a person and never touches
  the repo, a secret or a prompt — keep it that way. Automation is against
  Instagram's terms and the account can be challenged or banned at any time, so
  a login wall, a private account or a dead link all end in a quiet skip.
  `BROWSERBASE_CONTEXT_ID` names the context (`.env` locally, a secret in prod).

```sh
curl -G localhost:5173/api/dev/links --data-urlencode 'l=@someone on instagram' --data-urlencode 'l=letterboxd.com/someone'
curl -G localhost:5173/api/dev/links --data-urlencode raw=<handle>     # the unsummarised text
```

### Payment setup — per person, never a card number

Linq's agent payments let a person connect a wallet once and then approve
purchases one at a time with a passkey; each approval mints a single-use virtual
card for that purchase alone. This app implements the **setup half only** — no
money moves, and nothing here ever sees a card number.

In a direct chat a person texts `set up payments`. Linq sends them a one-time
code and runs the consent step itself; they text the code back, the agent
verifies it, marks their profile `has payments set up`, and sends Linq's
"Add a card" card. `remove my payments` revokes this app's permission (their
wallet is theirs and untouched).

All of it is handled in code in `handlePaymentSetup`, never by the model: it is
the one flow where a misread intent costs someone money or trust. The model is
only told which words to point people at, and that it must never ask for or
accept card details. Verification codes are replaced with `[verification code]`
in the transcript before the model can read them. Simulator chats use a stub
(`000000` is the right code) so tests never touch a real wallet.

### Paying — one tapback

A 👍 or ❤️ on a cart (its card or its product photo), or a message that is only
"i'll pay" / "charge me" / "pay", means *that person covers that cart*. Linq
says who reacted, so identity needs no extra step. Everything after that is
code — `startPay` in `agent.ts`, the `pay` branch of `BookingWorkflow`, and
`checkout.ts` — and the model is never involved:

1. **Guards.** Cart unpaid and not already being paid · the payer's wallet is
   connected (else: "text me set up payments") · a delivery address is on file
   (else a link card to `/p/<token>/ship`; saving it resumes the payment by
   itself).
2. **Price it.** A browser opens the store's checkout and fills contact and
   shipping by rote (every Shopify checkout has the same field names, so no
   model and no tokens). The store prices shipping and tax; the real total is
   read off the page. Over `PAY_CAP_CENTS` (default 6000) → stop.
3. **Mint a card.** `payments.create` for exactly that total at exactly that
   merchant, with an idempotency key per attempt. If Linq wants the person to
   add a card or approve with their passkey, a link card is sent once and the
   workflow polls with the same key for up to four minutes.
4. **Pay.** The card is fetched from the provider (never through Linq), typed
   into Shopify's card iframes, each field verified from inside its frame, the
   total re-checked against the minted amount, then Pay. On confirmation the
   cart flips to the green PAID ticket with "paid by <name>".

`PAYMENTS_LIVE` must be the string `"true"` for step 3 onward to run. Anything
else prices the order, confirms the card form is reachable, reports the total,
and stops — which is also what every simulator chat does.

Card details exist only as local variables inside one workflow step: never
logged, never stored, never returned from a step (step results are persisted),
never in a prompt. If Pay was pressed and the store never confirmed, the agent
says so instead of "nothing was charged", and leaves the card open rather than
risk voiding a real order. A failure before that closes the card.

Try the no-money half against a real store:

```sh
curl -G localhost:5173/api/dev/checkout --data-urlencode "url=<a cart's checkout url>" \
  --data-urlencode "line1=1600 Amphitheatre Pkwy" --data-urlencode "city=Mountain View" \
  -d region=CA -d postal=94043 -d country=US -d card=test   # types Stripe's test number, never presses Pay
```

Not yet proven, because it needs a real connected wallet: the shape of the
provider's card response (`paymentCard` searches for the four values by common
names and fails loudly, listing the keys it saw), whether every purchase needs a
passkey approval, non-USD totals, and whether stores' fraud checks accept an
order placed from a datacenter browser. Shopify's own checkout API is no use
here: `create_checkout` is listed by stores but answers "Tool not found" for
this agent, and its card field wants a pre-tokenized credential.

### The invoice — who paid what, who owes whom

Once things get bought, the question is "so what do I owe?". The invoice
answers it, and it is **derived, never kept**: worked out fresh, every time,
from the carts (with the real post-tax total once one is paid), who paid each,
and the headcount — so it cannot drift from them. Pay a cart, resize one, or
change who is going, and the invoice is already different. The one thing that
is stored is money that never went through a cart, logged from the chat.

```
carts + paidBy ─┐
expenses        ├─▶ src/invoice.ts ─▶ per-person paid / share / net, and the fewest
who's going ────┘   (pure, shared)      transfers that square everyone up
```

It shows in three places, from the same function:

| Where | When |
|---|---|
| **Invoice ticket** in the chat (cream while a store is still unpaid, green once everything is bought) | on its own the moment the last cart is paid, and on `show_invoice` when someone asks |
| **Live section on `/w/<chat>`** — balances, "to settle up", anything paid outside the carts | always current over the vote page's WebSocket |
| **`Invoice:` line in the model's context** | every turn, so "what do I owe?" is read off, never worked out by the model |

Money outside a cart — the bill, a deposit, the cab — is `add_expense`, called
only when a person in the chat says so with an amount. Paying someone back is
the same tool with `for` naming that one person: "Jordan paid Maya back $32"
is Jordan paying $32 for Maya alone, which is exactly what settles the debt.
`drop_expense` takes a wrong one out. Everything is in integer cents; odd cents
go one each to the first people in the split, so the nets always sum to zero.
Stores in different currencies cannot be added, so then there is no invoice —
the same rule the shopping list uses.

```sh
npm test                                            # the math, on its own (node --test, no server)
open 'http://localhost:5173/api/dev/card?kind=invoice&state=open'   # the ticket, from sample data
curl -X POST localhost:5173/api/dev/tool -H 'content-type: application/json' \
  -d '{"chat":"demo","tool":"add_expense","args":{"who":"Maya","amount":"$86.40","what":"dinner"}}'
curl 'localhost:5173/api/dev/dump?chat=demo'        # .invoice is the whole thing, .state.expenses the log
```

Not tracked: whether the transfers actually happened. The agent's job ends at
"here is who owes whom"; if that needs a green tick per person one day, it is
one more `for`-one-person expense, not a new ledger.

### Booking and availability — the browser pilot

`src/server/pilot.ts` drives a venue's own booking page: it lists what a person
could interact with (across iframes), the model picks one action, the pilot
performs it and looks again. Two tools use it:

| Tool | What it does |
|---|---|
| `check_availability` | Read-only. Reaches the date, reads the open times for the party size, stores them on the option (`availability`) and wakes the agent to tell the group. Never books or types details. |
| `book_option` | Fills the reservation through to the end. Needs the booker's real name and email (invented ones are refused). |

A booking ends one of three ways, and the plan status says which: **booked**
(confirmed), **handoff** (taken as far as the agent may go — a dry run, or the
payment page — with a line saying exactly what was set up, the venue's link and
a screenshot), or **failed**.

The rails are code, not prompt: payment fields are never shown to the model and
reaching one ends the run; the final submit is its own action, so a dry run
stops one click short and a read-only run refuses it; invented contact details
are forbidden; runs are capped and end early when they repeat themselves. The
workflow's pilot step has no retries, because a retry could submit twice.

While a booking runs the group gets `${PUBLIC_BASE_URL}/live/<chat>`, a redirect
to Browserbase's live view of the browser being driven.

```sh
# Drive one site directly, always as a dry run (localhost only):
curl -G localhost:5173/api/dev/pilot --data-urlencode mode=availability \
  --data-urlencode 'url=https://…' --data-urlencode 'task=Find times for 4 on Saturday evening'
# mode=book fills the form; mode=inspect&find=<word> shows what the pilot sees and the raw markup
```

### Trips — flights, stays, events, and what happens after

The same chat plans a weekend away. Three tools read real options over
Browserbase Fetch (residential proxies, no browser) using recipes from the
[browse.sh](https://browse.sh) skill catalog, and return them in the same turn,
shaped as ballot options:

| Tool | Source | What comes back |
|---|---|---|
| `search_flights` | Google Flights (`/travel/flights?q=…`, server-rendered) | airline, times, stops, duration, price, a link with a Book button |
| `search_stays` | Google Hotels (`/travel/search`, the page's data blob) | hotel, nightly price, rating, reviews, a link to its rates |
| `find_events` | Ticketmaster's internal artist-events API, or Luma's city feed | title, date, venue, on-sale window, sold-out flags, a link |

The group votes with tapbacks as always. Once a vote settles the model calls
`add_to_itinerary`: the winner becomes a stop on the **itinerary** (a list on
the plan), the itinerary ticket is posted, the chat gets the link to finish the
booking themselves, and the ballot clears for the next segment. The agent never
books or pays for flights, rooms or tickets: those links open the site's own
checkout. `confirm_item` marks a stop booked when a person says so, and logs
what they paid so the invoice splits it. A venue booked by the pilot and an
order paid through a cart appear on the same itinerary.

**Watching.** `watch_flight AC123` reads FlightAware now and every 15 minutes
from 36 hours before departure until it lands, posting only changes: a delay of
15 minutes or more (and each further 15), a gate or terminal change, departed,
landed, cancelled. A paid order is watched through the store's order status
page until it is delivered: "shipped" with the carrier and tracking link, then
"delivered". Each is said once, as a text line.

```sh
curl 'localhost:5173/api/dev/source?kind=flights&from=YYZ&to=YVR&depart=2026-10-10'   # one recipe, no model
curl 'localhost:5173/api/dev/source?kind=events&city=Toronto&query=Toronto%20Raptors'
curl 'localhost:5173/api/dev/source?kind=flight&ident=AC123'
curl -X POST localhost:5173/api/dev/watch -H 'content-type: application/json' -d '{"chat":"demo"}'   # check now
curl -X POST localhost:5173/api/dev/shipped -H 'content-type: application/json' \
  -d '{"chat":"demo","itemId":"i1a2b","carrier":"Canada Post","tracking":"7023…","trackingUrl":"https://…","eta":"Tuesday"}'   # demo a delivery
curl -X POST localhost:5173/api/dev/seedflight -H 'content-type: application/json' \
  -d '{"chat":"demo","itemId":"i1a2b","ident":"AC123"}'   # watch an item as a flight without reading FlightAware
open 'http://localhost:5173/api/dev/card?kind=itinerary&state=open'
```

Only recipes that work from this account are wired: Browserbase's "verified"
stealth mode is Enterprise-only and proxied browser sessions are not on the free
plan, which rules out Kayak, Skyscanner, Booking.com, Airbnb, Expedia, OpenTable
and every parcel carrier's own page. The parsers are pinned by fixtures in
`scripts/fixtures/sources/`; when Google changes its markup, `source.empty` in
the run viewer names the page that came back.

### LLM usage sources

`LLM_PROFILE` picks where tokens are spent:

| Profile | Provider | Use for |
|---|---|---|
| `dev` (default) | `DEV_LLM_BASE_URL` — any OpenAI-compatible endpoint | Everyday testing. Spends no OpenAI credits. |
| `demo` | OpenAI (`OPENAI_API_KEY`, `OPENAI_MODEL`) | The deployed Worker, and final prompt tuning |

**Recommended dev provider: your Claude plan.** `npm run llm` starts
`scripts/claude-llm-proxy.mjs`, an OpenAI-compatible endpoint on
`127.0.0.1:11435` that answers each request with headless Claude Code
(`claude -p`), signed in with your Claude subscription:

```sh
npm run llm                 # terminal 1 — leave running
npm run dev                 # terminal 2
# .env:
DEV_LLM_BASE_URL=http://127.0.0.1:11435/v1
DEV_LLM_API_KEY=unused
DEV_LLM_MODEL=haiku         # or sonnet / opus — heavier on your plan's limits
```

A model call takes about 1.5s and a whole agent turn a few seconds. Things to
know:

- **It spends your plan's usage limits** — the same pool your interactive Claude
  Code sessions use. A conversation with a research run is ~25 model calls.
  Prefer `haiku`, and drive cards with `/api/dev/tool` (no LLM at all).
- **Laptop only.** It cannot serve the deployed Worker, and it listens on
  loopback only: anyone who can reach the port can spend your plan.
- The proxy removes `ANTHROPIC_API_KEY` from the child's environment. With that
  variable set, `claude -p` silently bills the API key instead of the plan.
- The agent's tools reach Claude Code as real MCP tools, and the proxy stops the
  run at the model's first tool call. Describing the tools in the prompt instead
  does not work — the model attempts a native call, finds nothing, and reports
  the tool as broken.
- **Claude is not the demo model.** It follows the prompt more carefully than
  `gpt-5-mini` will. Do a final pass of any prompt change on the `demo` profile.

Alternatives for `dev`: a local Ollama (`http://localhost:11434/v1`, free, slow,
and small models leak reasoning and skip tools) or Workers AI's
OpenAI-compatible endpoint — see `.dev.vars.example`.

## Setting up the dependencies

### 1. The toolchain

**Node 20 or newer** (developed on 26) and **npm**. The lockfile is
`package-lock.json`, so installing with pnpm or yarn produces a different tree —
don't. `wrangler` comes from the dev dependencies, so there is nothing to
install globally; every command below uses `npx wrangler` or an npm script.

```sh
node --version    # v20+
npm install
```

### 2. The accounts

Work down the table. Only the first row is required to get *something* running
locally; the rest turn features on.

| Service | What you need | Goes in | Without it |
|---|---|---|---|
| **Cloudflare** | `npx wrangler login`, then a D1 database and a Vectorize index (see *Cloudflare setup from scratch*) | `wrangler.jsonc` | nothing deploys; local dev still works |
| **A model** | one of the four rows in *Where the model comes from* | `.dev.vars` | the agent cannot think — every turn fails |
| **Linq** | account key, and a number to send from | `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET` | sends are logged, not delivered. Fine for local work |
| **Browserbase** | API key from the dashboard | `BROWSERBASE_API_KEY` | falls back to Cloudflare Browser Rendering, whose datacenter IPs review sites block |
| **OpenAI** | API key | `OPENAI_API_KEY` | needed for deploys, which run `LLM_PROFILE=demo` |
| **Instagram** | a throwaway account for the bot, logged in once (below) | `BROWSERBASE_CONTEXT_ID` | reading someone's linked Instagram hits a login wall |
| **Shopify** | nothing | — | — (stores are called over UCP, which is public) |

Local secrets live in `.dev.vars` (copy `.dev.vars.example`). Production secrets
are separate and go in one at a time with `npx wrangler secret put NAME`.

### 3. One-time setup scripts

None of these are needed to run the agent locally; each turns on one thing.

```sh
node scripts/ig-login.mjs                    # log the bot's Instagram in, by hand,
                                             # in a remote browser. Prints BROWSERBASE_CONTEXT_ID.
                                             # The password never touches this repo.
node scripts/linq-contact-card.mjs set "Whim"   # the name and photo people see for the number
node scripts/linq-webhook.mjs create <url> --env   # point Linq at your tunnel (see above)
```

### 4. Check it works

```sh
npm run smoke        # deterministic checks against the local dev server, no model calls
npm run typecheck
```

Run `npm run smoke` after every pull and before every deploy — several people
edit this repo at once and it covers the things that have already broken.

### What each package is for

| package | why |
| --- | --- |
| `agents` | the Durable Object framework behind `PlanAgent` and `RunHub` — state, WebSockets, scheduling |
| `@linqapp/sdk` | iMessage: sending, cards, tapbacks, webhook verification |
| `openai` | the model client. Points at OpenAI or any OpenAI-compatible endpoint via the `dev` profile |
| `@cloudflare/puppeteer` | drives the browser for research and booking, over CDP |
| `workers-og` | renders the plan and cart cards to PNG inside the Worker |
| `zod` | validates tool arguments coming back from the model |
| `react` / `react-dom` | the vote page and the `/runs` viewer |

**Dev dependencies:** `vite` + `@cloudflare/vite-plugin` (one dev server for both
the Worker and the React app), `@vitejs/plugin-react`, `typescript`, `wrangler`.

**Cloudflare services used:** Durable Objects with SQLite, Workflows, D1,
Vectorize, Browser Rendering, Workers AI (embeddings), and R2 (optional, off).

## Cloudflare setup from scratch

For a teammate standing this up on their own Cloudflare account. Everything the
Worker binds to has to exist *before* the first deploy — `wrangler deploy` fails
on a missing binding rather than creating one for you.

**Expect to need a Workers Paid plan.** Browser Rendering, Workflows and
Vectorize are not on the free tier, and the agent uses all three: research and
booking drive a browser, and both run as Workflows.

```sh
npx wrangler login                 # opens a browser; pick the right account
npx wrangler whoami                # confirm the account id you just authorised
```

### 1. Create the resources

```sh
# Run history (the /runs viewer). Copy the printed database_id.
npx wrangler d1 create htn-runs

# People matching. 768 dims because match.ts embeds with @cf/baai/bge-base-en-v1.5.
npx wrangler vectorize create htn-people --dimensions=768 --metric=cosine
```

Paste the D1 id into `wrangler.jsonc` under `d1_databases[0].database_id`. The
Durable Objects (`PlanAgent`, `RunHub`), the Workflows and the Browser Rendering
and AI bindings need no setup — they are created from `wrangler.jsonc` on deploy.

### 2. Apply the D1 schema

Not automatic, and both halves are needed — local and remote are separate
databases:

```sh
npm run runs:migrate           # local (miniflare), for `npm run dev`
npm run runs:migrate:remote    # the real D1, before the first deploy
```

Skip the remote one and `/runs` returns 500 on `no such table: runs`.

### 3. Secrets

Local dev reads `.dev.vars` or `.env`; production needs each one put
individually. `cp .dev.vars.example .dev.vars` and fill it in, then:

```sh
for s in LINQ_API_KEY LINQ_WEBHOOK_SECRET OPENAI_API_KEY PUBLIC_BASE_URL \
         BROWSERBASE_API_KEY IMESSAGE_TEAM_ID IMESSAGE_BUNDLE_ID; do
  npx wrangler secret put $s
done
```

| secret | what it is | needed for |
| --- | --- | --- |
| `LINQ_API_KEY` | Linq account key | sending and receiving iMessage |
| `LINQ_WEBHOOK_SECRET` | written by `scripts/linq-webhook.mjs create` | verifying inbound webhooks |
| `OPENAI_API_KEY` | OpenAI key | the `demo` LLM profile, which is what deploys use |
| `PUBLIC_BASE_URL` | this Worker's own URL | card images, the vote page, the Shopify agent profile |
| `BROWSERBASE_API_KEY` | Browserbase key | research and booking. Optional — without it, Cloudflare Browser Rendering is used, on datacenter IPs that review sites block |
| `IMESSAGE_TEAM_ID` / `IMESSAGE_BUNDLE_ID` | your Messages extension identity | interactive cards. Blank is fine: cards fall back to image + text |
| `RUNS_TOKEN` | any random string | locks `/runs` in production. Unset leaves run history public |

`RUNS_TOKEN` is deliberately not in the loop above — decide whether you want it.
Localhost never asks for it either way.

### 4. Deploy and point Linq at it

```sh
npm run deploy
node scripts/linq-webhook.mjs create https://<worker-url> --deployed
node scripts/linq-webhook.mjs use <worker-url>
```

Only one subscription may be active at a time — see *Which agent is live* below.

### If a deploy fails

| message | cause |
| --- | --- |
| `binding ... not found` | the D1 or Vectorize resource was never created, or the id in `wrangler.jsonc` is wrong |
| `no such table: runs` on `/runs` | `npm run runs:migrate:remote` was skipped |
| `not available on your plan` | the account is on the free tier; Browser Rendering, Workflows and Vectorize need Workers Paid |
| `Invalid cache control` from Shopify | `PUBLIC_BASE_URL` is unset or wrong, so the agent profile is unreachable |

## Deploy

Live at **https://whim.schangchang-li.workers.dev**. A redeploy takes
about ten seconds:

```sh
npm run deploy      # builds, then deploys with LLM_PROFILE=demo (OpenAI)
```

`wrangler.jsonc` keeps `LLM_PROFILE` at `dev` so local work never spends OpenAI
credits; the deploy script overrides it for production only.

R2 (card image caching) is optional and currently off — see the note in
`wrangler.jsonc`.

### Which agent is live: deployed or your laptop

Linq delivers to every active subscription, and two live agents means two
replies to every text. Keep exactly one active:

```sh
node scripts/linq-webhook.mjs list
node scripts/linq-webhook.mjs use workers.dev          # the deployed Worker answers
node scripts/linq-webhook.mjs use trycloudflare        # your laptop answers (tunnel must be up)
node scripts/linq-webhook.mjs create <tunnel-url> --env   # after a tunnel restart: new URL, new secret
node scripts/linq-webhook.mjs prune                    # delete dead, inactive subscriptions
```

Production logs: `npx wrangler tail`. The simulator routes (`/api/dev/*`) are
localhost-only and return 404 on the deployed Worker.

## Things that will bite you

- **Shopify needs a public URL, not a deploy.** Shopify fetches
  `${PUBLIC_BASE_URL}/.well-known/ucp-agent.json` to validate every call, so a
  localhost URL fails with `profile_unreachable`. A tunnel is enough — see
  "Real iMessage from your laptop" above.
- **A dry run still touches the venue.** With `BOOKING_DRY_RUN` on (the
  default) the pilot stops one click before confirming, but by then the slot is
  in the venue's basket, which holds real inventory for a while, and the
  contact step may have created a customer record. Repeated test runs made
  times vanish from a real calendar. Test sparingly, on far-out dates.
- **Many venues block datacenter IPs.** Two of three escape rooms tried answered
  "Access from unauthorized IP address" (their booking widget, not the pilot).
  Browserbase residential proxies fix this but need a paid plan.
- **Cards render through Linq's "Agent Apps" iMessage app.** With no
  `IMESSAGE_TEAM_ID` / `IMESSAGE_BUNDLE_ID`, cards go out as Linq *experiences*
  (`link` for the plan, `agentpay` then `link` for the cart) — no Xcode or Apple
  developer account. A phone without Agent Apps installed shows only the static
  captions under an "Open in Agent Apps" header: no image, no button. Install it
  on every demo phone. (Setting your own identity instead requires your own
  Messages extension on each phone; a *wrong* identity renders as plain text
  with no error.)
- **People have profiles that follow them between chats.** `People` is one
  Durable Object keyed by phone handle (`src/server/people.ts`). It fills two
  ways, both first-hand: the agent's `remember_fact` tool, for things someone
  says about themselves, and a form at `/p/<token>` that the harness texts to a
  person once in a direct chat (or whenever they text "profile"). The link is
  the credential, so it is never posted to a group. Each turn gets an "About
  the people" block; ticking "count me in for matching" on the form is what
  adds someone to the match pool; "forget me" deletes the lot.
- **Designed cards are photos ("tickets").** Agent Apps draws the card bubble
  itself and shows none of our image, so every designed card — plan, venue,
  who's in, order, match intro — is one ticket renderer (`src/server/card.ts`)
  sent as a photo at the moment it opens and the moment it resolves, never per
  change. Tickets are stored per chat and served at `/card/<chat>?t=<id>`.
  Preview any of them without a chat at
  `/api/dev/card?kind=plan|cart|venue|rsvp|match&state=open|done`; the designs
  are in `docs/card-system-mockups.html`.
- **A card's message id changes on every redraw.** `updateCard` returns the new
  id and the caller must store it, or the next redraw and every tapback after
  it will miss. The agent keeps all of a card's ids for tapback matching.
- **Everyone in the chat needs iMessage**, and on a shared Linq line each person
  must text the number first (inbound-first).
- `vite.config.ts` needs the `agents()` plugin, or `@callable()` is a syntax
  error at Worker startup.

## Agent observability

The existing `/runs` viewer now includes **Performance & diagnostics** for each
run: per-model-call p50/p95, input/output/cached/reasoning token counts, errors,
JSON retries, unfinished spans, and cumulative latency by operation. Clicking a
slow operation or error opens its event details, including trace/span IDs and
Sentry event IDs when exported. Percentiles are for the selected run, not global
service SLAs. Overlapping and nested durations are not additive wall time.
Optimization observations identify slow operations, validation retries, low cache
reuse and repeated work; they are investigation suggestions, not automatic
changes to models, prompts or side-effect ordering. Old runs retain their events
but do not acquire retroactive span metrics.

Tracing covers Worker requests and Durable Object/Agent execution in Sentry,
plus locally recorded agent turns, model calls, SDK transport attempts, tools,
research and booking workflow attempts, Browserbase Search/Fetch, Jev, browser
observation and browser actions. Actual Workflow step callbacks are traced so
cached replay results are not reported as fresh work. Workflow telemetry reports
back into the same chat's run viewer. SDK transport HTTP status and retryability
are recorded, with non-success responses marked as failed spans without altering
the SDK's retry behavior.

Model decisions are recorded as tool selections, short action summaries,
validation outcomes and execution guards. Raw private reasoning is neither
captured nor rendered, including legacy `thinking` fields. `reasoningTokens` is a
usage counter, not reasoning text. Existing `LOG_BODIES` still controls message
text in the local run history. External Sentry payloads contain operational
metadata only: no prompts, completions, tool arguments, HTTP bodies, request
headers, contact details or payment data. Error messages stay in the protected
run dashboard; Sentry receives exception types, stack frames and correlation IDs.

To enable external export, create a Sentry Cloudflare/JavaScript project, set
`SENTRY_DSN` in `.env`/`.dev.vars`, and configure `SENTRY_ENVIRONMENT`, optionally
`SENTRY_RELEASE` and `SENTRY_TRACES_SAMPLE_RATE` (default `0.2`). For production,
set the DSN with `npx wrangler secret put SENTRY_DSN`, set environment to
`production`, then deploy. The existing dashboard works without a DSN. Trace
sampling applies to Sentry exports, not local dashboard events. The SDK captures
handled operation errors and uncaught request/DO/workflow errors and exports
structured logs. No source-map upload or Sentry account setup is performed by
this repository; configure release source maps separately if needed.

Verify with `npm run typecheck`, `npm test`, and `npm run build`. For a UI smoke
check without calling any real model, booking, payment or messaging service:

```sh
npm run runs:migrate
node scripts/observability-smoke.mjs
# Open http://localhost:5173/runs/observability-local-smoke
```

The fixture is explicitly labelled `LOCAL SYNTHETIC CHECK` and only writes the
local D1 database. It exercises a successful model span, a failed provider span,
token counters, retry diagnostics, and dashboard navigation.

### Stuck-run watchdog

Run history has a generous **30-minute absolute deadline** for runs with no recorded
completion. RunHub checks every minute using a durable schedule, and checks again
when the viewer loads history. This also repairs stranded runs from before a restart
or deployment. The deadline closes the run as `timed_out`, stores an error event,
and reports a `RunTimeoutError` to Sentry with the run ID. Sentry's event ID is stored
with the error when available; no message text is included in the exception.

The viewer shows **Timed out**, a visible error message and the Sentry event ID,
instead of an endless working indicator. It refreshes history every 15 seconds to
recover missed WebSocket updates. Late completion and stale snapshots cannot erase
a timeout. The timeout reports missing completion; it cannot cancel or undo an
external booking/payment already submitted, so check its status before retrying.
