export { Website } from "./website";
import { handleWebsite } from "./website-api";
import { Sentry, sentryOptions } from "./sentry";
import { UCP_CAPABILITIES, UCP_VERSION } from "./tools/shopify";
import { getAgentByName, routeAgentRequest } from "agents";
import type {
  MessageReceivedWebhookEvent,
  ReactionAddedWebhookEvent,
} from "@linqapp/sdk/resources/webhooks";
import { linqClient } from "./linq";
import type { PlanAgent as PlanAgentClass } from "./agent";
import { fillCheckout, hasCardForm, typeCard } from "./checkout";
import { openBrowser, readPage, searchWeb } from "./browser";
import { observe, runPilot } from "./pilot";
import { parseLinks, readInstagram, readLinks } from "./social";
import { renderAvatar, renderPlanIcon, cartTicket, invoiceTicket, itineraryTicket, matchTicket, planTicket, renderCard, renderCartCard, renderTicket, rsvpTicket, shoppingListTicket, venueTicket, type Ticket } from "./card";
import { planEmoji } from "../dressing";
import { errorFields, log, short } from "./log";
import { getRun, listChats, listRuns, refreshRunTimeouts, requireRunsAuth } from "./runs";
import { cartsOf, shopKey, type PlanState } from "../types";
import { invoiceFor } from "../invoice";
import { searchFlights } from "./sources/flights";
import { searchStays } from "./sources/stays";
import { findEvents } from "./sources/events";
import { flightStatus } from "./sources/flight-status";
import { orderStatus } from "./sources/order-status";
import type { FlightStatus } from "./sources/types";

import { PlanAgent as PlanAgentBase } from "./agent";
export type PlanAgent = PlanAgentBase;
export const PlanAgent: typeof PlanAgentBase = Sentry.instrumentAgentWithSentry(sentryOptions, PlanAgentBase);
import { BookingWorkflow as BookingWorkflowBase } from "./booking";
export type BookingWorkflow = BookingWorkflowBase;
export const BookingWorkflow: typeof BookingWorkflowBase = Sentry.instrumentWorkflowWithSentry(sentryOptions, BookingWorkflowBase);
import { ResearchWorkflow as ResearchWorkflowBase } from "./research";
export type ResearchWorkflow = ResearchWorkflowBase;
export const ResearchWorkflow: typeof ResearchWorkflowBase = Sentry.instrumentWorkflowWithSentry(sentryOptions, ResearchWorkflowBase);
import { RunHub as RunHubBase } from "./runs";
export type RunHub = RunHubBase;
export const RunHub: typeof RunHubBase = Sentry.instrumentAgentWithSentry(sentryOptions, RunHubBase);
import { People as PeopleBase } from "./people";
export type People = PeopleBase;
export const People: typeof PeopleBase = Sentry.instrumentDurableObjectWithSentry(sentryOptions, PeopleBase);
import { handleProfile } from "./profile";
import { handleDemo } from "./demos";

