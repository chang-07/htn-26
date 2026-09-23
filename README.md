# Whim

https://whim.schangchang-li.workers.dev

An iMessage group-chat agent that helps friends make plans, vote on options,
book outings, build shopping carts, and play games. Built with Cloudflare
Workers, a stateful agent per chat, React, and a native iMessage extension.

## Quick start

Requires **Node 22.12+**, npm, and a Cloudflare account for remote bindings.

```sh
npm ci
cp .dev.vars.example .dev.vars
npx wrangler login
npm run runs:migrate
```

Configure a model in `.dev.vars`, then start the app:

- **OpenAI:** set `OPENAI_API_KEY`.
- **Claude CLI proxy:** set `DEV_LLM_BASE_URL=http://127.0.0.1:11435/v1`
  and `DEV_LLM_MODEL=haiku`, then run `npm run llm` in a second terminal.
- **Other providers:** set `DEV_LLM_BASE_URL`, `DEV_LLM_MODEL`, and
  `DEV_LLM_API_KEY` for an OpenAI-compatible endpoint.

```sh
npm run dev
```

Open [localhost:5173](http://localhost:5173). `/runs` shows agent activity;
`/w/demo` shows the demo chat's plan; `/dashboard` opens the account dashboard.

With no `LINQ_API_KEY`, messages are logged instead of delivered. Try a local
simulator chat:

```sh
curl -X POST localhost:5173/api/dev/message \
  -H 'content-type: application/json' \
  -d '{"chat":"demo","from":"+15550001111","text":"dinner friday? ramen downtown"}'

# plant a generated web game without a model; the id serves at /game-web/demo/<id>
curl -X POST localhost:5173/api/dev/seedwebgame -H 'content-type: application/json' \
  -d @scripts/fixtures/web-game.json
```

Leaving `DEV_LLM_*` blank falls back to OpenAI and uses credits. Research also
requires `AI_GATEWAY_API_KEY` for Jev; Browserbase is recommended for browsing.
See [`.dev.vars.example`](.dev.vars.example) for configuration.

## Development

| Command | Purpose |
|---|---|
| `npm test` | Unit tests |
| `npm run typecheck` | TypeScript checks |
| `npm run smoke` | Local server checks; start `npm run dev` first |
| `npm run test:games` | Game runtime and routing checks, without a model |
| `npm run eval:games` | Live game-generation evals; needs the server and model |
| `npm run build` | Production build |
| `npm run deploy` | Build and deploy with the OpenAI `demo` profile |

For a new Cloudflare account, provision the resources in
[`wrangler.jsonc`](wrangler.jsonc), apply the remote D1 migration, and configure
production secrets before deploying. Follow the
[Cloudflare setup guide](docs/development.md#cloudflare-setup-from-scratch).

## Project map

- `src/server/` — chat agent, research, bookings, games, cards, and APIs.
- `src/client/` — website, plan widgets, and run viewer.
- `src/shared/` — event contracts and telemetry helpers.
- `ios/` — native Messages extension, including game views and ticket artwork.
- `scripts/` — local tools, setup helpers, and checks.

Generated games use two supported surfaces: choice rounds and tap-to-dodge.
Jev routes prompts; the model produces validated definitions, and the server
runs the game. Unsupported or uncertain requests show a surface picker.

## More detail

- [Development and operations](docs/development.md) — providers, simulator,
  webhooks, research, payments, deployment, and troubleshooting.
- [iPhone setup](ios/README.md)
- [Browserbase planning](docs/browserbase-planning.md)
- [Website accounts and events](docs/website-accounts.md)
- [Card design](docs/card-design.md)
