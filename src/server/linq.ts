import { tracedFetch } from "./telemetry";
import LinqAPIV3 from "@linqapp/sdk";
import { cartsOf, shopKey, type PlanState } from "../types";
import { errorFields, log, short } from "./log";

export function linqClient(env: Env) {
  return new LinqAPIV3({ fetch: tracedFetch, apiKey: env.LINQ_API_KEY });
}

export function cardImageUrl(env: Env, agentName: string, version: number) {
  // `v` busts the image cache; without it the bubble can show a stale render.
  return `${env.PUBLIC_BASE_URL}/card/${encodeURIComponent(agentName)}?v=${version}`;
}

export type CardKind = "plan" | "cart";

export function cartImageUrl(env: Env, agentName: string, version: number, shop: string) {
  return `${cardImageUrl(env, agentName, version)}&kind=cart&shop=${encodeURIComponent(shop)}`;
}

export function widgetUrl(env: Env, agentName: string) {
  return `${env.PUBLIC_BASE_URL}/w/${encodeURIComponent(agentName)}`;
}

/** The square stamp that becomes the group icon once the plan is booked. Linq fetches and re-hosts it. */
export function planIconUrl(env: Env, agentName: string, version: number) {
  return `${env.PUBLIC_BASE_URL}/card/${encodeURIComponent(agentName)}/icon.png?v=${version}`;
}

export function musicUrl(env: Env, agentName: string) {
  return `${env.PUBLIC_BASE_URL}/music/${encodeURIComponent(agentName)}`;
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
    case "handoff":
      return "Yours to finish";
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
    // Static on purpose: a body with dates, addresses or day words ("Friday")
    // makes iMessage drop the whole card to plain text. Detail lives in layout.
    fallback_text: "Open the plan",
    layout: {
      caption: plan.title,
      subcaption: winner ? winner.title : `${plan.options.length} options`,
      trailing_caption: statusLabel(plan, participantCount),
      image_url: cardImageUrl(env, agentName, plan.version),
    },
  };
}

/**
 * One store's cart as an app card. Tapping goes straight to that store's
 * checkout. With no `shop` it falls back to the first cart, which is all a
 * single-store plan has.
 */
export function cartCardPart(env: Env, agentName: string, plan: PlanState, shop?: string) {
  const carts = cartsOf(plan);
  const cart = carts.find((c) => shop && shopKey(c.shop) === shopKey(shop)) ?? carts[0];
  if (!cart) throw new Error(`no cart${shop ? ` for ${shop}` : ""} to draw a card for`);
  const items = cart.lines.reduce((n, l) => n + l.quantity, 0);
  return {
    ...appCardPart(env, agentName, plan, 0),
    // The widget's shopping view, not the raw Shopify checkout: a checkout form
    // crammed into the bubble panel is unusable, and the view has the checkout
    // link one tap further for whoever is paying.
    url: `${widgetUrl(env, agentName)}?cart=${encodeURIComponent(shopKey(cart.shop))}`,
    fallback_text: `Cart at ${cart.shop} — ${cart.total}\n${cart.checkoutUrl}`,
    // The thing being bought, not a drawing of a receipt: its photo and name
    // when the store sent them, the rendered order ticket when it did not.
    layout: {
      caption: cart.lines.length === 1 ? cart.lines[0].title : `${items} items`,
      subcaption: cart.shop,
      trailing_caption: cart.total,
      image_url: cart.lines.find((l) => l.imageUrl)?.imageUrl
        ? sizedImage(cart.lines.find((l) => l.imageUrl)!.imageUrl!)
        : cartImageUrl(env, agentName, plan.version, cart.shop),
    },
  };
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

export type SendOptions = {
  /** Thread the text under this message, as an inline reply. */
  replyTo?: string;
  /** A full-screen iMessage effect: confetti, fireworks, balloons… */
  screenEffect?: string;
};

export async function sendText(env: Env, chatId: string, value: string, opts: SendOptions = {}): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.text", { chat: short(chatId), text: value, ...opts });
    return `dry-${crypto.randomUUID().slice(0, 8)}`;
  }
  const res = await linqClient(env).chats.messages.send(chatId, {
    message: {
      parts: [{ type: "text", value }],
      ...(opts.replyTo ? { reply_to: { message_id: opts.replyTo } } : {}),
      ...(opts.screenEffect ? { effect: { type: "screen" as const, name: opts.screenEffect } } : {}),
    },
  });
  return res.message.id;
}