export default Sentry.withSentry(sentryOptions, {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/account/") || url.pathname.startsWith("/api/events")) return handleWebsite(request, env);

    if (url.pathname === "/api/webhooks/linq" && request.method === "POST") {
      return handleLinqWebhook(request, env);
    }

    if (url.pathname.startsWith("/api/plan-media/")) {
      const match = url.pathname.match(/^\/api\/plan-media\/([^/]+)\/([a-f0-9]{64})$/);
      if (!match || !["GET", "HEAD"].includes(request.method)) return new Response("Not found", { status: 404 });
      const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, decodeURIComponent(match[1]));
      const file = await agent.getPlanMedia(match[2]);
      if (!file) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : Uint8Array.from(atob(file.data), c => c.charCodeAt(0)), {
        headers: { "content-type": file.type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
      });
    }

    // Simulator: drive an agent without Linq. Never reachable once deployed.
    if (url.pathname.startsWith("/api/dev/") && isLocal(url)) {
      return handleDev(request, url, env);
    }

    // Run history. Unlike /api/dev/*, this is reachable from the deployed
    // Worker: the runs worth looking at are the ones driven by real texts.
    if (url.pathname === "/api/runs" || url.pathname.startsWith("/api/runs/")) {
      return requireRunsAuth(request, url, env) ?? handleRuns(request, url, env);
    }

    // The native iMessage widget: plain HTTP where the web page uses the
    // WebSocket. Public plan state only, and the unguessable chat id is the
    // capability, exactly as on /w/<chat>.
    if (url.pathname.startsWith("/api/widget/")) {
      const [chatEnc, action, extra, sub] = url.pathname.slice("/api/widget/".length).split("/");
      const chat = decodeURIComponent(chatEnc ?? "");
      if (!chat) return new Response("Not found", { status: 404 });
      const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, chat);
      // Games: create from a prompt, fetch the redacted view, act (join/answer/advance).
      if (action === "game") {
        if (!extra && request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as { prompt?: string; voter?: string; name?: string };
          if (!body.prompt || !body.voter) return new Response("prompt and voter are required", { status: 400 });
          try {
            const made = await agent.gameCreate(body.prompt, body.voter, body.name);
            return Response.json(made);
          } catch (err) {
            return new Response(err instanceof Error ? err.message : "generation failed", { status: 502 });
          }
        }
        if (extra && !sub && request.method === "GET") {
          const v = await agent.gameFetch(extra, url.searchParams.get("voter") ?? "");
          return v ? Response.json(v, { headers: { "cache-control": "no-store" } }) : new Response("Not found", { status: 404 });
        }
        if (extra && sub && request.method === "POST") {
          const body = (await request.json().catch(() => ({}))) as { voter?: string; name?: string; choice?: number };
          if (!body.voter) return new Response("voter is required", { status: 400 });
          const act =
            sub === "join" ? { type: "join" as const, name: body.name ?? "" }
            : sub === "answer" ? { type: "answer" as const, choice: Number(body.choice) }
            : sub === "advance" ? { type: "advance" as const }
            : null;
          if (!act) return new Response("Not found", { status: 404 });
          const v = await agent.gameAct(extra, body.voter, act);
          return v ? Response.json(v, { headers: { "cache-control": "no-store" } }) : new Response("Not found", { status: 404 });
        }
        return new Response("Not found", { status: 404 });
      }
      if (!action && request.method === "GET") {
        return Response.json(await agent.publicState(), { headers: { "cache-control": "no-store" } });
      }
      // A stored ticket's JSON, for the native ticket card. Tickets are
      // immutable once posted, so they cache hard.
      if (action === "ticket" && extra && request.method === "GET") {
        const ticket = await agent.getTicket(extra);
        return ticket
          ? Response.json(ticket, { headers: { "cache-control": "public, max-age=86400" } })
          : new Response("Not found", { status: 404 });
      }
      if (action === "vote" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as { optionId?: string; voter?: string };
        if (!body.optionId || !body.voter) return new Response("optionId and voter are required", { status: 400 });
        try {
          await agent.vote(body.optionId, String(body.voter).slice(0, 80));
        } catch (err) {
          return new Response(err instanceof Error ? err.message : "vote failed", { status: 400 });
        }
        return Response.json(await agent.publicState(), { headers: { "cache-control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/p/")) {
      return handleProfile(request, url, env);
    }

    // The contact photo (scripts/linq-contact-card.mjs points Linq at it).
    if (url.pathname === "/card/avatar.png") {
      const image = await renderAvatar(env.IMESSAGE_APP_NAME);
      return new Response(image.body, { headers: { ...pngHeaders, "cache-control": "public, max-age=300" } });
    }

    // Short link to the Browserbase live view of a booking in progress.
    if (url.pathname.startsWith("/live/")) {
      const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, decodeURIComponent(url.pathname.slice("/live/".length)));
      const live = await agent.liveUrl();
      return live ? Response.redirect(live, 302) : new Response("No booking is running right now.", { status: 404 });
    }

    // The pilot's final screenshot, sent to the chat as a photo.
    if (url.pathname.startsWith("/shot/")) {
      const [chat, file] = url.pathname.slice("/shot/".length).split("/");
      const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, decodeURIComponent(chat ?? ""));
      const jpeg = await agent.getShot((file ?? "").replace(/\.jpg$/, ""));
      if (!jpeg) return new Response("Not found", { status: 404 });
      return new Response(Uint8Array.from(atob(jpeg), (c) => c.charCodeAt(0)), {
        headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" },
      });
    }

    if (url.pathname.startsWith("/card/")) {
      return handleCard(url, env, ctx);
    }

    // The Linq showcase suite: six demo apps a card can open into.
    if (url.pathname === "/demo" || url.pathname.startsWith("/demo/")) {
      return handleDemo(url);
    }

    // Shopify fetches this to validate every UCP call the agent makes.
    if (url.pathname === "/.well-known/ucp-agent.json") {
      // Shopify rejects the profile ("Invalid cache control") without a public max-age.
      return Response.json(
        { ucp: { version: UCP_VERSION, services: {}, capabilities: UCP_CAPABILITIES, payment_handlers: {} }, keys: [] },
        { headers: { "cache-control": "public, max-age=3600" } },
      );
    }

    // WebSocket + RPC traffic from useAgent() on the vote page.
    return (
      (await routeAgentRequest(request, env, {
        // The run viewer's live feed is the same data as /api/runs, so it takes
        // the same token. Chat agents (the vote page) stay open by design: their
        // unguessable chat id is the capability.
        onBeforeConnect: (req, route) =>
          route.className === "RunHub" ? (requireRunsAuth(req, new URL(req.url), env) ?? undefined) : undefined,
      })) ?? new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>);

/**
 * Verify, hand the event to the chat's agent, return 200. The agent defers the
 * slow part to its scheduler, so Linq never waits on an LLM call — it retries
 * non-2xx responses, and a retried booking is a double booking.
 */
async function handleLinqWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();

  let event;
  try {
    event = linqClient(env).webhooks.unwrap(body, {
      headers: Object.fromEntries(request.headers),
      key: env.LINQ_WEBHOOK_SECRET,
    });
  } catch (err) {
    log("warn", "linq", "webhook.rejected", errorFields(err));
    return new Response("invalid signature", { status: 400 });
  }

  const chatId =
    (event.data as { chat?: { id?: string }; chat_id?: string }).chat?.id ??
    (event.data as { chat_id?: string }).chat_id;
  log("info", "linq", "webhook.received", { type: event.event_type, chat: short(chatId) });

  try {
    switch (event.event_type) {
      case "message.received": {
        const msg = (event as MessageReceivedWebhookEvent).data;
        if (msg.sender_handle.is_me) break;
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => p.value)
          .join("\n");
        if (!text) {
          log("info", "linq", "webhook.skipped", { reason: "no text part", parts: msg.parts.map((p) => p.type) });
          break;
        }
        const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, msg.chat.id);
        await agent.ingestMessage({
          linqId: msg.id,
          from: msg.sender_handle.handle,
          text,
          isGroup: msg.chat.is_group ?? undefined,
          mentionsMe: msg.parts.some((p) => p.type === "text" && (p.mentions ?? []).some((m) => m.is_me)),
          replyToId: msg.reply_to?.message_id,
        });
        break;
      }

      case "reaction.added": {
        const r = (event as ReactionAddedWebhookEvent).data;
        if (r.is_from_me || !r.chat_id || !r.message_id) break;
        const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, r.chat_id);
        await agent.ingestReaction({
          messageId: r.message_id,
          from: r.from_handle?.handle ?? r.from ?? "unknown",
          reactionType: r.reaction_type,
        });
        break;
      }

      case "location.sharing.started": {
        // No coordinates arrive here — only that sharing began. The agent reads
        // the city itself, and only if it was the one that asked.
        const loc = (event as { data: { chat_id: string | null; shared_by: string } }).data;
        if (!loc.chat_id) break; // shared from Find My rather than the conversation: not readable
        const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, loc.chat_id);
        await agent.locationShared(loc.shared_by);
        break;
      }
    }
  } catch (err) {
    // A handler bug must not put Linq into a retry loop.
    log("error", "linq", "webhook.handler_failed", { type: event.event_type, ...errorFields(err) });
  }

  return Response.json({ ok: true });
}

