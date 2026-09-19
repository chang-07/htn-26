import LinqAPIV3 from "@linqapp/sdk";
import { SLOT_EMOJI, type PlanState } from "../types";
import { log, short } from "./log";

export function linqClient(env: Env) {
  return new LinqAPIV3({ apiKey: env.LINQ_API_KEY });
}

export function cardImageUrl(env: Env, agentName: string, version: number) {
  // `v` busts the image cache; without it the bubble can show a stale render.
  return `${env.PUBLIC_BASE_URL}/card/${encodeURIComponent(agentName)}?v=${version}`;
}

export type CardKind = "plan" | "cart";

export function cartImageUrl(env: Env, agentName: string, version: number) {
  return `${cardImageUrl(env, agentName, version)}&kind=cart`;
}

export function widgetUrl(env: Env, agentName: string) {
  return `${env.PUBLIC_BASE_URL}/w/${encodeURIComponent(agentName)}`;
}

/** True when a Messages extension identity is configured. */
export function hasAppIdentity(env: Env) {
  return Boolean(env.IMESSAGE_TEAM_ID && env.IMESSAGE_BUNDLE_ID);
}

function statusLabel(plan: PlanState, participantCount: number) {
  const votes = Object.values(plan.counts).reduce((a, b) => a + b, 0);
  switch (plan.status) {
    case "voting":
      // Web voters are not chat participants, so votes can outnumber them.
      return `${votes}/${Math.max(participantCount, votes)} voted`;
    case "booking":
      return "Booking…";
    case "booked":
      return "Booked";
    case "failed":
      return "Booking failed";
    default:
      return "";
  }
}

/**
 * The `imessage_app` part. `app` must name a Messages extension installed on
 * the recipient's device: without it they see the static layout, and a *wrong*
 * identity degrades to plain text with no error raised.
 */
export function appCardPart(
  env: Env,
  agentName: string,
  plan: PlanState,
  participantCount: number,
) {
  const winner = plan.options.find((o) => o.id === plan.chosenOptionId);
  return {
    type: "imessage_app" as const,
    app: {
      name: env.IMESSAGE_APP_NAME,
      team_id: env.IMESSAGE_TEAM_ID,
      bundle_id: env.IMESSAGE_BUNDLE_ID,
    },
    url: widgetUrl(env, agentName),
    fallback_text: `${plan.title} — ${statusLabel(plan, participantCount)}`,
    layout: {
      caption: plan.title,
      subcaption: winner ? winner.title : `${plan.options.length} options`,
      trailing_caption: statusLabel(plan, participantCount),
      image_url: cardImageUrl(env, agentName, plan.version),
    },
  };
}

/** The cart as an app card. Tapping goes straight to the store's checkout. */
export function cartCardPart(env: Env, agentName: string, plan: PlanState) {
  const cart = plan.cart!;
  const items = cart.lines.reduce((n, l) => n + l.quantity, 0);
  return {
    ...appCardPart(env, agentName, plan, 0),
    url: cart.checkoutUrl,
    fallback_text: `Cart at ${cart.shop} — ${cart.total}\n${cart.checkoutUrl}`,
    layout: {
      caption: `Cart · ${cart.shop}`,
      subcaption: `${items} item${items === 1 ? "" : "s"}`,
      trailing_caption: cart.total,
      image_url: cartImageUrl(env, agentName, plan.version),
    },
  };
}

export function tapbackLegend(plan: PlanState) {
  return plan.options.map((o, i) => `${SLOT_EMOJI[i]} ${o.title}`).join("\n");
}

/**
 * With no LINQ_API_KEY the transport is dry: sends are logged, not delivered.
 * Paired with the localhost-only /api/dev routes, that lets the whole agent
 * loop run on a laptop without a Linq number or a phone.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Real Linq chat ids are UUIDs. Anything else is a simulator chat ("demo",
 * "t1"), which must stay dry even when a live API key is configured.
 */
const isDry = (env: Env, chatId: string) => !env.LINQ_API_KEY || !UUID.test(chatId);

export async function sendText(env: Env, chatId: string, value: string) {
  if (isDry(env, chatId)) return void log("info", "linq", "dry.text", { chat: short(chatId), text: value });
  return linqClient(env).chats.messages.send(chatId, {
    message: { parts: [{ type: "text", value }] },
  });
}

/**
 * The ticket as an ordinary photo. Agent Apps draws the card bubble itself and
 * shows none of our image, so the photo is how the design reaches the thread.
 * A photo cannot be redrawn, so it is sent at moments, not on every change.
 */