/**
 * Opens a group chat with these people and the agent's number, and returns its
 * id. Dry — a made-up, non-UUID id, which keeps every later send dry too —
 * without a key or when any handle is a simulator number (+1555…).
 */
export async function createGroupChat(env: Env, to: string[], text: string): Promise<string> {
  if (!env.LINQ_API_KEY || to.some((h) => /^\+1555/.test(h))) {
    log("info", "linq", "dry.chat_create", { people: to.length, text });
    return `intro-${crypto.randomUUID().slice(0, 8)}`;
  }
  const linq = linqClient(env);
  const from = env.LINQ_FROM_NUMBER || (await linq.phoneNumbers.list()).phone_numbers[0]?.phone_number;
  if (!from) throw new Error("No Linq phone number to open the chat from");
  const res = await linq.chats.create({ from, to, message: { parts: [{ type: "text", value: text }] } });
  return res.chat.id;
}

// ------------------------------------------------------------------ presence
// The small signals that make the number feel like a person: a read receipt,
// the typing bubble, a name and photo. All are best-effort — Linq answers 204
// without promising delivery — so a failure is logged and never thrown: none of
// them is worth losing a turn over.

/** Resolves to "ok", "dry", or the error — for the caller's own log, never thrown. */
async function quietly(env: Env, chatId: string, event: string, call: (linq: LinqAPIV3) => Promise<unknown>): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", `dry.${event}`, { chat: short(chatId) });
    return "dry";
  }
  try {
    await call(linqClient(env));
    return "ok";
  } catch (err) {
    const error = String(err).slice(0, 200);
    log("warn", "linq", `${event}.failed`, { chat: short(chatId), error });
    return error;
  }
}

export const markRead = (env: Env, chatId: string) => quietly(env, chatId, "read", (l) => l.chats.markAsRead(chatId));

/**
 * One call shows the bubble for ~85s and sending a message clears it, so a long
 * turn must call this again about once a minute and after each text it sends.
 */
export const startTyping = (env: Env, chatId: string) => quietly(env, chatId, "typing", (l) => l.chats.typing.start(chatId));

export const stopTyping = (env: Env, chatId: string) => quietly(env, chatId, "typing_stop", (l) => l.chats.typing.stop(chatId));

/**
 * Name and Photo Sharing: offers the number's contact card (set once with
 * scripts/linq-contact-card.mjs) so the thread shows a name and face instead of
 * digits. Fails harmlessly when no card has been set up.
 */
export const shareContactCard = (env: Env, chatId: string) =>
  quietly(env, chatId, "contact_card", (l) => l.chats.shareContactCard(chatId));

// ------------------------------------------------------------------ dressing
// The chat itself, once the plan is booked: a name, an icon, a background.
// Same footing as presence — Linq answers before the phones have changed, and
// a name or an icon is a group-chat thing — so each is its own quiet call
// and none can fail the booking that earned it.

/** iOS's animated background; `{ type: "color", variant: "custom", shades: ["#1f5f4f", "#efe7d6"] }` is the ticket's own colours. */
const BOOKED_BACKGROUND = { type: "dynamic", style: "aurora" } as const;

export type Dressing = { name: string; iconUrl: string };

/** Applies all three and reports each outcome ("ok", "dry", or the error) for the caller's log. */
export async function dressChat(env: Env, chatId: string, d: Dressing): Promise<{ name: string; icon: string; background: string }> {
  // Name and icon are separate updates: an icon Linq cannot fetch must not cost the name.
  const [name, icon, background] = await Promise.all([
    quietly(env, chatId, "chat_name", (l) => l.chats.update(chatId, { display_name: d.name })),
    quietly(env, chatId, "chat_icon", (l) => l.chats.update(chatId, { group_chat_icon: d.iconUrl })),
    quietly(env, chatId, "chat_background", (l) => l.chats.background.set(chatId, BOOKED_BACKGROUND)),
  ]);
  return { name, icon, background };
}

export type Tapback = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export const tapback = (env: Env, chatId: string, messageId: string, type: Tapback) =>
  quietly(env, chatId, "tapback", (l) => l.messages.addReaction(messageId, { operation: "add", type }));