const isLocal = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

/**
 *   POST /api/dev/message  {"chat":"demo","from":"+15550001111","text":"..."}
 *                          + "group": true, and "mention": true or "replyTo": "last" | "photo", to test the wake gate
 *   POST /api/dev/react    {"chat":"demo","from":"+15550001111","reaction":"love"}   add "on":"photo" for the plan ticket photo, "rsvp", or "cart"+"shop"
 *   POST /api/dev/location {"chat":"demo","from":"+15550001111","locality":"Toronto"}   accept a location request
 *   GET  /api/dev/card?kind=plan|cart|list|venue|rsvp|match|invoice|itinerary&state=open|done   card preview from sample data (plan also takes status, title, o, votes; list also takes state=partial)
 *   GET  /api/dev/card?kind=icon&emoji=🍜&venue=...   the group icon a booked plan sets
 *   POST /api/dev/tool     {"chat":"demo","tool":"propose_plan","args":{...}}   no LLM involved
 *   POST /api/dev/booked   {"chat":"demo","optionId"?:"…","confirmation"?:"…"}   land a confirmed booking without a browser
 *   GET  /api/dev/source?kind=flights|stays|events|flight|order&…   run one browse.sh recipe, no model
 *   POST /api/dev/watch     {"chat":"demo"}                          run the flight/order watch check now
 *   POST /api/dev/seedorder {"chat":"demo","shop":"…","url":"…"}     an order item to watch, without buying
 *   POST /api/dev/shipped   {"chat":"demo","itemId":"…","carrier":"…","tracking":"…","trackingUrl":"…","eta":"…"}   the store shipped
 *   POST /api/dev/flight    {"chat":"demo","itemId":"…","status":{…}}   FlightAware now says this
 *   POST /api/dev/seedflight {"chat":"demo","itemId":"…","ident":"AC123"}   watch an item as a flight without reading FlightAware
 *   POST /api/dev/fire     {"chat":"demo","callback":"researchWatchdog"}        run a scheduled callback now
 *   GET  /api/dev/dump?chat=demo
 *   GET  /api/dev/logs?chat=demo     the chat's event history, as text
 *   POST /api/dev/research {"chat":"demo","brief":"...","near":"...","depth":"quick"}   start a run without the model
 *   GET  /api/dev/browse?url=...|q=...   open a browser session; read one page or run one search
 */
