/**
 * Pairing people up: "find me someone to climb with".
 *
 * Matching is search over the opt-in pool (tools/match.ts). An introduction is
 * the careful part, because the two people are in different chats and neither
 * has agreed to meet the other yet:
 *
 *   A's DM   find_matches ─▶ candidates, shown without names or numbers
 *            request_intro ─▶ Intro{pending} ──RPC──▶ B's DM: "want to meet someone into X?"
 *   B's DM   answer_intro(no)  ─▶ Intro{declined} ─▶ A hears "no luck", never who
 *            answer_intro(yes) ─▶ Intro{accepted} ─▶ a new group chat with both + the match ticket
 *
 * Nobody's name or number reaches the other person before both have said yes.
 * Intros live in the People store, next to the profiles they are made from.
 */
export type IntroStatus = "pending" | "accepted" | "declined" | "expired";

export type Intro = {
  id: string;
  /** Who asked, and the DM chat to report back to. */
  from: string;
  fromChat: string;
  /** Who is being asked. */
  to: string;
  /** What they share, from their own profiles. Shown to both. */
  common: { emoji?: string; text: string }[];
  status: IntroStatus;
  created: number;
  /** The group chat opened for them, once accepted. */
  chat?: string;
};

/** An unanswered ask stops blocking the asker after this long. */
export const INTRO_TTL_MS = 48 * 3600 * 1000;

/** One open ask at a time per person: this is an introduction, not a mailing list. */
export const MAX_PENDING_PER_ASKER = 1;

/** A candidate as the model sees it: a ref, never a handle or a name. */
export type Candidate = { ref: string; blurb: string; score: number };

export const commonLine = (common: Intro["common"]) => common.map((c) => c.text).join(", ");

/** What B is asked. No name, no number, and an easy no. */
export const askText = (intro: Intro) =>
  `someone here is also into ${commonLine(intro.common)}. want me to introduce you two? yes or no. if it's a no they won't know it was you`;

export const expiredText = "never heard back on that intro, so i've let it go. want me to try someone else?";

/** The asker hears a beat after the other person does, so the yes and the new chat do not land out of order. */
export const ANSWER_RELAY_SECONDS = 6;

export const declinedText = "no luck on that one. want me to try someone else?";

export const openingText = (a: string, b: string, intro: Intro) =>
  `${a}, meet ${b}. you're both into ${commonLine(intro.common)}. tag me if you want help planning something`;