/**
 * A ticket as an ordinary photo. Agent Apps draws the card bubble itself and
 * shows none of our image, so a photo is how the design reaches the thread.
 * A photo cannot be redrawn, so tickets go out at moments, not on every change.
 * Returns the message id, which is what a tapback on the photo will name.
 */
/**
 * A tappable card that opens a URL, drawn by Linq's own iMessage extension (the
 * `link` experience), so it needs no app of ours. Phones without Agent Apps
 * show the title and subtitle as a static card; tapping still opens the link.
 */
export async function sendLinkCard(
  env: Env,
  chatId: string,
  card: { title: string; subtitle?: string; button?: string; url: string },
): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.link_card", { chat: short(chatId), title: card.title, url: card.url.replace(/\/p\/[0-9a-f]+/, "/p/<token>") });
    return `dry-${crypto.randomUUID().slice(0, 8)}`;
  }
  // With our own extension configured, link cards ride it too: same tap-to-open,
  // but rendered as our app — and, unlike link experiences, legal in group chats.
  if (hasAppIdentity(env)) {
    const res = await linqClient(env).chats.messages.send(chatId, {
      message: {
        parts: [{
          type: "imessage_app" as const,
          app: { name: env.IMESSAGE_APP_NAME, team_id: env.IMESSAGE_TEAM_ID, bundle_id: env.IMESSAGE_BUNDLE_ID },
          url: card.url,
          // The button label is the one part guaranteed free of dates and
          // addresses, which would knock the card down to plain text.
          fallback_text: card.button?.slice(0, 24) || "Open",
          layout: { caption: card.title.slice(0, 64), subcaption: card.subtitle?.slice(0, 120), trailing_caption: card.button?.slice(0, 24) },
        }],
      },
    });
    return res.message.id;
  }
  const res = await linqClient(env).chats.messages.send(chatId, {
    message: {
      experience: {
        name: "link",
        action: "open",
        params: { title: card.title.slice(0, 64), subtitle: card.subtitle?.slice(0, 120), button: card.button?.slice(0, 24), url: card.url },
      },
    },
  });
  return res.message.id;
}

// ------------------------------------------------------------------ tickets

/**
 * A stored ticket (venue, RSVP, paid receipt, match intro) as an app card the
 * extension renders natively from /ticket/<chat>/<id>. Callers fall back to
 * the ticket PNG photo when no app identity is configured.
 */
export async function sendTicketCard(
  env: Env,
  chatId: string,
  agentName: string,
  ticketId: string,
  t: { title: string; metaLeft: string; stubBig: string; stubLabel: string },
): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.ticket_card", { chat: short(chatId), ticket: ticketId, title: t.title });
    return `dry-ticket-${ticketId}`;
  }
  const res = await linqClient(env).chats.messages.send(chatId, {
    message: {
      parts: [{
        type: "imessage_app" as const,
        app: { name: env.IMESSAGE_APP_NAME, team_id: env.IMESSAGE_TEAM_ID, bundle_id: env.IMESSAGE_BUNDLE_ID },
        url: `${env.PUBLIC_BASE_URL}/ticket/${encodeURIComponent(agentName)}/${ticketId}`,
        // Static: dates or addresses in the body would demote the card to text.
        fallback_text: "Open the card",
        layout: {
          caption: t.title.slice(0, 64),
          subcaption: t.metaLeft.slice(0, 120),
          trailing_caption: t.stubBig.slice(0, 24),
          trailing_subcaption: t.stubLabel.slice(0, 24),
        },
      }],
    },
  });
  return res.message.id;
}

/** A generated game as an app card; the extension renders play from /game/<chat>/<id>. */
export async function sendGameCard(env: Env, chatId: string, agentName: string, gameId: string, title: string, topic: string): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.game_card", { chat: short(chatId), game: gameId, title });
    return `dry-game-${gameId}`;
  }
  const url = `${env.PUBLIC_BASE_URL}/game/${encodeURIComponent(agentName)}/${gameId}`;
  if (!hasAppIdentity(env)) {
    return sendLinkCard(env, chatId, { title: title.slice(0, 64), subtitle: topic.slice(0, 120), button: "Play", url });
  }
  const res = await linqClient(env).chats.messages.send(chatId, {
    message: {
      parts: [{
        type: "imessage_app" as const,
        app: { name: env.IMESSAGE_APP_NAME, team_id: env.IMESSAGE_TEAM_ID, bundle_id: env.IMESSAGE_BUNDLE_ID },
        url,
        fallback_text: "Play the game",
        layout: {
          caption: title.slice(0, 64),
          subcaption: topic.slice(0, 120),
          trailing_caption: "PLAY",
          image_url: `${env.PUBLIC_BASE_URL}/card/${encodeURIComponent(agentName)}?kind=game&id=${gameId}`,
        },
      }],
    },
  });
  return res.message.id;
}