/** Sample plans for /api/dev/card, so the design can be judged without a chat. */
function samplePlan(url: URL): PlanState {
  const q = url.searchParams;
  const titles = q.getAll("o").length ? q.getAll("o") : ["Death Valley's Little Brother", "Graffiti Market", "Beertown Public House"];
  const options = titles.map((title, i) => ({ id: String(i), title, subtitle: i === 0 ? "Fri Sept 25 · 8:00 PM" : undefined }));
  const status = (q.get("status") ?? "voting") as PlanState["status"];
  const votes = (q.get("votes") ?? "2,1,0").split(",").map(Number);
  return {
    title: q.get("title") ?? "Friday dinner",
    status,
    options,
    counts: Object.fromEntries(options.map((o, i) => [o.id, votes[i] ?? 0])),
    chosenOptionId: status === "booked" || status === "booking" ? "0" : undefined,
    awaiting: [],
    bookingNote: status === "booked" ? (q.get("note") ?? "Table for 6 · conf #R7K2") : undefined,
    // A birthday shops in three places; ?state=partial marks the first one paid.
    carts: [
      {
        shop: "levainbakery.com",
        checkoutUrl: "https://example.com",
        total: "$128.00",
        lines: [
          { title: "Chocolate Chip Walnut - 4 PK", quantity: 3, price: "$32.00" },
          { title: "Signature Cookie Assortment - 4 PK", quantity: 1, price: "$32.00" },
        ],
      },
      {
        shop: "partycity.com",
        checkoutUrl: "https://example.com",
        total: "$41.50",
        lines: [
          { title: "Gold Number Balloon", quantity: 2, price: "$12.00" },
          { title: "Happy Birthday Banner", quantity: 1, price: "$17.50" },
        ],
      },
      {
        shop: "explodingkittens.com",
        checkoutUrl: "https://example.com",
        total: "$24.99",
        lines: [{ title: "Exploding Kittens: Party Pack", quantity: 1, price: "$24.99" }],
      },
    ],
    version: 0,
  };
}

