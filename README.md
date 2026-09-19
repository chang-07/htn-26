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
curl 'localhost:5173/api/dev/dump?chat=demo'      # state, transcript, votes
open  'http://localhost:5173/w/demo'              # live vote page
open  'http://localhost:5173/card/demo'           # the card image
```

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

```sh
npx wrangler login
npx wrangler r2 bucket create htn-cards
npx wrangler vectorize create htn-people --dimensions=768 --metric=cosine
for s in LINQ_API_KEY LINQ_WEBHOOK_SECRET OPENAI_API_KEY PUBLIC_BASE_URL; do npx wrangler secret put $s; done
# set "LLM_PROFILE": "demo" in wrangler.jsonc, then:
npm run deploy
```

Then create a Linq webhook subscription for `message.received` and
`reaction.added` pointing at `${PUBLIC_BASE_URL}/api/webhooks/linq`.

## Things that will bite you

- **Shopify tools only work when deployed.** Shopify fetches
  `${PUBLIC_BASE_URL}/.well-known/ucp-agent.json` to validate every call, so a
  localhost URL fails with `profile_unreachable`.
- **The booking flow is a stub.** `BookingWorkflow.reserve` fails loudly until
  you script the selectors for the one site you will book on stage.
  `BOOKING_DRY_RUN` is `"true"` by default.
- **Interactive cards need an app identity.** With `IMESSAGE_TEAM_ID` /
  `IMESSAGE_BUNDLE_ID` unset, the card goes out as a plain image plus a link and
  cannot be redrawn in place. A *wrong* identity renders as plain text with no
  error. Ask Linq whether their `experience` cards remove the need for your own
  extension.
- **Everyone in the chat needs iMessage**, and on a shared Linq line each person
  must text the number first (inbound-first).
- `src/server/tools/places.ts` returns stub venues — wire a real provider.
- `vite.config.ts` needs the `agents()` plugin, or `@callable()` is a syntax
  error at Worker startup.