// ------------------------------------------------------------------- music

/** The playlist as an app card: our extension renders the player from /music/<chat>. */
function musicPart(env: Env, agentName: string, trackCount: number) {
  return {
    type: "imessage_app" as const,
    app: {
      name: env.IMESSAGE_APP_NAME,
      team_id: env.IMESSAGE_TEAM_ID,
      bundle_id: env.IMESSAGE_BUNDLE_ID,
    },
    url: musicUrl(env, agentName),
    // Static on purpose — see appCardPart.
    fallback_text: "Open the playlist",
    layout: {
      caption: "Group playlist",
      subcaption: trackCount ? `${trackCount} track${trackCount === 1 ? "" : "s"}` : "name a song to add it",
      trailing_caption: "▶",
      image_url: `${env.PUBLIC_BASE_URL}/card/${encodeURIComponent(agentName)}?kind=music&v=${trackCount}`,
    },
  };
}

/**
 * Posts the playlist card. With no app identity it falls back to a link
 * experience, which only ever works in one-to-one chats — groups reject it.
 */
export async function sendMusicCard(env: Env, chatId: string, agentName: string, trackCount: number): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.music_card", { chat: short(chatId), tracks: trackCount });
    return `dry-music-${crypto.randomUUID().slice(0, 8)}`;
  }
  if (!hasAppIdentity(env)) {
    return sendLinkCard(env, chatId, {
      title: "Group playlist",
      subtitle: trackCount ? `${trackCount} track${trackCount === 1 ? "" : "s"} · tap to play` : "tap to open the player",
      button: "Play",
      url: musicUrl(env, agentName),
    });
  }
  const res = await linqClient(env).chats.messages.send(chatId, { message: { parts: [musicPart(env, agentName, trackCount)] } });
  return res.message.id;
}

/** Redraws the playlist card's track count in place. Returns the card's NEW id, or undefined when it could not. */
export async function updateMusicCard(env: Env, messageId: string, agentName: string, trackCount: number): Promise<string | undefined> {
  if (isDry(env, agentName) || !hasAppIdentity(env)) {
    log("info", "linq", "dry.music_card_update", { messageId, tracks: trackCount });
    return undefined;
  }
  const part = musicPart(env, agentName, trackCount);
  const res = await linqClient(env).messages.updateAppCard(messageId, { url: part.url, fallback_text: part.fallback_text, layout: part.layout });
  return res.message.id;
}

// ------------------------------------------------------------------ payments
//
// Linq's agent payments: a person connects once (a one-time code and a consent
// step that Linq itself runs in the thread), adds a card to a wallet Linq's
// provider holds, and later approves each purchase with a passkey, which mints
// a single-use virtual card for that purchase alone. Nothing here ever sees a
// card number. These three calls are only the SETUP half: no money moves.

// ------------------------------------------------------------------ location
// Asking where someone is instead of making them type it. The agent takes the
// city once and ends the share: it never polls a position, and coordinates
// never leave this file — only the locality and the handle it belongs to.

/**
 * - "sent": the person gets an iMessage prompt and has to accept it.
 * - "already_sharing": nothing to ask; read it.
 * - "not_one_to_one": Apple only allows the request in a 1:1 iMessage chat.
 * - "unavailable": the account lacks the feature, or Linq refused for another reason.
 */
export type LocationAsk = "sent" | "already_sharing" | "not_one_to_one" | "unavailable";

export async function requestLocation(env: Env, chatId: string): Promise<LocationAsk> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.location_request", { chat: short(chatId) });
    return "sent";
  }
  try {
    await linqClient(env).chats.location.request(chatId);
    return "sent";
  } catch (err) {
    const text = String(err);
    // 409 covers three different refusals; the codes tell them apart.
    if (/2016|2017|GroupChatNotSupported|ChatServiceNotSupported/.test(text)) return "not_one_to_one";
    if (/\b409\b/.test(text)) return "already_sharing";
    log("warn", "linq", "location_request.failed", { chat: short(chatId), error: text.slice(0, 200) });
    return "unavailable";
  }
}