export async function sendTicket(env: Env, chatId: string, agentName: string, plan: PlanState) {
  const url = cardImageUrl(env, agentName, plan.version);
  if (isDry(env, chatId)) return void log("info", "linq", "dry.ticket", { chat: short(chatId), image: url });
  return linqClient(env).chats.messages.send(chatId, { message: { parts: [{ type: "media", url }] } } as never);
}

type CardPart = ReturnType<typeof appCardPart>;

/**
 * Experiences are cards drawn by Linq's own iMessage extension, so they need no
 * app identity of ours. The plan is a `link` card; the cart tries `agentpay`
 * first (a native payment card) and falls back to `link`, because agentpay may
 * only accept checkout urls it issued itself.
 */
function experienceFor(part: CardPart, kind: CardKind, forceLink = false) {
  const { caption, subcaption, trailing_caption } = part.layout;
  const subtitle = [subcaption, trailing_caption].filter(Boolean).join(" · ").slice(0, 120);
  if (kind === "cart" && !forceLink) {
    return {
      name: "agentpay",
      action: "request_payment",
      params: { checkout_url: part.url, title: caption.slice(0, 64), note: subtitle },
    };
  }
  return {
    name: "link",
    action: "open",
    params: {
      title: caption.slice(0, 64),
      subtitle,
      button: kind === "cart" ? "Check out" : "Vote",
      url: part.url,
    },
  };
}

/**
 * An experience send carries no layout, so the rendered image is attached by an
 * immediate in-place update. Returns the id of the card as it now stands.
 */
async function sendExperienceCard(env: Env, chatId: string, part: CardPart, kind: CardKind): Promise<string> {
  const linq = linqClient(env);
  let forceLink = false;
  let sent;
  try {
    sent = await linq.chats.messages.send(chatId, { message: { experience: experienceFor(part, kind) } });
  } catch (err) {
    if (kind !== "cart") throw err;
    log("warn", "linq", "card.agentpay_rejected", { chat: short(chatId), error: String(err).slice(0, 200) });
    forceLink = true;
    sent = await linq.chats.messages.send(chatId, { message: { experience: experienceFor(part, kind, true) } });
  }
  const experience = experienceFor(part, kind, forceLink);
  log("info", "linq", "card.sent", { chat: short(chatId), kind, via: experience.name });

  try {
    const updated = await linq.messages.updateAppCard(sent.message.id, { experience, layout: part.layout });
    return updated.message.id;
  } catch (err) {
    // The card is up either way; it just has no image yet.
    log("warn", "linq", "card.image_failed", { chat: short(chatId), error: String(err).slice(0, 200) });
    return sent.message.id;
  }
}

/**
 * Posts the card and returns its message id, which the caller must keep for
 * redraws and for matching tapbacks.
 */
export async function sendCard(
  env: Env,
  chatId: string,
  agentName: string,
  plan: PlanState,
  participantCount: number,
  kind: CardKind = "plan",
): Promise<string> {
  const part = kind === "cart" ? cartCardPart(env, agentName, plan) : appCardPart(env, agentName, plan, participantCount);
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.card", { chat: short(chatId), kind, image: part.layout.image_url, url: part.url });
    return `dry-${kind}`;
  }
  const linq = linqClient(env);

  // No Messages extension of our own: render through Linq's, as an experience.
  if (!hasAppIdentity(env)) return sendExperienceCard(env, chatId, part, kind);

  // An app card must be the only part in its message.
  const res = await linq.chats.messages.send(chatId, { message: { parts: [part] } });
  return res.message.id;
}

/**
 * Redraws the existing bubble instead of posting a new message.
 *
 * Returns the card's NEW message id: Linq replaces the message on every update,
 * so the id used here is dead afterwards. Callers must store the returned id or
 * the next redraw — and every tapback on the card — will miss.
 */
export async function updateCard(
  env: Env,
  messageId: string,
  agentName: string,
  plan: PlanState,
  participantCount: number,
  kind: CardKind = "plan",
) {
  if (isDry(env, agentName)) return void log("info", "linq", "dry.card_update", { messageId, kind, version: plan.version });
  const part = kind === "cart" ? cartCardPart(env, agentName, plan) : appCardPart(env, agentName, plan, participantCount);
  const res = hasAppIdentity(env)
    ? await linqClient(env).messages.updateAppCard(messageId, {
        url: part.url,
        fallback_text: part.fallback_text,
        layout: part.layout,
      })
    : await linqClient(env).messages.updateAppCard(messageId, {
        // agentpay cards are redrawn as link cards: a re-issued payment request
        // is not something to do as a side effect of a redraw.
        experience: experienceFor(part, kind, true),
        layout: part.layout,
      });
  return res.message.id;
}
