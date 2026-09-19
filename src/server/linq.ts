import LinqAPIV3 from "@linqapp/sdk";
import { SLOT_EMOJI, type PlanState } from "../types";

export function linqClient(env: Env) {
  return new LinqAPIV3({ apiKey: env.LINQ_API_KEY });
}

export function cardImageUrl(env: Env, agentName: string, version: number) {
  // `v` busts the image cache; without it the bubble can show a stale render.
  return `${env.PUBLIC_BASE_URL}/card/${encodeURIComponent(agentName)}?v=${version}`;
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
      return `${votes}/${participantCount} voted`;
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

export function tapbackLegend(plan: PlanState) {
  return plan.options.map((o, i) => `${SLOT_EMOJI[i]} ${o.title}`).join("\n");
}

/**
 * With no LINQ_API_KEY the transport is dry: sends are logged, not delivered.
 * Paired with the localhost-only /api/dev routes, that lets the whole agent
 * loop run on a laptop without a Linq number or a phone.
 */
const isDry = (env: Env) => !env.LINQ_API_KEY;

export async function sendText(env: Env, chatId: string, value: string) {
  if (isDry(env)) return void console.log(`[linq:dry] → ${chatId}: ${value}`);
  return linqClient(env).chats.messages.send(chatId, {
    message: { parts: [{ type: "text", value }] },
  });
}

/**
 * Posts the plan card and returns the message id to update later, or null when
 * there is no app identity and the card went out as a plain image (which cannot
 * be updated in place).
 */
export async function sendCard(
  env: Env,
  chatId: string,
  agentName: string,
  plan: PlanState,
  participantCount: number,
): Promise<string | null> {
  if (isDry(env)) {
    console.log(`[linq:dry] → ${chatId}: [card] ${cardImageUrl(env, agentName, plan.version)}`);
    return "dry-card";
  }
  const linq = linqClient(env);

  if (!hasAppIdentity(env)) {
    await linq.chats.messages.send(chatId, {
      message: {
        parts: [
          { type: "media", url: cardImageUrl(env, agentName, plan.version) },
          { type: "text", value: widgetUrl(env, agentName) },
        ],
      },
    } as never);
    return null;
  }

  // An app card must be the only part in its message.
  const res = await linq.chats.messages.send(chatId, {
    message: { parts: [appCardPart(env, agentName, plan, participantCount)] },
  });
  return res.message.id;
}

/** Redraws the existing bubble instead of posting a new message. */
export async function updateCard(
  env: Env,
  messageId: string,
  agentName: string,
  plan: PlanState,
  participantCount: number,
) {
  if (isDry(env)) return void console.log(`[linq:dry] ↻ card ${messageId} → v${plan.version}`);
  const part = appCardPart(env, agentName, plan, participantCount);
  return linqClient(env).messages.updateAppCard(messageId, {
    url: part.url,
    fallback_text: part.fallback_text,
    layout: part.layout,
  });
}