/** City-level only, by design: see the note above. */
export type SharedPlace = { handle: string; locality?: string; region?: string; updatedAt?: string };

type Located = SharedPlace & { lon: number; lat: number };

/** The one place coordinates exist. Nothing below hands them on. */
async function located(env: Env, chatId: string): Promise<Located[]> {
  if (isDry(env, chatId)) return [];
  try {
    const res = await linqClient(env).chats.location.retrieve(chatId);
    return res.data.features.map((f) => ({
      handle: f.properties.handle,
      locality: f.properties.locality,
      region: regionFrom(f.properties.address, f.properties.locality),
      updatedAt: f.properties.updated_at,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));
  } catch (err) {
    log("warn", "linq", "location_read.failed", { chat: short(chatId), error: String(err).slice(0, 200) });
    return [];
  }
}

const strip = ({ handle, locality, region, updatedAt }: Located): SharedPlace => ({ handle, locality, region, updatedAt });

export async function readLocation(env: Env, chatId: string): Promise<SharedPlace[]> {
  return (await located(env, chatId)).map(strip);
}

export type PlacesRead = { people: SharedPlace[]; pairs: { a: string; b: string; km: number }[] };

/**
 * Everyone sharing in this chat — reading works in groups, only *asking* is
 * 1:1 — with the distance between each pair. The distance is worked out here so
 * the coordinates never leave this file: callers get a city per person and a
 * rounded number per pair, which is all "how far apart are we" needs.
 */
export async function readPlaces(env: Env, chatId: string): Promise<PlacesRead> {
  const all = await located(env, chatId);
  const pairs: PlacesRead["pairs"] = [];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) pairs.push({ a: all[i].handle, b: all[j].handle, km: kmBetween(all[i], all[j]) });
  return { people: all.map(strip), pairs };
}

/** Great-circle distance, rounded to 100 m: precise enough to plan with, too coarse to locate anyone. */
export function kmBetween(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/**
 * "12 King St W, Toronto, ON M5H 1A1, Canada" -> "ON, Canada". The street is
 * dropped on purpose; the region is kept because "Waterloo" alone is ambiguous
 * to a search engine and "Waterloo, ON, Canada" is not.
 */
function regionFrom(address?: string, locality?: string): string | undefined {
  if (!address || !locality) return undefined;
  const after = address.split(locality)[1];
  if (!after) return undefined;
  const parts = after
    .split(",")
    .map((part) => part.replace(/\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b|\b\d{5}(-\d{4})?\b/g, "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

/** Ends the share, so the position can never be read again. Best effort. */
export const stopLocation = (env: Env, chatId: string, handle: string) =>
  quietly(env, chatId, "location_stop", (l) => l.chats.location.stop(chatId, { handle }));

export type PaymentConnection = { status: "not_connected" | "pending" | "connected" | "revoked"; connectId?: string; simulated?: boolean };

export async function paymentConnection(env: Env, chatId: string, handle: string): Promise<PaymentConnection> {
  // Simulator chats have no Linq to ask; the caller falls back to what the stubbed setup recorded.
  if (isDry(env, chatId)) return { status: "not_connected", simulated: true };
  const c = await linqClient(env).paymentHandles.connection(handle);
  return { status: c.status ?? "not_connected" };
}

/** Starts the ceremony. Linq sends the code; the returned connectId must be held until it is verified. */
export async function connectPayments(env: Env, chatId: string, handle: string): Promise<PaymentConnection> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.payments_connect", { chat: short(chatId) });
    return { status: "pending", connectId: "dry-connect" };
  }
  const c = await linqClient(env).paymentHandles.connect(handle);
  return { status: c.status ?? "pending", connectId: c.connect_id };
}

export async function verifyPayments(env: Env, chatId: string, handle: string, connectId: string, code: string): Promise<PaymentConnection> {
  if (isDry(env, chatId)) {
    if (code !== "000000") throw new Error("that code is not right");
    return { status: "connected" };
  }
  const c = await linqClient(env).paymentHandles.verify(handle, { connect_id: connectId, code });
  return { status: c.status ?? "not_connected" };
}

/** Withdraws this app's permission to request payments. The person's wallet itself is theirs and untouched. */
export async function revokePayments(env: Env, chatId: string, handle: string): Promise<void> {
  if (isDry(env, chatId)) return void log("info", "linq", "dry.payments_revoke", { chat: short(chatId) });
  await linqClient(env).paymentHandles.revoke(handle);
}

// ---- paying
// A purchase mints a single-use virtual card for one exact amount at one
// merchant. Linq never sees the number: it hands back a short-lived token, and
// the card is fetched from the provider directly, used once, and dropped.

export type PaymentStep =
  | { status: "ready"; id: string }
  | { status: "needs_connection" }
  | { status: "needs_card"; url: string }
  | { status: "needs_approval"; url: string }
  | { status: "failed"; why: string };

export type PaymentAsk = { handle: string; amountCents: number; currency: string; description: string; merchant: { name: string; url: string }; key: string };

/**
 * Advances one payment. Call it again with the same `key` after the person has
 * acted (added a card, approved with their passkey) and it moves forward; the
 * key is what stops a retry from minting a second card.
 */
export async function requestPayment(env: Env, chatId: string, ask: PaymentAsk): Promise<PaymentStep> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.payment", { chat: short(chatId), amountCents: ask.amountCents, merchant: ask.merchant.name });
    return { status: "ready", id: `dry-pay-${ask.key.slice(0, 8)}` };
  }
  const p = await linqClient(env).payments.create(
    { handle: ask.handle, amount_cents: ask.amountCents, currency: ask.currency.toLowerCase(), description: ask.description, merchant: ask.merchant, metadata: { chat: short(chatId) } },
    { idempotencyKey: ask.key },
  );
  if ((p.status === "ready" || p.status === "authorized") && p.id) return { status: "ready", id: p.id };
  if (p.status === "needs_connection" || p.status === "connecting") return { status: "needs_connection" };
  if (p.status === "awaiting_user_action" && p.approval_url) return { status: "needs_approval", url: p.approval_url };
  if (p.status === "awaiting_user_action" && p.attach_url) return { status: "needs_card", url: p.attach_url };
  return { status: "failed", why: p.status ?? "no status" };
}

