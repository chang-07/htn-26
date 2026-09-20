# Website accounts and event data

The website uses the same agent plan, exposed through a shared event document. No MongoDB or new D1 database is needed. The new `Website` SQLite Durable Object holds account records, hashed sessions, event documents, group membership, and each account’s widgets/preferences. The `v4` migration in `wrangler.jsonc` provisions it on deployment.

## Event contract

`src/shared/events.ts` is the shared validated contract. An event has an ID, schema version, title, optional description/location/start/end/time zone, lifecycle status, people’s display names, and an array of items. Each item has a stable ID, arbitrary `kind`, title, status, optional time/provider/location/price, typed links, and JSON `details`.

Examples of details: a flight’s airline/number/baggage, food line items and dietary requirements, a ride’s pickup/vehicle/seats, or a game’s rules. Missing fields stay missing. Booking/checkout/tracking links retain their complete URL. Never store payment credentials, authentication codes, full chat transcripts, or private contact details in this public plan representation.

`save_event` updates the current group event. `update_event_item` adds known timing/location to existing items. Legacy itineraries, ballots, and carts are adapted automatically; a tracked flight or a cart marked paid is not represented as a confirmed booking. The existing agent still has **one active event per chat**; this change does not introduce an event-switching or history-management workflow.

Each publish saves the event on `PlanAgent` and syncs it to `Website`. Retries repair failed index writes; revision checks prevent delayed updates replacing newer state. Old plans are indexed when an agent wakes. The first successful website login also starts a paginated Durable Object alarm job to backfill chat IDs recorded in the existing `RUNS_DB` run history. Chats absent from that history are indexed on their next agent activity.

## Accounts and access

Visit `/dashboard`, enter an E.164 phone number, and verify the six-digit code delivered through Linq. New accounts are created after verification. Codes expire after ten minutes, allow five attempts, and are rate-limited by phone and IP. Codes and session tokens are stored only as hashes. Production cookies use `__Host-`, `Secure`, `HttpOnly`, and `SameSite=Lax`; sessions expire after 30 days and logout revokes them. Mutating APIs require a matching Origin.

The dashboard loads `/api/events`; `/api/events/:id` also checks membership. Membership comes from active phone handles in the Linq chat roster, never browser-supplied plan IDs or web voters. Every event sync reads the active Linq chat roster, so people who haven’t texted yet can see their plans and removed members lose dashboard access on the next successful sync. Historical participant records cannot grant access. During a Linq outage, new event data is not published to the dashboard; the prior snapshot remains available and sync retries. Roster versions prevent delayed syncs restoring removed members. Membership and event updates commit atomically.

Existing capability-based `/w/:chat`, native widget, and image routes remain shareable as before. Website accounts do not make those existing shared links private. Browser clients cannot directly replace agent state; existing explicit voting/game actions continue to work.

Workspace saves use revisions and verified account IDs to prevent overwrites from stale tabs or another account. Widget definitions, friend notes and account preferences are saved server-side; game play/poll interactions keep their existing behavior. Website preferences are workspace preferences, separate from the agent’s `People` profile. Old browser-local dashboard data is not automatically imported into an account.

## Run and deploy

1. Run `npm install` if dependencies are missing.
2. Configure `LINQ_API_KEY` and optionally `LINQ_FROM_NUMBER` in `.dev.vars` locally, or Worker secrets in production. `LINQ_FROM_NUMBER` defaults to the account’s first line. There is deliberately no production debug-code bypass.
3. Run `npm run dev` and open `/dashboard`. Requesting a code sends a real message through Linq.
4. Run `npm run typecheck`, `npm test`, and `npm run build` before deployment.
5. Deploy with the project’s normal `npm run deploy`. This applies the Website Durable Object binding/migration. The existing RUNS_DB tables must already be migrated for historical backfill.

Automated tests use a mock message sender and in-memory SQLite; they never send real sign-in messages or create bookings.
