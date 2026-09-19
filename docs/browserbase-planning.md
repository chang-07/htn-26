# Browserbase planning specialist

`src/server/browserbase/agent.ts` owns skill selection and execution in a separate model context. The chat agent sees research findings and the existing booking tools; it never receives the catalog instructions or a generic CLI/payment tool.

The ten requested skills were installed with `browse skills add <id>` on 2026-09-19, then moved from the CLI's general-agent installation directory into `src/server/browserbase/skills/`. These are original catalog snapshots, bundled as text by Vite. `catalog.ts` holds small routing descriptions; `instructions.ts` is the private instruction loader. Review a skill update before replacing its snapshot; runtime does not download changing instructions or execute shell snippets.

## When it runs

Research first checks whether the brief has a plausible specialist use. A Browserbase-specific model then chooses at most one skill or declines. A matching keyword alone is insufficient: ordinary brainstorming, generic dinner recommendations and incomplete travel requests should decline. The normal Search → relevance/confidence scoring → Fetch pipeline still decides which sources qualify. A skill only runs against a selected source on its matching domain, at most one source for quick research or two for deep research.

| Skill | Use and execution |
| --- | --- |
| [Ticketmaster](https://browse.sh/skills/ticketmaster.com/find-ticket-i7c0vy) | Artist/team/show events; skill-guided public GET endpoints through Browserbase Fetch with proxies |
| [Airbnb](https://browse.sh/skills/airbnb.com/search-listings-ddgioa) | Stays with destination, dates and guests; browser search/filter controls |
| [AllTrails](https://browse.sh/skills/alltrails.com/search-trails-dsqvnx) | Trails with location and constraints; browser |
| [DoorDash](https://browse.sh/skills/doordash.com/extract-menu-5uzqvc) | Named restaurant menus; browser, no cart changes |
| [Facebook Marketplace](https://browse.sh/skills/facebook.com/search-marketplace-m9gyrc) | Explicit local/used goods; public browser results only, no seller messages |
| [OpenTable](https://browse.sh/skills/opentable.com/check-availability-f2fwrm) | Venue/date/time/party-size availability; also loaded automatically by the availability subagent for OpenTable URLs |
| [Skyscanner](https://browse.sh/skills/skyscanner.net/search-cheapest-flight-v8nvut) | One-way route/date searches; browser, no provider checkout |
| [Yelp](https://browse.sh/skills/yelp.com/find-menu-jhjk4o) | Named restaurant menu photos; browser plus screenshot vision |
| [Luma](https://browse.sh/skills/luma.com/discover-1zqc5a) | City/interest events; skill-guided public GET endpoints through Fetch, no browser or proxies |
| [Link](https://browse.sh/skills/link.com/create-payment-credential-0nc34a) | Installed but unavailable for runtime execution; see below |

API specialists have three GETs maximum, with domain/path allowlists. Browser specialists have ten pilot actions maximum and share one session across source tabs. Full instructions enter only the selected specialist's context. Browserbase verified/proxy settings follow the selected site's needs. Routing failures, blocked sites, missing sessions or unsupported methods fall back to ordinary page retrieval. If that also fails, the source is omitted; failures are never interpreted as sold-out inventory.

The Worker adapts catalog instructions to its existing browser pilot; it cannot execute arbitrary JavaScript, shell pipelines or embedded CLI commands. Workflows requiring those methods may need a handoff. Yelp requires an image-capable model; login walls, unavailable proxy entitlements and bot challenges can prevent extraction. The implementation is covered by mocked provider tests, not live validation of all nine sites.

## Booking, payments and responses

Availability reads and research cannot use the pilot's final-submit action. An additional control-label guard stops obvious purchases, RSVP, seller messaging, login and personal-information controls even if the model labels them as clicks. This is a best-effort UI guard, not a formal read-only sandbox. Booking stays in the existing no-retry workflow, with its existing dry-run and payment behavior. Read-only skill results never authorize a booking or payment.

The Link catalog skill requires `@stripe/link-cli` or its MCP server, a US Link wallet and human approval. It explicitly has no browser provisioning fallback. It is excluded from routing and execution; the current Linq payment setup/approval/cap flow remains the payment owner. Enabling Link would require a separate credential service with approval, idempotency and secret handling, not a browser prompt.

Responses should quote sourced options, preserve dates, location, currency/fees and relevant caveats, and distinguish discovery from confirmed availability or booking. Never expose skill IDs in chat. Research run events include `browserbase_selected`, `browserbase_skill` and `browserbase_fallback`; browser replays and normal evidence screenshots remain available.

## Places and weather

`find_locations` uses [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api), returning candidate place IDs, region, coordinates and time zone. The agent must choose the result consistent with the stated area or ask if ambiguous. This resolves named places; existing consent-based phone location sharing stays separate.

`get_weather` resolves the returned place ID and requests a [daily Open-Meteo forecast](https://open-meteo.com/en/docs) for the outing's local date. It returns Celsius, km/h, precipitation probability, WMO weather code, source, timestamp and provider units. Missing values remain null. Dates outside today through local day +15 return `outside_forecast_window`, never today's weather substituted for a future outing. Use it for outdoor/weather-sensitive plans or explicit weather questions, not every indoor dinner. Responses attribute Open-Meteo; location attribution includes GeoNames.

These endpoints require no key for the current non-commercial demo. Commercial deployment needs an appropriate Open-Meteo plan and customer endpoint configuration; this PR does not configure commercial service. Weather is a daily forecast, not an hourly guarantee or a trail-safety assessment.

## Validation

Run `npm test`, `npm run typecheck` and `npm run build`. Provider mocks cover optional routing, domain isolation, serialized workflow metadata, API endpoint restrictions, read-only skill ownership, failures, ambiguous geocoding, missing weather data and forecast horizon handling. To validate live, use a disposable demo chat and a read-only request with complete constraints; inspect source evidence and session replay. Do not use a purchase or credential-creation task as a smoke test.