/** Closes the virtual card. Best-effort: an unused single-use card expires on its own. */
export async function cancelPayment(env: Env, chatId: string, paymentId: string): Promise<void> {
  if (isDry(env, chatId) || paymentId.startsWith("dry-")) return;
  await linqClient(env).payments.cancel(paymentId).catch((err: unknown) => log("warn", "linq", "payment.cancel_failed", errorFields(err)));
}

export async function paymentSucceeded(env: Env, chatId: string, paymentId: string): Promise<boolean> {
  if (isDry(env, chatId) || paymentId.startsWith("dry-")) return false;
  const p = await linqClient(env).payments.retrieve(paymentId);
  return p.status === "succeeded" || p.status === "authorized";
}

/**
 * The card for a ready payment, fetched straight from the provider. The result
 * must stay in local variables: never logged, never stored, never returned from
 * a workflow step (step results are persisted), never put in a prompt.
 */
export async function paymentCard(env: Env, paymentId: string): Promise<{ number: string; expMonth: string; expYear: string; cvc: string }> {
  const { handoff } = await linqClient(env).payments.credentials(paymentId);
  if (!handoff?.fetch_url || !handoff.user_token) throw new Error("no card handoff for this payment");
  const res = await fetch(handoff.fetch_url, { headers: { authorization: `Bearer ${handoff.user_token}`, accept: "application/json" } });
  if (!res.ok) throw new Error(`card provider answered ${res.status}`);
  // Providers differ in shape and naming, so look for the four values wherever they sit.
  const flat: Record<string, string> = {};
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string" || typeof val === "number") flat[k.toLowerCase().replace(/[^a-z]/g, "")] ??= String(val);
      else walk(val);
    }
  };
  walk(await res.json());
  const pick = (...names: string[]) => names.map((n) => flat[n]).find(Boolean);
  const number = pick("pan", "number", "cardnumber")?.replace(/\D/g, "");
  const cvc = pick("cvc", "cvv", "securitycode", "cvc2", "cvv2");
  const expiry = pick("expiry", "expiration", "exp", "expirationdate");
  const expMonth = pick("expmonth", "expirationmonth", "expirymonth") ?? expiry?.match(/^(\d{1,2})/)?.[1];
  const expYear = pick("expyear", "expirationyear", "expiryyear") ?? expiry?.match(/(\d{2,4})$/)?.[1];
  if (!number || !cvc || !expMonth || !expYear) throw new Error(`card provider (${handoff.provider ?? "unknown"}) answered in a shape this code does not know: ${Object.keys(flat).join(",").slice(0, 200)}`);
  return { number, expMonth, expYear, cvc };
}

