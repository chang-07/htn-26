import { getAgentByName, routeAgentRequest } from "agents";
import type {
  MessageReceivedWebhookEvent,
  ReactionAddedWebhookEvent,
} from "@linqapp/sdk/resources/webhooks";
import { linqClient } from "./linq";
import type { PlanAgent as PlanAgentClass } from "./agent";
import { renderCard } from "./card";
import type { PlanState } from "../types";

export { PlanAgent } from "./agent";
export { BookingWorkflow } from "./booking";

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

    if (url.pathname.startsWith("/card/")) {
      return handleCard(url, env, ctx);
    }

    // Shopify fetches this to validate every UCP call the agent makes.
    if (url.pathname === "/.well-known/ucp-agent.json") {
      return Response.json({
        ucp: { version: "2026-08-25", services: {}, capabilities: {}, payment_handlers: {} },
        keys: [],
      });
    }

    // WebSocket + RPC traffic from useAgent() on the vote page.
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
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
    console.error("[linq] signature verification failed", err);
    return new Response("invalid signature", { status: 400 });
  }

  try {
    switch (event.event_type) {
      case "message.received": {
        const msg = (event as MessageReceivedWebhookEvent).data;
        if (msg.sender_handle.is_me) break;
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => p.value)
          .join("\n");
        if (!text) break;
        const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, msg.chat.id);
        await agent.ingestMessage({ linqId: msg.id, from: msg.sender_handle.handle, text });
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
    console.error("[linq] handler error", err);
  }

  return Response.json({ ok: true });
}

const isLocal = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

/**
 *   POST /api/dev/message  {"chat":"demo","from":"+15550001111","text":"..."}
 *   POST /api/dev/react    {"chat":"demo","from":"+15550001111","reaction":"love"}
 *   GET  /api/dev/dump?chat=demo
 */
async function handleDev(request: Request, url: URL, env: Env): Promise<Response> {
  const body = request.method === "POST" ? ((await request.json()) as Record<string, string>) : {};
  const chat = body.chat ?? url.searchParams.get("chat") ?? "demo";
  const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, chat);

  if (url.pathname === "/api/dev/message") {
    await agent.ingestMessage({ linqId: crypto.randomUUID(), from: body.from, text: body.text });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/react") {
    await agent.ingestReaction({ messageId: "dry-card", from: body.from, reactionType: body.reaction });
    return Response.json({ ok: true });
  }
  if (url.pathname === "/api/dev/dump") {
    return Response.json(await agent.dump());
  }
  return new Response("Not found", { status: 404 });
}

/** Card PNGs are rendered once per plan version and then served from R2. */
async function handleCard(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const name = decodeURIComponent(url.pathname.slice("/card/".length));
  const agent = await getAgentByName<Env, PlanAgentClass>(env.PlanAgent, name);
  const plan = (await agent.state) as PlanState;

  const key = `${name}/${plan.version}.png`;
  const cached = await env.CARDS.get(key);
  if (cached) return new Response(cached.body, { headers: pngHeaders });

  const png = await renderCard(plan).arrayBuffer();
  ctx.waitUntil(env.CARDS.put(key, png));
  return new Response(png, { headers: pngHeaders });
}

const pngHeaders = {
  "content-type": "image/png",
  "cache-control": "public, max-age=31536000, immutable",
};
