# Plan: complete the outing inside the conversation

Keep the current product and its scope. Improve the full journey from a group request to verified bookings, purchases, and an actionable final itinerary. This is an implementation brief, not a claim that these changes are built.

## Product contract

- Remember information already supplied. Ask only for missing information that blocks the next useful action.
- Start independent research concurrently; let participants change constraints while it runs.
- Show progress as meaningful findings and task states, not token streams or browser click logs.
- Preserve confirmed purchases and reservations when the group changes its mind. Explain which changes require cancellation or a new transaction.
- Finish with confirmation evidence, actual costs, addresses, times, and anything still needing attention. A checkout link or attempted submit is not a completed purchase.
- Let people resume interrupted work without repeating the conversation.

## Two interaction surfaces

### 1. Choose together

A compact decision surface with two to four options, photos, available times, per-person estimates, and votes. Participants can select an option or flag a constraint. A natural-language correction such as “two more people” updates the same underlying plan.

Progressive results should distinguish “found”, “checking availability”, and “available as of <time>”. An attractive venue with no verified slot must not look bookable. Outdated options become visibly stale; actions are versioned so old cards cannot commit an obsolete plan.

### 2. Get it done

After selection, show each requested outcome: reservation, activity tickets, supplies, and transport where supported. Each row has an actual state, price where known, and its next action. Examples: checking, ready, needs your input, submitting, confirmed, failed, or outcome unknown.

An expanded view can show browser progress, request missing information, and resume work. Payment and account details belong to the relevant person's private flow. The group sees completion and responsibility, not sensitive details. Confirmations remain available after the browser closes.

Use ordinary messages for short explanations, replies for object-specific changes, reactions for low-stakes votes and RSVPs, and explicit payment language/actions for spending. The existing thumbs-up/heart-to-pay behavior needs reconsideration: an ordinary positive reaction is too ambiguous unless the card clearly establishes its financial meaning.

## Native Messages feasibility

Verified against Linq documentation on 2026-09-19:

- `imessage_app` sends a card backed by an installed Messages extension. Its API-supplied layout is static; it does not turn arbitrary HTML into an interactive message bubble.
- Linq-hosted experiences currently document payment requests, card attachment, card approval, and links. Query `GET /v3/experiences` for the account's actual supported contract before implementing.
- Arbitrary custom decision and execution widgets require a supported Linq extension mechanism or our own installed Messages extension. Verify the Agent Apps custom-development path with Linq before committing to its rendering model.
- Do not assume existing bubbles can stream arbitrary updates. Validate refresh, interaction callbacks, participant identity, installation requirements, and group support on two real phones.
- The React `/w/` view and ticket images already exist as fallbacks, but do not count a browser page as delivery of the native-widget requirement.

Sources:
- https://docs.linqapp.com/channel/imessage/guides/messaging/imessage-apps/
- https://docs.linqapp.com/channel/imessage/guides/messaging/experiences/

## Browser capabilities

Build a registry of reusable, tested operations rather than adding disconnected integrations. Start from the existing Browserbase transport and Puppeteer pilot.

Each operation declares its inputs, supported sites, authentication needs, read/write behavior, time and step budgets, progress events, success evidence, and recovery path. Separate read-only searches from bookings and purchases.

Priority coverage:

1. Venue research, menus, dietary constraints, and live availability.
2. Reservation submission and confirmation retrieval on explicitly tested booking providers.
3. Activity inventory and ticket selection, then supported checkout.
4. Shopify search, carts, shipping/tax pricing, payment, and confirmation.
5. Uber browser quoting, followed by booking only after authentication and transaction handling are proven. Lyft remains unverified.
6. Additional merchants, including Amazon, as individually tested adapters; no blanket claim of universal checkout.

Keep existing valid paths working while adding provider-specific actions and a generic browser fallback. Check Workers runtime compatibility before introducing Node/Python browser libraries; use a separate runner if needed.

## Jev's role

Jev's primary role is the research filter: Browserbase Search → Jev relevance and confidence scoring → Browserbase Fetch for passing results → extraction and synthesis. This path is implemented in `research.ts` and `research-sources.ts`, activated by `TYPESAFE_API_KEY`. The older LLM selector remains an explicit fallback without that key.

- The reasoning model interprets the request, produces necessary text, and resolves ambiguity.
- Jev rates search metadata for likely usefulness before spending on page retrieval. Relevance and confidence are separate; confidence in a bad match never admits it to Fetch.
- Deterministic code validates targets, executes actions, enforces authorization, and checks evidence.
- Neither a high score nor a model's “done” decision proves a booking succeeded.

Evaluate fetch yield, relevant-source recall, latency, cost, and rejection rates on representative queries. Defaults (relevance >= 2/3 and confidence >= 0.5) need tuning; metadata scores do not prove page facts. Failed scoring cannot silently bypass filtering. Browser-action selection with Jev remains a separate future experiment, not the initial integration.

References:
- https://docs.typesafe.ai/primitives/score
- https://docs.typesafe.ai/confidence
- https://docs.browserbase.com/reference/api/web-search
- https://docs.browserbase.com/reference/api/fetch-a-page
- https://github.com/browser-use/jev-ultrafast
- https://github.com/jkudish/jev-browser

## Execution correctness

- One authoritative plan state; task results carry the plan revision they used.
- Cancel or discard obsolete research after constraint changes; revalidate availability and prices before committing.
- Deduplicate inbound events and transaction attempts. After an uncertain submit, reconcile before retrying to avoid duplicate purchases or bookings.
- Persist progress and resume after restarts. Keep explicit states for pending user input and uncertain transaction outcomes.
- Isolate authentication by person and provider. The existing shared context for profile research is not a general customer-account store.
- Bound browser concurrency to actual account capacity. Close and release sessions on success, error, cancellation, and timeout.
- Keep browser replays and debugging information available to developers without exposing customer credentials through shared live views.

## Build order and acceptance

1. Prove the native custom-widget path and callbacks on two real iPhones. This determines the interaction implementation.
2. Trace one full existing outing flow; fix every stalled or ambiguous transition. Include research, a group choice, booking, a cart, and final evidence. Use sandbox/dry-run transactions during development and label them honestly.
3. Implement the two surfaces on the same versioned state, including streamed progress and interruptions.
4. Add and verify browser operations one provider at a time.
5. Validate Jev's search filtering on real queries and tune the relevance/confidence thresholds before considering browser-action routing.
6. Rehearse on the real group-chat transport, including a changed headcount, unavailable slot, duplicate webhook, expired session, missing detail, and uncertain submit.

The final acceptance run must show the group making a decision, correcting a constraint during work, and receiving verified outcomes. A simulation cannot establish live payment or booking reliability; the existing `docs/TEST-PLAN.md` and README explicitly identify unproven areas.