/**
 * A link to the wallet's add-a-card page that opens in Safari. Linq's own
 * attach_card card opens inline, where the page cannot work: it needs a pop-up
 * and a passkey, and an in-app webview allows neither. The only place Linq
 * hands out the page's url is on a payment request for someone with no card
 * yet, so this makes a $1 placeholder request purely to read that url. Nothing
 * ever fetches a card for it, so it cannot charge, and it lapses on its own.
 * Only for a wallet that was connected a moment ago: for one that already has a
 * card, the same call would start a real approval.
 */
export async function attachLink(env: Env, chatId: string, handle: string): Promise<string | undefined> {
  if (isDry(env, chatId)) return undefined;
  const linq = linqClient(env);
  const p = await linq.payments.create(
    { handle, amount_cents: 100, currency: "usd", description: "Card setup (not a purchase)", merchant: { name: "Whim setup", url: env.PUBLIC_BASE_URL } },
    { idempotencyKey: `setup-${crypto.randomUUID()}` },
  );
  if (p.status === "awaiting_user_action" && p.attach_url) return p.attach_url;
  // They already have a card, so a placeholder would become a real request: close it.
  if (p.id) await linq.payments.cancel(p.id).catch((err: unknown) => log("warn", "linq", "payment.cancel_failed", errorFields(err)));
  return undefined;
}

/** The card that asks someone to add a payment card to their wallet. */
export async function sendAttachCard(env: Env, chatId: string): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.attach_card", { chat: short(chatId) });
    return `dry-${crypto.randomUUID().slice(0, 8)}`;
  }
  const res = await linqClient(env).chats.messages.send(chatId, {
    message: {
      experience: {
        name: "agentcard",
        action: "attach_card",
        params: { title: "Add a card", subtitle: "Used only for purchases you approve, one at a time.", button: "Add card" },
      },
    },
  });
  return res.message.id;
}

/**
 * Shopify serves product images at full resolution; a width hint keeps the
 * download small. Other hosts get the URL untouched.
 */
export const sizedImage = (url: string, width = 1200) =>
  /cdn\.shopify\.com|\/cdn\/shop\//.test(url) ? `${url}${url.includes("?") ? "&" : "?"}width=${width}` : url;

/** Several photos as one message, which iMessage shows as a single stack. */
export async function sendPhotos(env: Env, chatId: string, urls: string[]): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.photos", { chat: short(chatId), images: urls });
    return `dry-photo-${crypto.randomUUID().slice(0, 8)}`;
  }
  const res = await linqClient(env).chats.messages.send(chatId, {
    message: { parts: urls.map((url) => ({ type: "media", url })) },
  } as never);
  return res.message.id;
}

export async function sendPhoto(env: Env, chatId: string, url: string): Promise<string> {
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.photo", { chat: short(chatId), image: url });
    return `dry-photo-${crypto.randomUUID().slice(0, 8)}`;
  }
  const res = await linqClient(env).chats.messages.send(chatId, { message: { parts: [{ type: "media", url }] } } as never);
  return res.message.id;
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
  /** Which store's cart, for a cart card. Each store has a card of its own. */
  shop?: string,
): Promise<string> {
  const part = kind === "cart" ? cartCardPart(env, agentName, plan, shop) : appCardPart(env, agentName, plan, participantCount);
  if (isDry(env, chatId)) {
    log("info", "linq", "dry.card", { chat: short(chatId), kind, shop, image: part.layout.image_url, url: part.url });
    return kind === "cart" && shop ? `dry-cart-${shopKey(shop)}` : `dry-${kind}`;
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
  shop?: string,
) {
  if (isDry(env, agentName)) return void log("info", "linq", "dry.card_update", { messageId, kind, shop, version: plan.version });
  const part = kind === "cart" ? cartCardPart(env, agentName, plan, shop) : appCardPart(env, agentName, plan, participantCount);
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