async function handleDev(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/dev/card") {
    const plan = samplePlan(url);
    const done = plan.status === "booked" || url.searchParams.get("state") === "done";
    // kind=icon is the group icon, not a ticket: ?emoji=🎳&venue=… to try one.
    if (url.searchParams.get("kind") === "icon") {
      const img = await renderPlanIcon(planEmoji({ emoji: url.searchParams.get("emoji") ?? "🍜" }), url.searchParams.get("venue") ?? "Kinton Ramen");
      return new Response(await img.arrayBuffer(), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
    }
    const people = ["Maya", "Jordan", "Sam"];
    const tickets: Record<string, Ticket> = {
      plan: planTicket(plan),
      cart: cartTicket(plan.carts![0], 4, done ? "Maya" : undefined),
      // state=open: nothing paid · partial: one store paid · done: all paid
      list: shoppingListTicket(
        plan.carts!.map((c, i) => ({
          ...c,
          paidBy: done ? ["Maya", "Sam", "Jordan"][i] : url.searchParams.get("state") === "partial" && i === 0 ? "Maya" : undefined,
        })),
        4,
      ),
      venue: venueTicket(
        { name: "Kinton Ramen", kind: "Ramen", price: "$$", why: "Loud, fast, good for six", address: "51 Baldwin St", caveat: "No reservations after 8" },
        0,
        2,
      ),
      rsvp: rsvpTicket(
        done
          ? { title: "Who's in?", when: "Fri 8:00 PM", going: [...people, "Alex", "Dev"], out: ["Priya"], waiting: [], locked: true }
          : { title: "Who's in?", when: "Fri 8:00 PM", going: people, out: ["Priya"], waiting: ["Alex", "Dev"], locked: false },
      ),
      match: matchTicket("Maya", "Jordan", [
        { emoji: "🧗", text: "Bouldering, both V4-ish" },
        { emoji: "🍜", text: "Will travel for ramen" },
        { emoji: "🎞", text: "Shoot film cameras" },
      ]),
      // state=open: the last store still unpaid · done: everything bought, Maya owed by the rest
      invoice: invoiceTicket(
        invoiceFor(
          plan.carts!.map((c, i) => ({ ...c, paidBy: i === 0 ? "Maya" : i === 1 ? "Sam" : done ? "Jordan" : undefined })),
          [{ id: "e1", who: "Maya", amount: "$86.40", what: "dinner" }],
          [...people, "Alex"],
        ),
      ),
      // state=open: a flight to book and an order on its way · done: everything landed
      itinerary: itineraryTicket(
        [
          { id: "i1", kind: "flight", title: "Flair YYZ→YVR Oct 10", status: done ? "done" : "confirmed", note: "F8 227", lastUpdate: done ? "landed 4:01 PM" : undefined },
          { id: "i2", kind: "stay", title: "JW Marriott Parq", status: done ? "confirmed" : "handoff", price: "$277/night" },
          { id: "i3", kind: "event", title: "Raptors vs Spurs Dec 17", status: "confirmed" },
          { id: "i4", kind: "order", title: "partycity.com", status: done ? "done" : "watching", lastUpdate: done ? "delivered" : "shipped, arriving Tue" },
        ],
        "Vancouver weekend",
      ),
    };
    const kind = url.searchParams.get("kind") ?? "plan";
    if (!(kind in tickets)) return new Response(`kind must be one of ${Object.keys(tickets).join(", ")}`, { status: 404 });
    const img = await renderTicket(tickets[kind]);
    return new Response(await img.arrayBuffer(), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }
  const body = request.method === "POST" ? ((await request.json()) as Record<string, string>) : {};
  const chat = body.chat ?? url.searchParams.get("chat") ?? "demo";
  const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, chat);

  if (url.pathname === "/api/dev/location") {
    // Stands in for the person accepting the share prompt on their phone:
    //   {"chat":"demo","from":"+15550001111","locality":"Toronto","region":"ON, Canada"}
    const took = await agent.devShareLocation(body.from, body.locality ?? "Toronto", body.region);
    return Response.json({ took });
  }
  if (url.pathname === "/api/dev/message") {
    // Defaults to a direct chat (always answered). Pass "group": true to test the
    // wake gate, with "mention": true or "replyTo": "last" | "photo" | "<message id>".
    const opts = body as unknown as { group?: boolean; mention?: boolean; replyTo?: string };
    await agent.ingestMessage({
      linqId: crypto.randomUUID(),
      from: body.from,
      text: body.text,
      isGroup: opts.group === true,
      mentionsMe: opts.mention === true,
      replyToId: opts.replyTo === "last" ? await agent.lastOwnMessageId() : opts.replyTo === "photo" ? await agent.currentPlanPhotoId() : opts.replyTo,
    });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/react") {
    // Reacts to whatever the plan card's id currently is, real or dry.
    // {"on":"rsvp"} reacts to the open Who's in ticket instead.
    // {"on":"cart","shop":"…"} reacts to a cart instead: a thumbs up there means "I'll pay".
    // {"on":"photo"} reacts to the ballot's ticket photo rather than the card under it.
    const targets: Record<string, () => Promise<string | undefined>> = {
      card: () => agent.currentCardId(),
      photo: () => agent.currentPlanPhotoId(),
      rsvp: () => agent.currentRsvpId(),
      cart: () => agent.currentCartMessageId(body.shop),
    };
    const on = String(body.on ?? "card");
    const messageId = await (targets[on] ?? targets.card)();
    // The card has a dry stand-in; a photo that was never posted is a test bug, not a vote to ignore.
    if (!messageId && on === "photo") return Response.json({ error: "no ballot photo posted yet" }, { status: 404 });
    await agent.ingestReaction({ messageId: messageId ?? "dry-plan", from: body.from, reactionType: body.reaction });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/seedcart") {
    await agent.devSeedCart(String(body.shop), String(body.total ?? "$10.00"));
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/tool") {
    const { tool, args } = body as unknown as { tool: string; args?: unknown };
    return Response.json({ result: await agent.devRunTool(tool, args) });
  }
  if (url.pathname === "/api/dev/booked") {
    // Land a confirmed booking without a browser: {"chat":"demo","optionId"?:…,"confirmation"?:…}
    return Response.json(await agent.devBooked(body.optionId || undefined, body.confirmation || undefined));
  }
  if (url.pathname === "/api/dev/watch") {
    // Run the watch check now: {"chat":"demo"}
    await agent.checkWatches();
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/seedorder") {
    // An order item to watch without buying anything: {"chat":"demo","shop":"partycity.com","url":"https://…/orders/abc"}
    return Response.json(await agent.devSeedOrder(String(body.shop), String(body.url)));
  }
  if (url.pathname === "/api/dev/shipped") {
    // The store shipped: {"chat":"demo","itemId":"i1a2b","carrier":"Canada Post","tracking":"7023…","trackingUrl":"https://…","eta":"Tuesday","delivered":false}
    const b = body as unknown as { itemId: string; carrier?: string; tracking?: string; trackingUrl?: string; eta?: string; delivered?: boolean };
    return Response.json(await agent.devShipped(b.itemId, { fulfilled: true, delivered: b.delivered === true, carrier: b.carrier, tracking: b.tracking, trackingUrl: b.trackingUrl, eta: b.eta }));
  }
  if (url.pathname === "/api/dev/flight") {
    // FlightAware now says: {"chat":"demo","itemId":"i1a2b","status":{…a FlightStatus…}}
    const b = body as unknown as { itemId: string; status: FlightStatus };
    return Response.json(await agent.devFlightSnapshot(b.itemId, b.status));
  }
  if (url.pathname === "/api/dev/seedflight") {
    // Watch an itinerary item as a flight without reading FlightAware: {"chat":"demo","itemId":"…","ident":"AC123"}
    return Response.json(await agent.devSeedFlight(String(body.itemId), String(body.ident)));
  }
  if (url.pathname === "/api/dev/source") {
    // One source, no model: ?kind=flights&from=YYZ&to=YVR&depart=2026-10-10 | kind=stays&where=Vancouver&checkin=…&checkout=… | kind=events&city=Toronto&query=Raptors | kind=flight&ident=AC123 | kind=order&url=…
    const q = Object.fromEntries(url.searchParams) as Record<string, string>;
    const rows =
      q.kind === "flights" ? await searchFlights(env, { from: q.from, to: q.to, depart: q.depart, return: q.return || undefined, adults: q.adults ? Number(q.adults) : undefined })
      : q.kind === "stays" ? await searchStays(env, { where: q.where, checkin: q.checkin, checkout: q.checkout, adults: q.adults ? Number(q.adults) : undefined })
      : q.kind === "events" ? await findEvents(env, { city: q.city, query: q.query || undefined, country: q.country || undefined })
      : q.kind === "flight" ? await flightStatus(env, q.ident)
      : q.kind === "order" ? await orderStatus(env, q.url)
      : { error: "kind must be flights, stays, events, flight or order" };
    return Response.json(rows ?? null);
  }
  if (url.pathname === "/api/dev/fire") {
    // Run a scheduled callback now instead of waiting for its timer.
    const callbacks = { researchWatchdog: () => agent.researchWatchdog(), nudge: async () => agent.nudge({ ballot: await agent.currentBallot() }), runTurn: () => agent.runTurn(), checkWatches: () => agent.checkWatches() };
    const run = callbacks[body.callback as keyof typeof callbacks];
    if (!run) return Response.json({ error: `callback must be one of ${Object.keys(callbacks).join(", ")}` }, { status: 400 });
    await run();
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/dump") {
    return Response.json(await agent.dump());
  }
  if (url.pathname === "/api/dev/logs") {
    const rows = await agent.events(Number(url.searchParams.get("limit") ?? 100));
    const text = rows
      .map((r) => `${new Date(r.ts).toISOString().slice(11, 23)} ${r.level.padEnd(5)} ${r.event.padEnd(18)} ${r.fields}`)
      .join("\n");
    return new Response(text + "\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (url.pathname === "/api/dev/research") {
    const started = await agent.startResearch({
      brief: body.brief,
      near: body.near,
      when: body.when,
      depth: body.depth === "deep" ? "deep" : "quick",
    });
    return Response.json({ ok: true, started });
  }
  if (url.pathname === "/api/dev/checkout") {
    // Fill a real checkout with a made-up buyer and report the total. Stops
    // before the card form, always: nothing here can pay.
    //   /api/dev/checkout?url=https://store/cart/c/…&country=US&region=CA&postal=94043&city=Mountain+View&line1=1600+Amphitheatre+Pkwy
    const q = url.searchParams;
    const session = await openBrowser(env, { timeoutSeconds: 240 });
    try {
      const page = await session.browser.newPage();
      const steps: string[] = [];
      const priced = await fillCheckout(
        page,
        q.get("url") ?? "",
        { name: q.get("name") ?? "Test Person", email: "prefill.check@plan-agent.test", line1: q.get("line1") ?? "", city: q.get("city") ?? "", region: q.get("region") ?? "", postal: q.get("postal") ?? "", country: q.get("country") ?? "US" },
        (line) => steps.push(line),
      ).catch((err: unknown) => ({ error: String((err as Error).message ?? err) }));
      const cardForm = await hasCardForm(page);
      // ?card=test types Stripe's public test number into the card frames, to prove
      // they can be reached. Nothing presses Pay: this route has no code that could.
      let typed: string | undefined;
      if (cardForm && q.get("card") === "test") {
        typed = await typeCard(page, { number: "4242424242424242", expMonth: "12", expYear: "2030", cvc: "123" }, "Test Person").then(() => "ok", (err: unknown) => String((err as Error).message));
      }
      if (q.get("shot") === "1") return new Response((await page.screenshot({ type: "jpeg", quality: 60, fullPage: true })) as unknown as ArrayBuffer, { headers: { "content-type": "image/jpeg" } });
      return Response.json({ priced, cardForm, typed, steps, frames: page.frames().map((f) => f.name()).filter(Boolean) });
    } finally {
      await session.close();
    }
  }
  if (url.pathname === "/api/dev/pilot") {
    // Drive one site with the browser pilot, outside any chat or workflow:
    //   /api/dev/pilot?mode=availability&url=https://…&task=Find+times+for+4+on+Saturday+evening
    // Always a dry run here, so it can never confirm a booking.
    const session = await openBrowser(env, { timeoutSeconds: 360 });
    try {
      log("info", "pilot", "dev.start", { live: session.liveUrl ?? "(no live view)" });
      const page = await session.browser.newPage();

      // mode=inspect: what the pilot SEES on a page, plus the raw markup around a
      // keyword — for when it cannot find a control and guessing has run out.
      if (url.searchParams.get("mode") === "inspect") {
        await page.setViewport({ width: 1280, height: 900 });
        await page.goto(url.searchParams.get("url") ?? "https://example.com", { waitUntil: "domcontentloaded", timeout: 30_000 });
        await new Promise((r) => setTimeout(r, 3000));
        const seen = await observe(page);
        const find = url.searchParams.get("find") ?? "quantity";
        const markup = await page.evaluate((word) => {
          const re = new RegExp(word, "i");
          return Array.from(document.querySelectorAll<HTMLElement>("body *"))
            .filter((el) => el.children.length <= 6 && re.test(el.outerHTML.slice(0, 400)) && el.outerHTML.length < 1500)
            .slice(-4)
            .map((el) => el.outerHTML.replace(/\s+/g, " ").slice(0, 900));
        }, find);
        return Response.json({ elements: seen.elements, markup });
      }

      const result = await runPilot(
        env,
        page,
        {
          mode: url.searchParams.get("mode") === "book" ? "book" : "availability",
          task: url.searchParams.get("task") ?? "Find available times",
          startUrl: url.searchParams.get("url") ?? "https://example.com",
          dryRun: true,
          maxSteps: Number(url.searchParams.get("steps") ?? 14),
        },
        (n, line) => void log("info", "pilot", "step", { n, line }),
      );
      return Response.json({ provider: session.provider, sessionId: session.sessionId, liveUrl: session.liveUrl, ...result });
    } finally {
      await session.close();
    }
  }
  if (url.pathname === "/api/dev/shipto") {
    // Dev only: a person's private address-page link, which in real use only ever reaches them.
    //   /api/dev/shipto?handle=+15550004242&chat=<chat>
    const handle = url.searchParams.get("handle") ?? "";
    return Response.json({ url: `/p/${await env.People.get(env.People.idFromName("global")).tokenFor(handle)}/ship?chat=${encodeURIComponent(url.searchParams.get("chat") ?? "")}` });
  }
  if (url.pathname === "/api/dev/links") {
    // Try the link reader on its own:  /api/dev/links?l=@natgeo+on+instagram&l=letterboxd.com/someone
    const links = url.searchParams.getAll("l");
    const raw = url.searchParams.get("raw"); // ?raw=<handle>: the text pulled from one Instagram profile, unsummarised
    if (raw) {
      const session = await openBrowser(env, { timeoutSeconds: 120, signedIn: true });
      try {
        return Response.json(await readInstagram(session.browser, raw));
      } finally {
        await session.close();
      }
    }
    return Response.json({ parsed: parseLinks(links), ...(url.searchParams.get("parse") ? {} : await readLinks(env, links)) });
  }
  if (url.pathname === "/api/dev/browse") {
    const session = await openBrowser(env, { timeoutSeconds: 120 });
    try {
      const q = url.searchParams.get("q");
      if (q) return Response.json({ sessionId: session.sessionId, hits: await searchWeb(session.browser, q) });
      const page = await readPage(session.browser, url.searchParams.get("url") ?? "https://example.com");
      return Response.json({ provider: session.provider, sessionId: session.sessionId, ...page });
    } finally {
      await session.close();
    }
  }
  return new Response("Not found", { status: 404 });
}

/**
 *   GET /api/runs?chat=&outcome=&level=&before=&limit=   newest runs first
 *   GET /api/runs/chats                                  chats that have runs
 *   GET  /api/runs/<runId>                               one run and its events
 *   POST /api/runs/cart  {chat, shop, lines}             change a cart's quantities
 *
 * Live updates arrive separately, over the RunHub WebSocket that
 * routeAgentRequest serves at /agents/run-hub/global.
 */
async function handleRuns(request: Request, url: URL, env: Env): Promise<Response> {
  await refreshRunTimeouts(env);
  const rest = url.pathname.slice("/api/runs".length).replace(/^\//, "");
  const q = url.searchParams;

  // Editing a cart from the run viewer changes what the group sees: the store
  // cart is rewritten and the card in the thread is redrawn. Token-gated above.
  if (rest === "cart" && request.method === "POST") {
    const body = (await request.json()) as { chat?: string; shop?: string; lines?: { variantId: string; quantity: number }[] };
    if (!body.chat || !body.shop || !Array.isArray(body.lines)) return new Response("chat, shop and lines are required", { status: 400 });
    const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, body.chat);
    return Response.json(await agent.editCart(body.shop, body.lines));
  }

  if (!rest) {
    const runs = await listRuns(env, {
      chat: q.get("chat") ?? undefined,
      outcome: q.get("outcome") ?? undefined,
      level: q.get("level") ?? undefined,
      before: q.get("before") ? Number(q.get("before")) : undefined,
      limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    });
    // Cursor for the next page: the viewer passes it back as ?before=.
    return Response.json({ runs, before: runs.at(-1)?.started ?? null });
  }
  if (rest === "chats") return Response.json({ chats: await listChats(env) });

  const detail = await getRun(env, rest);
  return detail ? Response.json(detail) : new Response("no such run", { status: 404 });
}

/** Card PNGs are rendered once per plan version and then served from R2. */
async function handleCard(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname.slice("/card/".length);
  // /card/<chat>/icon.png is the group icon once the plan is booked.
  const icon = path.endsWith("/icon.png");
  const name = decodeURIComponent(icon ? path.slice(0, -"/icon.png".length) : path);
  const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, name);
  // A method, not the `state` property: the Sentry wrapper around the agent
  // class passes method calls through but answers undefined for a remote
  // property read, which took every card image down with a 500.
  const plan = (await agent.publicState()) as PlanState;

  // CARDS is optional: see the r2_buckets note in wrangler.jsonc.
  const bucket = (env as { CARDS?: R2Bucket }).CARDS;

  if (icon) {
    const key = `${name}/icon-${plan.version}.png`;
    const hit = await bucket?.get(key);
    if (hit) return new Response(hit.body, { headers: pngHeaders });
    const venue = plan.options.find((o) => o.id === plan.chosenOptionId)?.title ?? plan.title;
    const image = await (await renderPlanIcon(planEmoji(plan), venue)).arrayBuffer();
    if (bucket) ctx.waitUntil(bucket.put(key, image));
    return new Response(image, { headers: pngHeaders });
  }

  const ticketId = url.searchParams.get("t");
  if (ticketId) {
    // A stored ticket never changes, so its id is the whole cache key.
    const key = `${name}/t-${ticketId}.png`;
    const hit = await bucket?.get(key);
    if (hit) return new Response(hit.body, { headers: pngHeaders });
    const ticket = await agent.getTicket(ticketId);
    if (!ticket) return new Response("Not found", { status: 404 });
    const image = await (await renderTicket(ticket)).arrayBuffer();
    if (bucket) ctx.waitUntil(bucket.put(key, image));
    return new Response(image, { headers: pngHeaders });
  }

  // kind=cart&shop=… is one store's pay-card image; without shop, the first cart.
  const wanted = url.searchParams.get("shop");
  const carts = url.searchParams.get("kind") === "cart" ? cartsOf(plan) : [];
  const cart = carts.find((c) => wanted && shopKey(c.shop) === shopKey(wanted)) ?? carts[0];
  const key = `${name}/${cart ? `cart-${shopKey(cart.shop)}-` : ""}${plan.version}.png`;
  const cached = await bucket?.get(key);
  if (cached) return new Response(cached.body, { headers: pngHeaders });

  const png = await (await (cart ? renderCartCard(cart) : renderCard(plan))).arrayBuffer();
  if (bucket) ctx.waitUntil(bucket.put(key, png));
  return new Response(png, { headers: pngHeaders });
}

const pngHeaders = {
  "content-type": "image/png",
  "cache-control": "public, max-age=31536000, immutable",
};
