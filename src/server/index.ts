import { UCP_CAPABILITIES, UCP_VERSION } from "./tools/shopify";
import { getAgentByName, routeAgentRequest } from "agents";
import type {
  MessageReceivedWebhookEvent,
  ReactionAddedWebhookEvent,
} from "@linqapp/sdk/resources/webhooks";
import { linqClient } from "./linq";
import type { PlanAgent as PlanAgentClass } from "./agent";
import { openBrowser, readPage, searchWeb } from "./browser";
import { cartTicket, matchTicket, planTicket, renderCard, renderCartCard, renderTicket, rsvpTicket, venueTicket, type Ticket } from "./card";
import { errorFields, log, short } from "./log";
import { getRun, listChats, listRuns, requireRunsAuth } from "./runs";
import type { PlanState } from "../types";

export { PlanAgent } from "./agent";
export { BookingWorkflow } from "./booking";
export { ResearchWorkflow } from "./research";
export { RunHub } from "./runs";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/webhooks/linq" && request.method === "POST") {
      return handleLinqWebhook(request, env);
    }

    // Simulator: drive an agent without Linq. Never reachable once deployed.
    if (url.pathname.startsWith("/api/dev/") && isLocal(url)) {
      return handleDev(request, url, env);
    }

    // Run history. Unlike /api/dev/*, this is reachable from the deployed
    // Worker: the runs worth looking at are the ones driven by real texts.
    if (url.pathname === "/api/runs" || url.pathname.startsWith("/api/runs/")) {
      return requireRunsAuth(request, url, env) ?? handleRuns(url, env);
    }

    if (url.pathname.startsWith("/card/")) {
      return handleCard(url, env, ctx);
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
} satisfies ExportedHandler<Env>;

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
 *                          + "group": true, and "mention": true or "replyTo": "last", to test the wake gate
 *   POST /api/dev/react    {"chat":"demo","from":"+15550001111","reaction":"love"}
 *   GET  /api/dev/card?kind=plan|cart|venue|rsvp|match&state=open|done   card preview from sample data (plan also takes status, title, o, votes)
 *   POST /api/dev/tool     {"chat":"demo","tool":"propose_plan","args":{...}}   no LLM involved
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
    cart: {
      shop: "levainbakery.com",
      checkoutUrl: "https://example.com",
      total: "$128.00",
      lines: [
        { title: "Chocolate Chip Walnut - 4 PK", quantity: 3, price: "$32.00" },
        { title: "Signature Cookie Assortment - 4 PK", quantity: 1, price: "$32.00" },
      ],
    },
    version: 0,
  };
}

async function handleDev(request: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/dev/card") {
    const plan = samplePlan(url);
    const done = plan.status === "booked" || url.searchParams.get("state") === "done";
    const people = ["Maya", "Jordan", "Sam"];
    const tickets: Record<string, Ticket> = {
      plan: planTicket(plan),
      cart: cartTicket(plan.cart!, 4, done ? "Maya" : undefined),
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
    };
    const img = await renderTicket(tickets[url.searchParams.get("kind") ?? "plan"] ?? tickets.plan);
    return new Response(await img.arrayBuffer(), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }
  const body = request.method === "POST" ? ((await request.json()) as Record<string, string>) : {};
  const chat = body.chat ?? url.searchParams.get("chat") ?? "demo";
  const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, chat);

  if (url.pathname === "/api/dev/message") {
    // Defaults to a direct chat (always answered). Pass "group": true to test the
    // wake gate, with "mention": true or "replyTo": "last" | "<message id>".
    const opts = body as unknown as { group?: boolean; mention?: boolean; replyTo?: string };
    await agent.ingestMessage({
      linqId: crypto.randomUUID(),
      from: body.from,
      text: body.text,
      isGroup: opts.group === true,
      mentionsMe: opts.mention === true,
      replyToId: opts.replyTo === "last" ? await agent.lastOwnMessageId() : opts.replyTo,
    });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/react") {
    // Reacts to whatever the plan card's id currently is, real or dry.
    // {"on":"rsvp"} reacts to the open Who's in ticket instead.
    const messageId = (body.on === "rsvp" ? await agent.currentRsvpId() : await agent.currentCardId()) ?? "dry-plan";
    await agent.ingestReaction({ messageId, from: body.from, reactionType: body.reaction });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/tool") {
    const { tool, args } = body as unknown as { tool: string; args?: unknown };
    return Response.json({ result: await agent.devRunTool(tool, args) });
  }
  if (url.pathname === "/api/dev/fire") {
    // Run a scheduled callback now instead of waiting for its timer.
    const callbacks = { researchWatchdog: () => agent.researchWatchdog(), nudge: async () => agent.nudge({ ballot: await agent.currentBallot() }), runTurn: () => agent.runTurn() };
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
 *   GET /api/runs/<runId>                                one run and its events
 *
 * Live updates arrive separately, over the RunHub WebSocket that
 * routeAgentRequest serves at /agents/run-hub/global.
 */
async function handleRuns(url: URL, env: Env): Promise<Response> {
  const rest = url.pathname.slice("/api/runs".length).replace(/^\//, "");
  const q = url.searchParams;

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
  const name = decodeURIComponent(url.pathname.slice("/card/".length));
  const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, name);
  const plan = (await agent.state) as PlanState;

  // CARDS is optional: see the r2_buckets note in wrangler.jsonc.
  const bucket = (env as { CARDS?: R2Bucket }).CARDS;

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

  const cart = url.searchParams.get("kind") === "cart" ? plan.cart : undefined;
  const key = `${name}/${cart ? "cart-" : ""}${plan.version}.png`;
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
