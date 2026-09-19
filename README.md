# Plan — an iMessage group-chat planning agent

An agent that lives in an iMessage group chat. It brainstorms a hangout with the
group, posts a card to vote on, books the winner, and builds Shopify carts for
anything the group needs. It runs entirely on Cloudflare Workers.

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
   │     ├─ search_places · propose_plan · get_votes
   │     ├─ research ──► ResearchWorkflow (durable, minutes-long)
   │     │                 └─ Browserbase: search, read pages   src/server/browser.ts
   │     ├─ shop_search · shop_build_cart   → Shopify UCP (JSON-RPC, no key)
   │     ├─ join_match_pool · find_matches  → Workers AI embeddings + Vectorize
   │     └─ book_option ──► BookingWorkflow (durable, retried)
   │                          └─ Browser Rendering (Puppeteer)
   └─ card PNG: workers-og, cached in R2 per plan version  src/server/card.ts
```

| Cloudflare product | What it does here |
|---|---|
| Workers | Webhook ingress, routing, card rendering, serving the vote page |
| Durable Objects (Agents SDK) | One stateful agent per chat: memory, state, scheduling |
| Workflows | The booking run: multi-step, survives restarts, never books twice |
| Browser Rendering | Drives the reservation site |
| Vectorize + Workers AI | Interest embeddings and nearest-neighbour matchmaking |
| R2 | Rendered card images |

## Run it locally — no Linq number, no OpenAI spend

```sh
npm install
npm run dev
```

With no `LINQ_API_KEY` set, the Linq transport is **dry**: sends are logged, not
delivered. Drive the agent with the localhost-only simulator:

```sh
curl -X POST localhost:5173/api/dev/message -H 'content-type: application/json' \
  -d '{"chat":"demo","from":"+15550001111","text":"dinner friday? ramen downtown"}'
curl -X POST localhost:5173/api/dev/react -H 'content-type: application/json' \
  -d '{"chat":"demo","from":"+15550001111","reaction":"like"}'
curl -X POST localhost:5173/api/dev/tool -H 'content-type: application/json' \
  -d '{"chat":"demo","tool":"propose_plan","args":{"title":"Friday dinner","options":[{"title":"A"},{"title":"B"}]}}'
                                                  # run any agent tool directly: no LLM, no tokens
curl 'localhost:5173/api/dev/dump?chat=demo'      # state, transcript, votes
open  'http://localhost:5173/w/demo'              # live vote page
open  'http://localhost:5173/card/demo'           # the card image
```

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

### Logging — "why didn't it reply?"

Every hop logs one line in the same shape, `scope event {fields}`:

```
linq   webhook.received       {"type":"message.received","chat":"62c58f3a"}
agent  message.in             {"chat":"62c58f3a","from":"…5178","chars":38,"group":false}
agent  turn.start             {"chat":"62c58f3a","llm":"dev/gpt-oss:20b","history":4}
agent  tool                   {"chat":"62c58f3a","tool":"search_places","args":"{...}","ms":2}
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

### Research — real options from the live web

The `research` tool starts `ResearchWorkflow` (`src/server/research.ts`), which
browses through Browserbase and reports back to the chat's agent when done:

```
plan ─▶ search ─▶ select ─▶ read + extract ─▶ synthesize ─▶ agent.researchFinished()
LLM     browser    LLM       browser + LLM     LLM           model gets a turn, posts the card
```

The model decides what to look for and what the pages mean; fixed code does the
navigation, so a run is bounded. `DEPTH` in `research.ts` is the whole budget:
`quick` is 2 searches and 3 pages, `deep` is 4 and 8. Addresses, prices and
links in the report are copied from per-page extractions, never from the
ranking step's retelling.

Run the pipeline without waiting for the model to choose it:

```sh
curl -X POST localhost:5173/api/dev/research -H 'content-type: application/json' \
  -d '{"chat":"demo","brief":"birthday dinner for 8, ~$60pp, one vegetarian","near":"King West, Toronto","depth":"quick"}'
curl 'localhost:5173/api/dev/logs?chat=demo'     # research.planned / searched / read / finished
curl 'localhost:5173/api/dev/dump?chat=demo'     # .research is the full report
curl 'localhost:5173/api/dev/browse?q=ramen+waterloo'   # just the browser: one search, or ?url= for one page
```

`research.finished` logs a Browserbase replay link per session — open it first
when a run comes back thin. On the local dev model a quick run takes 2-4
minutes, nearly all of it LLM time on page extraction; it is much faster on the
demo profile. Without `BROWSERBASE_API_KEY`, `src/server/browser.ts` falls back
to Cloudflare Browser Rendering, which search engines tend to block.

### LLM usage sources

`LLM_PROFILE` picks where tokens are spent:

| Profile | Provider | Use for |
|---|---|---|
| `dev` (default) | `DEV_LLM_BASE_URL` — any OpenAI-compatible endpoint | Everyday testing. Free. |
| `demo` | OpenAI (`OPENAI_API_KEY`, `OPENAI_MODEL`) | The demo and final prompt tuning |

`.env` currently points `dev` at local Ollama (`gpt-oss:20b`). Workers AI's
OpenAI-compatible endpoint works too — see `.dev.vars.example`. Small models are
chattier and miss instructions (e.g. `remember_name`); judge prompt quality on
the `demo` profile only.

## Deploy

Live at **https://htn-planner.schangchang-li.workers.dev**. A redeploy takes
about ten seconds:

```sh
npm run deploy      # builds, then deploys with LLM_PROFILE=demo (OpenAI)
```

`wrangler.jsonc` keeps `LLM_PROFILE` at `dev` so local work never spends OpenAI
credits; the deploy script overrides it for production only.

First-time setup on a fresh Cloudflare account:

```sh
npx wrangler login
npx wrangler vectorize create htn-people --dimensions=768 --metric=cosine
npm run deploy
node scripts/linq-webhook.mjs create https://<worker-url> --deployed   # subscription + its secrets
for s in LINQ_API_KEY OPENAI_API_KEY BROWSERBASE_API_KEY; do npx wrangler secret put $s; done
```

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
- **The booking flow is a stub.** `BookingWorkflow.reserve` fails loudly until
  you script the selectors for the one site you will book on stage.
  `BOOKING_DRY_RUN` is `"true"` by default.
- **Cards render through Linq's "Agent Apps" iMessage app.** With no
  `IMESSAGE_TEAM_ID` / `IMESSAGE_BUNDLE_ID`, cards go out as Linq *experiences*
  (`link` for the plan, `agentpay` then `link` for the cart) — no Xcode or Apple
  developer account. A phone without Agent Apps installed shows only the static
  captions under an "Open in Agent Apps" header: no image, no button. Install it
  on every demo phone. (Setting your own identity instead requires your own
  Messages extension on each phone; a *wrong* identity renders as plain text
  with no error.)
- **A card's message id changes on every redraw.** `updateCard` returns the new
  id and the caller must store it, or the next redraw and every tapback after
  it will miss. The agent keeps all of a card's ids for tapback matching.
- **Everyone in the chat needs iMessage**, and on a shared Linq line each person
  must text the number first (inbound-first).
- `src/server/tools/places.ts` returns stub venues — wire a real provider.
- `vite.config.ts` needs the `agents()` plugin, or `@callable()` is a syntax
  error at Worker startup.
