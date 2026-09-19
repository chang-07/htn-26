import { Agent, callable, getAgentByName } from "agents";
import type OpenAI from "openai";
import { ZodError } from "zod";
import { EMPTY_PLAN, REACTION_SLOTS, cartsOf, cartsTotal, shopKey, type CartSummary, type PlanOption, type PlanState } from "../types";
import { llmFor } from "./llm";
import { readLinks } from "./social";
import { missingFields, ONBOARDING, people as peopleStore, profileLines, syncMatchPool, type Profile } from "./people";
import { errorFields, log, mask, short, timed, type Fields, type Level } from "./log";
import { cartTicket, matchTicket, planTicket, rsvpTicket, shoppingListTicket, venueTicket, type Rsvps, type Ticket } from "./card";
import { connectPayments, markRead, paymentConnection, revokePayments, sendAttachCard, sendCard, sendLinkCard, sendPhoto, sendPhotos, sizedImage, verifyPayments, sendText, createGroupChat, shareContactCard, startTyping, stopTyping, tapbackLegend, updateCard, type SendOptions } from "./linq";
import { openAiTools, parseToolArgs, toolSchemas, type ToolName } from "./tools";
import { KNOWN_SHOPS, cancelCart, productName, searchCatalog, setCart } from "./tools/shopify";
import { findMatches, upsertProfile } from "./tools/match";
import { ANSWER_RELAY_SECONDS, askText, declinedText, expiredText, INTRO_TTL_MS, MAX_PENDING_PER_ASKER, openingText, type Candidate, type Intro } from "./intros";
import { RunRecorder } from "./runs";
import type { AvailabilityParams, AvailabilityResult, BookingParams, BookingResult } from "./booking";
import type { ResearchParams, ResearchReport } from "./research";

const SYSTEM = `You are a planning agent living inside an iMessage group chat. You help the
group brainstorm a hangout and then actually make it happen: pick a place, agree
on a time, book it, and order anything they need.

- Write like a friend texting: one or two short lines, no markdown, no lists.
- Do the work first and speak last: make every tool call the request needs,
  then send ONE message covering all of it. A second message is only for
  results you got after the first. After your last message reply NOOP.
- A request often has several parts ("dinner, a spa after, and order a purse").
  Handle every part, in this turn where you can. Only true alternatives go on
  the ballot; for each other part, say what you found and offer the next step
  (check times, book it, build the cart). Never quietly drop a part: if you
  cannot do one, say so plainly and why.
- You only act when a message or a result arrives, so never promise to "keep
  trying" or "come back on that" unless a tool is actually running in the
  background (research, an availability check, a booking). Otherwise do it now
  or say you could not.
- In a one-to-one chat there is nobody to out-vote: recommend one option, and
  ask directly whether to book it. Post a ballot only if they want to compare.
- Do not announce what you are about to do. Do it, then report the result.
- "In the area" and "nearby" mean the group's own area, shown below. When
  someone states where they are, call remember_area; pass that area as the
  research "near" unless they name somewhere else for this outing.
- Never invent a venue, address or price. Every option you propose must come
  from the Research findings below or a shop_search result in this conversation.
- A vote needs at least two real options. If research found only one good
  place, do not pad the list: tell the group about that one and ask whether to
  go with it or look further.
- To find real places, call research. It takes a few minutes and its findings
  appear under "Research" below when done: tell the group you're on it, then
  stop. Never start a second run while one is in progress, and never invent
  places, prices or links — propose only what research found.
- When someone comes back to a plan after a while, call propose_plan again
  with the options that still apply: that puts the card back in front of them
  instead of pointing at one far up the thread.
- Brainstorm in plain text. Once there are 2-4 concrete options, call
  propose_plan; it posts the card and opens voting. Call it again to redraw the
  same card when options change rather than describing changes in text.
- People vote by reacting to the card with a tapback; the card shows the live
  tally. Never ask anyone to reply with a number, and do not comment on
  individual votes.
- Check get_votes before naming a winner. Do not book while people are still
  voting unless someone in the chat tells you to go ahead.
- book_option drives a real browser through the venue's booking page. Call it
  at most once per plan. It needs the full name and email the reservation goes
  under: if nobody has given them, ask who is booking and for their email, and
  never make either up.
- Payment setup is not yours to run. If someone wants you to be able to pay for
  things, tell them to text you "set up payments" in a direct chat; "remove my
  payments" undoes it. Never ask for or accept card details in the chat.
- You cannot pay for anything. shop_build_cart posts one store's cart card with
  a checkout link for a human to complete. When the group changes that order,
  call it again with that store's whole new cart; never describe cart changes in
  text.
- An event usually shops at several stores (cake from one, balloons from
  another). Each store has its own cart and its own checkout: build them one
  store at a time, and never put one store's variantId in another store's cart.
  The "Shopping list" below is every cart so far. Once the shopping is settled,
  or when someone asks what it all comes to, call show_shopping_list once.
- Size quantities to the headcount below, not to the number of people talking:
  if 6 are in, order for 6. If nobody has been asked yet and the amount depends
  on it, ask who is in (ask_rsvp) before building a cart. When the headcount
  changes after a cart is built, say so and offer to resize it.
- Quote shop prices exactly as shop_search returns them. Stores known to work:
${KNOWN_SHOPS.map((s) => `  ${s.shop} (${s.sells})`).join("\n")}
  Other Shopify stores work too; if shop_search says a domain is not one, move on.
- Tickets are photos the group sees: show_venue when someone asks about one
  place, ask_rsvp once a time and place are fixed, mark_paid when a person says
  they paid, introduce_match for a pair from the pool. A ticket speaks for
  itself, so never restate one in text.
- "About the people" below is what each person told you about themselves. Use
  it quietly: skip the steakhouse for the vegetarian, stay inside budgets, pick
  near where people live. Never recite someone's profile back to the group.
- When someone states a lasting fact about themselves, call remember_fact
  FIRST, before send_message: sending ends your turn, so anything after it is
  lost. In a group, anyone can text you directly and say "profile" to set theirs up.
- Only add someone to the match pool when they themselves asked to join.
- Pairing people up ("find me someone to climb with") is for direct chats:
  find_matches, then request_intro. When they told you to go ahead ("put me
  with them", "set it up", "just pick") or one candidate is clearly the best
  fit, call request_intro for the top candidate in the SAME turn, without asking
  again; only ask "which one?" when they wanted to choose or the fits are close.
  Describe candidates WITHOUT identifying them: you never learn or share a name
  or number. Be plain about how it works: you have asked the other person, and
  the group chat opens the moment they say yes; you cannot add anyone to a chat
  who has not agreed. When they name a place ("anyone in Vancouver?"), pass it
  as near. If asked in a group, tell them to text you directly.
- In a group you sleep while people talk among themselves, and are woken only
  when someone @mentions you, replies to one of your messages, or answers a
  question you asked. You have still read everything said while you slept — use
  it, and do not ask for anything the group already said. When woken with a
  request, start by confirming what you understood in one line.
- If, despite being woken, there is truly nothing for you to do, reply with
  exactly NOOP and nothing else.`;

const MAX_STEPS = 8;
/**
 * Tools that only fetch over the network and do not care what ran before them
 * in the same step. Anything that speaks, posts a card or edits the plan stays
 * out: those are read in order by the group and guarded in order by the turn.
 */
const CONCURRENT_TOOLS = new Set<string>(["shop_search", "find_matches"]);
/** The bubble lasts ~85s per call; Linq says to refresh every 60. */
const TYPING_REFRESH_MS = 55_000;
const HISTORY_LIMIT = 40;
const NUDGE_AFTER_SECONDS = 20 * 60;
const MAX_SENDS_PER_TURN = 3;
/** After this long a card has scrolled out of sight, so it is posted again rather than edited in place. */
const CARD_STALE_MS = 20 * 60 * 1000;
const EVENT_HISTORY = 300;
/** A run that has not reported back by now is treated as lost, so the chat is not stuck. */
/**
 * After asking the group something, un-addressed messages wake the agent for a
 * while, since people answer a question without @mentioning. The window closes
 * when the agent next speaks. It is capped because side chatter lands in it too,
 * and each of those wakes is a model call that ends in silence.
 */
const ANSWER_WINDOW_MS = 3 * 60 * 1000;
const ANSWER_WINDOW_MAX_WAKES = 3;
const RESEARCH_STALE_MS = 15 * 60 * 1000;
/** A healthy run reports a stage every few seconds to a couple of minutes. */
const RESEARCH_SILENCE_LIMIT_MS = 3 * 60 * 1000;
const RESEARCH_WATCHDOG_SECONDS = 60;

type Row = Record<string, string | number | boolean | null>;

/**
 * One instance per iMessage group chat, named by the Linq chat id. Public plan
 * state lives in `this.state` and is pushed to every open vote page over
 * WebSocket; anything private (transcript, handles, who voted for what) lives
 * in this object's own SQLite database and never leaves the server.
 */
export class PlanAgent extends Agent<Env, PlanState> {
  initialState: PlanState = EMPTY_PLAN;

  /** Set when something worth celebrating just happened; consumed by the next text sent. */
  private celebrateNextSend = false;
  private turnRunning = false;
  private turnRequested = false;
  /** When the typing bubble was last raised; 0 once a send has cleared it. */
  private typingAt = 0;

  /**
   * Mirrors this chat's events into the cross-chat run history, grouped into
   * turns. Lazy because it needs `this.name`, which is not set at field-init
   * time. Writes go out through waitUntil, so a turn never waits on them.
   */
  private runs?: RunRecorder;
  private recorder() {
    return (this.runs ??= new RunRecorder(this.env, this.name, (promise) => this.ctx.waitUntil(promise)));
  }

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linq_id TEXT UNIQUE,
      direction TEXT NOT NULL,
      author TEXT,
      body TEXT,
      ts INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS participants (handle TEXT PRIMARY KEY, name TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS votes (
      voter TEXT PRIMARY KEY, option_id TEXT NOT NULL, source TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`;
    this.sql`CREATE TABLE IF NOT EXISTS research (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      ok INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, report TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS product_names (variant_id TEXT PRIMARY KEY, name TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS shots (id TEXT PRIMARY KEY, jpeg TEXT NOT NULL, ts INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL, message_id TEXT, ts INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS rsvps (handle TEXT PRIMARY KEY, answer TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      level TEXT NOT NULL, event TEXT NOT NULL, fields TEXT NOT NULL
    )`;
  }

  /**
   * Message bodies and model reasoning for the run viewer, when LOG_BODIES is
   * on. Run history is served over HTTP, so switching this on means it holds
   * what real people wrote in their group chat, not just how long it was.
   * Handles stay masked either way.
   */
  private body(text: string, key = "text"): Fields {
    if ((this.env as { LOG_BODIES?: string }).LOG_BODIES !== "true") return {};
    return { [key]: text.slice(0, 2000) };
  }

  /**
   * Logs to the console *and* to this chat's own event history. The console
   * scrolls away and `wrangler tail` only shows what happens while you watch;
   * the history answers "what did the agent do with that message an hour ago?"
   * via GET /api/dev/logs?chat=<id>, and feeds the run viewer at /runs.
   */
  private note = (level: Level, event: string, fields: Fields = {}) => {
    log(level, "agent", event, { chat: short(this.name), ...fields });
    this.recorder().record(level, event, fields);
    this.sql`INSERT INTO events (ts, level, event, fields) VALUES (${Date.now()}, ${level}, ${event}, ${JSON.stringify(fields)})`;
    this.sql`DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ${EVENT_HISTORY}`;
  };

  // ---------------------------------------------------------------- ingress
  // Called over RPC by the webhook Worker. These return quickly: the slow
  // agent turn is handed to the scheduler so Linq gets its 200 immediately.

  async ingestMessage(msg: {
    linqId: string;
    from: string;
    text: string;
    isGroup?: boolean;
    /** Linq marks each @mention with is_me, so no name or wake word is involved. */
    mentionsMe?: boolean;
    /** Id of the message this one replies to, if it is an inline reply. */
    replyToId?: string;
  }) {
    const seen = this.sql<Row>`SELECT 1 FROM messages WHERE linq_id = ${msg.linqId}`;
    if (seen.length) {
      this.note("info", "message.duplicate", { linqId: short(msg.linqId) }); // Linq retries webhooks
      return;
    }

    if (msg.isGroup !== undefined) this.setMeta("is_group", msg.isGroup ? "1" : "0");
    this.sql`INSERT OR IGNORE INTO participants (handle) VALUES (${msg.from})`;
    this.sql`INSERT INTO messages (linq_id, direction, author, body, ts)
             VALUES (${msg.linqId}, 'in', ${msg.from}, ${msg.text}, ${Date.now()})`;

    // Every message is remembered, but only one addressed to the agent wakes the
    // model. Group chatter costs no tokens and draws no interjections; when the
    // agent is finally called on, the whole conversation is already in its memory.
    const wake = this.wakeReason(msg);
    this.note("info", wake ? "message.in" : "message.stored", {
      from: mask(msg.from),
      chars: msg.text.length,
      group: msg.isGroup,
      ...(wake ? { wake } : {}),
      ...this.body(msg.text),
    });
    if (!wake) return;

    // Seen, and thinking: the model is seconds away, the bubble is not. Off the
    // request path so Linq still gets its 200 at once.
    this.ctx.waitUntil(this.acknowledge());

    // The profile link is private, so it only ever goes to a direct chat: on
    // request, or once on its own when onboarding finishes.
    if (msg.isGroup === false) {
      if (/^\s*(my\s+)?profile\b/i.test(msg.text)) await this.sendProfileLink();

      // Payment setup is handled here, in code, and never by the model: it is
      // the one flow where a misread intent or an invented step costs someone
      // money or trust. The model only ever tells people the words to text.
      if (await this.handlePaymentSetup(msg)) return;
      // A promise made to the person ("say forget my links"), so it is kept in
      // code rather than left to the model to interpret.
      if (/\bforget (my )?(links|socials|insta(gram)?)\b/i.test(msg.text)) {
        await peopleStore(this.env).save(msg.from, { links: [], online: undefined, onlineReadOf: undefined });
        this.note("info", "links.forgotten", { who: mask(msg.from) });
        await this.say("done. your links and what i read from them are gone");
        return;
      }

    }

    // A short delay batches a burst of texts into a single turn.
    await this.schedule(2, "runTurn");
  }

  /** Why this message should wake the model, or null to stay asleep. */
  private wakeReason(msg: { isGroup?: boolean; mentionsMe?: boolean; replyToId?: string }): string | null {
    if (this.getMeta("is_group") !== "1") return "direct chat";
    if (msg.mentionsMe) return "mention";
    if (msg.replyToId && this.isOwnMessage(msg.replyToId)) return "reply";
    if (Date.now() < Number(this.getMeta("awaiting_answer_until") ?? 0)) {
      const wakes = Number(this.getMeta("awaiting_answer_wakes") ?? 0) + 1;
      this.setMeta("awaiting_answer_wakes", String(wakes));
      if (wakes >= ANSWER_WINDOW_MAX_WAKES) this.setMeta("awaiting_answer_until", "0");
      return "answer";
    }
    return null;
  }

  /** True for anything the agent posted: texts, and every id a card has had. */
  private isOwnMessage(id: string) {
    if (this.cardIds().includes(id)) return true;
    // Each store's pay card has its own id, kept under that store's key.
    if (this.carts().some((c) => id === this.getMeta(`cart_message_id:${shopKey(c.shop)}`))) return true;
    return this.sql<Row>`SELECT 1 FROM messages WHERE linq_id = ${id} AND direction = 'out'`.length > 0;
  }

  async ingestReaction(r: { messageId: string; from: string; reactionType: string }) {
    // Every redraw gives the card a new message id, and a tapback can land on
    // whichever one the reacting phone last saw — so match all of them.
    // A thumbs up or down on the open Who's in ticket is an RSVP, not a vote.
    const onRsvp = this.sql<Row>`SELECT 1 FROM tickets WHERE kind = 'rsvp' AND message_id = ${r.messageId}`.length > 0;
    if (onRsvp && this.getMeta("rsvp_open") === "1") {
      const answer = r.reactionType === "like" || r.reactionType === "love" ? "in" : r.reactionType === "dislike" ? "out" : null;
      if (!answer) return void this.note("info", "reaction.ignored", { reason: "not an rsvp tapback", type: r.reactionType });
      this.sql`INSERT OR IGNORE INTO participants (handle) VALUES (${r.from})`;
      await this.recordRsvp(r.from, answer, "reaction");
      return;
    }
    if (!this.cardIds().includes(r.messageId)) {
      this.note("info", "reaction.ignored", { reason: "not on the plan card", type: r.reactionType });
      return;
    }
    // Someone who tapbacks is in the chat even if they have never texted, so
    // they belong in the "n of m voted" denominator.
    this.sql`INSERT OR IGNORE INTO participants (handle) VALUES (${r.from})`;
    const option = this.state.options[REACTION_SLOTS.indexOf(r.reactionType as never)];
    if (!option) {
      this.note("info", "reaction.ignored", { reason: "no option in that slot", type: r.reactionType });
      return;
    }
    await this.castVote(option.id, r.from, "reaction");
  }

  /** Called from the vote page over the agent WebSocket. */
  @callable()
  async vote(optionId: string, voter: string) {
    if (!this.state.options.some((o) => o.id === optionId)) throw new Error("unknown option");
    await this.castVote(optionId, `web:${voter}`, "web");
  }

  private async castVote(optionId: string, voter: string, source: string) {
    if (this.state.status !== "voting") {
      this.note("info", "vote.ignored", { reason: `plan is ${this.state.status}`, source });
      return;
    }
    this.note("info", "vote.cast", { voter: source === "web" ? "web" : mask(voter), optionId, source });
    this.sql`INSERT INTO votes (voter, option_id, source) VALUES (${voter}, ${optionId}, ${source})
             ON CONFLICT(voter) DO UPDATE SET option_id = excluded.option_id, source = excluded.source`;
    this.publish({});
    await this.syncCard();
    // The card already shows the running tally, so a vote only deserves the
    // model's attention (and tokens) once it settles the question.
    if (this.state.awaiting.length === 0) {
      this.setMeta("turn_reason", "votes_in");
      await this.schedule(2, "runTurn");
    }
  }

  // ------------------------------------------------------------------ state

  private getMeta(key: string): string | undefined {
    const rows = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`;
    return rows[0]?.value;
  }

  private setMeta(key: string, value: string) {
    this.sql`INSERT INTO meta (key, value) VALUES (${key}, ${value})
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  private participants() {
    return this.sql<{ handle: string; name: string | null }>`SELECT handle, name FROM participants`;
  }

  /** Transcript label: a remembered name, else the last four digits. */
  private label(handle: string | null, people = this.participants()) {
    if (!handle) return "someone";
    return people.find((p) => p.handle === handle)?.name ?? `…${handle.slice(-4)}`;
  }

  /** Recomputes the derived fields and pushes the new state to every client. */
  private publish(patch: Partial<PlanState>) {
    const next = { ...this.state, ...patch };
    const votes = this.sql<{ voter: string; option_id: string }>`SELECT voter, option_id FROM votes`;
    const people = this.participants();
    const voted = new Set(votes.map((v) => v.voter));

    this.setState({
      ...next,
      counts: Object.fromEntries(
        next.options.map((o) => [o.id, votes.filter((v) => v.option_id === o.id).length]),
      ),
      awaiting:
        next.status === "voting"
          ? people.filter((p) => !voted.has(p.handle)).map((p) => this.label(p.handle, people))
          : [],
      version: this.state.version + 1,
    });
  }

  /** All message ids the plan card has had, newest last. */
  private cardIds(): string[] {
    return JSON.parse(this.getMeta("card_message_ids") ?? "[]");
  }

  /** Records the card's current id. Linq issues a new one on every redraw. */
  private rememberCardId(id: string) {
    this.setMeta("card_message_id", id);
    this.setMeta("card_message_ids", JSON.stringify([...this.cardIds().filter((x) => x !== id), id].slice(-30)));
  }

  private async syncCard() {
    const messageId = this.getMeta("card_message_id");
    if (!messageId) return;
    // A failed redraw must not abort the turn that caused it; timed() records it.
    const newId = await timed("agent", "card.update", { version: this.state.version }, () =>
      updateCard(this.env, messageId, this.name, this.state, this.participants().length),
      this.note,
    ).catch(() => undefined);
    if (newId) this.rememberCardId(newId);
  }

  // ---------------------------------------------------------------- tickets
  // Every card the agent shows is a ticket (see card.ts). It is stored here,
  // rendered on demand at /card/<chat>?t=<id>, and sent as a photo.

  /** Called over RPC by the /card route. */
  async getTicket(id: string): Promise<Ticket | null> {
    const row = this.sql<{ json: string }>`SELECT json FROM tickets WHERE id = ${id}`[0];
    return row ? (JSON.parse(row.json) as Ticket) : null;
  }

  /** Posts a ticket photo. Never worth failing a turn over. */
  private async postTicket(kind: string, ticket: Ticket): Promise<string | undefined> {
    const id = crypto.randomUUID().slice(0, 12);
    this.sql`INSERT INTO tickets (id, kind, json, ts) VALUES (${id}, ${kind}, ${JSON.stringify(ticket)}, ${Date.now()})`;
    this.sql`DELETE FROM tickets WHERE ts < ${Date.now() - 7 * 24 * 3600 * 1000}`;
    const url = `${this.env.PUBLIC_BASE_URL}/card/${encodeURIComponent(this.name)}?t=${id}`;
    const messageId = await timed("agent", "ticket.out", { kind, tone: ticket.tone, id }, () => sendPhoto(this.env, this.name, url), this.note).catch(
      () => undefined,
    );
    if (messageId) this.sql`UPDATE tickets SET message_id = ${messageId} WHERE id = ${id}`;
    return messageId;
  }

  /**
   * The plan ticket goes out when the ballot actually changes and when the
   * booking lands — not on every propose_plan, which models call freely.
   */
  private async planTicketIfNew() {
    const key = this.state.status === "booked" ? `booked:${this.state.chosenOptionId}` : this.state.options.map((o) => o.title).join("|");
    // The same ballot is not posted twice in a row — but a ballot posted a while
    // ago is far up the thread by now, and re-proposing it means "show me again".
    const fresh = Date.now() - Number(this.getMeta("plan_ticket_at") ?? 0) < CARD_STALE_MS;
    if (this.getMeta("plan_ticket_key") === key && fresh) return;
    this.setMeta("plan_ticket_key", key);
    this.setMeta("plan_ticket_at", String(Date.now()));
    await this.postTicket("plan", planTicket(this.state));
  }

  /**
   * The harness sends the link, not the model: a turn ends at its first sent
   * message, so a link that depends on the model remembering never goes out.
   */
  private async sendProfileLink(intro = ""): Promise<boolean> {
    const person = this.participants()[0];
    if (!person) return false;
    const token = await peopleStore(this.env).tokenFor(person.handle);
    await this.say(`${intro}${this.env.PUBLIC_BASE_URL}/p/${token}`);
    this.setMeta("profile_link_sent", "1");
    return true;
  }

  /** Scheduler callback: once per direct chat, right after onboarding finishes. */
  /**
   * "set up payments" starts Linq's connect ceremony for the person texting, in
   * their own direct chat; the code Linq sends them, typed back here, finishes
   * it. Returns true when the message was part of this flow and is fully dealt
   * with. Setup only: connecting lets the agent ASK for a payment later, and
   * every purchase still needs that person's passkey.
   */
  private async handlePaymentSetup(msg: { linqId: string; from: string; text: string }): Promise<boolean> {
    const pending = this.getMeta("pay_connect_id");
    const code = msg.text.match(/^\s*(\d{4,8})\s*$/)?.[1];

    if (pending && code) {
      // A one-time code has no business in the transcript the model reads.
      this.sql`UPDATE messages SET body = '[verification code]' WHERE linq_id = ${msg.linqId}`;
      try {
        const done = await verifyPayments(this.env, this.name, msg.from, pending, code);
        if (done.status !== "connected") throw new Error(`status ${done.status}`);
        this.setMeta("pay_connect_id", "");
        await peopleStore(this.env).save(msg.from, { payments: "connected" });
        this.note("info", "payments.connected", { who: mask(msg.from) });
        await this.say("you're connected. one more step: add a card below. i can only ever charge it for things you approve, one at a time", { screenEffect: "confetti" });
        await timed("agent", "payments.attach_card", {}, () => sendAttachCard(this.env, this.name), this.note).catch(() => undefined);
      } catch (err) {
        this.note("warn", "payments.verify_failed", errorFields(err));
        await this.say("that code didn't work. it may have expired. text \"set up payments\" to get a new one");
        this.setMeta("pay_connect_id", "");
      }
      return true;
    }

    if (/\b(set ?up|connect|add) (my |a )?(payments?|card|wallet)\b/i.test(msg.text)) {
      try {
        const now = await paymentConnection(this.env, this.name, msg.from);
        if (now.status === "connected") {
          await peopleStore(this.env).save(msg.from, { payments: "connected" });
          await this.say("you're already connected. here's the card to add or change your payment method");
          await sendAttachCard(this.env, this.name).catch(() => undefined);
          return true;
        }
        const started = await connectPayments(this.env, this.name, msg.from);
        if (!started.connectId) throw new Error(`no connect id (status ${started.status})`);
        this.setMeta("pay_connect_id", started.connectId);
        this.note("info", "payments.connect_started", { who: mask(msg.from) });
        await this.say("sending you a code now. text it back here and you're connected. nothing is charged by setting this up");
      } catch (err) {
        this.note("error", "payments.connect_failed", errorFields(err));
        await this.say("couldn't start payment setup just now. try again in a bit");
      }
      return true;
    }

    if (/\b(remove|disconnect|forget) (my )?(payments?|card|wallet)\b/i.test(msg.text)) {
      await revokePayments(this.env, this.name, msg.from).catch((err: unknown) => this.note("warn", "payments.revoke_failed", errorFields(err)));
      await peopleStore(this.env).save(msg.from, { payments: undefined });
      this.note("info", "payments.revoked", { who: mask(msg.from) });
      await this.say("done. i can no longer request payments from you. your card in the wallet itself is yours to remove");
      return true;
    }
    return false;
  }

  /**
   * Form-first onboarding: right after the agent's first reply in a new direct
   * chat, a tappable card offers the whole profile as one 30-second form. The
   * conversation stays as the other way in — someone who just keeps texting is
   * asked one question at a time, exactly as before.
   */
  private async offerProfileCard() {
    if (this.getMeta("is_group") !== "0" || this.getMeta("profile_card_sent") === "1") return;
    if (this.getMeta("profile_card_hold") === "1") {
      this.setMeta("profile_card_hold", "");
      return;
    }
    const person = this.participants()[0];
    if (!person) return;
    const store = peopleStore(this.env);
    const profile = (await store.getMany([person.handle]))[person.handle];
    if (!missingFields(profile).length) return; // nothing left to ask
    this.setMeta("profile_card_sent", "1");

    const token = await store.tokenFor(person.handle);
    await store.save(person.handle, { dmChat: this.name });
    const id = await timed(
      "agent",
      "profile_card.out",
      {},
      () =>
        sendLinkCard(this.env, this.name, {
          title: "Set up your profile",
          subtitle: "30 seconds, so plans fit you. Or just answer here.",
          button: "Open",
          url: `${this.env.PUBLIC_BASE_URL}/p/${token}`,
        }),
      this.note,
    ).catch(() => undefined);
    if (id) {
      this.sql`INSERT INTO messages (linq_id, direction, body, ts) VALUES (${id}, 'out', ${"[profile card]"}, ${Date.now()})`;
      // The card carries the link, so the plain-text copy after onboarding is not needed.
      this.setMeta("profile_link_sent", "1");
    }
  }

  /**
   * Scheduler callback, direct chats only: read the links this person shared
   * about themselves and keep a few interests on their profile. Runs when links
   * are given in conversation or saved on the form, and only when they changed.
   *
   * Two rules hold the line here. The only links ever read are the ones on the
   * person's OWN profile, in their OWN chat — never a handle lifted from a group
   * or supplied by someone else. And they are told what was read, in plain
   * words, so none of it is a surprise later.
   */
  async enrichFromLinks() {
    if (this.getMeta("is_group") !== "0") return;
    const person = this.participants()[0];
    if (!person) return;
    const store = peopleStore(this.env);
    const profile = (await store.getMany([person.handle]))[person.handle];
    const signature = (profile?.links ?? []).join("|");
    if (!profile || !signature || profile.onlineReadOf === signature) return;

    const started = Date.now();
    const found = await readLinks(this.env, profile.links);
    this.note("info", "links.read", { read: found.read, skipped: found.skipped, interests: found.interests.length, notes: found.notes.length, tokens: found.tokens, ms: Date.now() - started });

    const saved = await store.save(person.handle, {
      onlineReadOf: signature,
      online: found.interests.length || found.notes.length
        ? { interests: found.interests, line: found.line, notes: found.notes, from: found.read }
        : undefined,
    });
    await syncMatchPool(this.env, person.handle, saved);

    if (found.interests.length) {
      await this.say(`had a look at your ${found.read.join(" and ")}: ${found.interests.slice(0, 4).join(", ")}. i'll plan with that in mind. say "forget my links" if you'd rather i didn't`);
    } else if (found.skipped.some((k) => k.why === "private")) {
      await this.say("your instagram's private, so i left it alone");
    }
    // Anything else (a login wall, a dead link) is ours to deal with, not theirs to hear about.
  }

  // ------------------------------------------------------------------ intros
  // The cross-chat half of pairing (see intros.ts). Each of these runs on a
  // different chat's agent than the one whose tool call caused it.

  /** B's direct chat: someone wants to meet them. Asked by code, answered through the model (answer_intro). */
  async introAsk(intro: Intro) {
    this.setMeta("pending_intro", intro.id);
    this.setMeta("pending_intro_common", intro.common.map((c) => c.text).join(", "));
    this.setMeta("pending_intro_at", String(intro.created));
    this.note("info", "intro.asked", { intro: intro.id });
    await this.say(askText(intro));
  }

  /** A's direct chat: the answer came back. `chat` is the new group chat, or null for a no. */
  async introAnswered(intro: Intro, chat: string | null) {
    this.note("info", "intro.answered", { intro: intro.id, accepted: Boolean(chat) });
    await this.schedule(ANSWER_RELAY_SECONDS, "relayIntroAnswer", { accepted: Boolean(chat) });
  }

  /** Scheduler callback. */
  async relayIntroAnswer(payload?: { accepted?: boolean }) {
    await this.say(payload?.accepted ? "they said yes. i've put you two in a group chat, go say hi" : declinedText);
  }

  /** Scheduler callback on the asker's chat, INTRO_TTL after asking: close the loop if nobody answered. */
  async introExpired(payload?: { id?: string }) {
    const store = peopleStore(this.env);
    const intro = payload?.id ? await store.getIntro(payload.id) : null;
    // getIntro already reports an over-age pending ask as expired.
    if (!intro || intro.status !== "expired") return;
    await store.updateIntro(intro.id, { status: "expired" });
    this.note("info", "intro.expired", { intro: intro.id });
    await this.say(expiredText);
  }

  /** The new group chat: remember who is in it and post the introduction ticket. */
  async introOpened(intro: Intro, a: string, b: string) {
    this.setMeta("is_group", "1");
    for (const [handle, name] of [[intro.from, a], [intro.to, b]] as const) {
      this.sql`INSERT OR IGNORE INTO participants (handle, name) VALUES (${handle}, ${name === "someone" ? null : name})`;
    }
    this.note("info", "intro.opened", { intro: intro.id });
    await this.postTicket("match", matchTicket(a, b, intro.common));
  }

  private pendingIntroContext() {
    const id = this.getMeta("pending_intro");
    if (!id) return "";
    if (Date.now() - Number(this.getMeta("pending_intro_at") ?? 0) > INTRO_TTL_MS) {
      this.setMeta("pending_intro", ""); // nobody answered in time; the asker has been told
      return "";
    }
    return ` PENDING INTRODUCTION: you asked this person whether they want to be introduced to someone who shares: ${this.getMeta("pending_intro_common")}. If their latest message answers that, call answer_intro FIRST. If they ask who it is, you do not know and cannot say until they agree.`;
  }

  /** Called by the profile form when it is saved. */
  async profileSaved(name?: string) {
    await this.schedule(3, "enrichFromLinks"); // no-op unless the links changed
    // A double-tapped Save posts the form several times within a second or two;
    // one save deserves one text.
    const recent = Date.now() - Number(this.getMeta("profile_ack_at") ?? 0) < 60_000;
    this.note("info", "profile.saved_via_form", recent ? { ack: "skipped, just sent" } : {});
    if (recent) return;
    this.setMeta("profile_ack_at", String(Date.now()));
    await this.say(`got it${name ? `, ${name}` : ""}. add me to any group chat and @ me when you want something planned`);
  }

  async offerProfile() {
    if (this.getMeta("is_group") !== "0" || this.getMeta("profile_link_sent") === "1") return;
    await this.sendProfileLink("change any of that here, anytime:\n");
  }

  /** What each person has told us about themselves, for the turn's context. */
  private async aboutPeople(
    people: { handle: string; name: string | null }[],
    direct: boolean,
  ): Promise<{ text: string; onboarding: string }> {
    const profiles = await peopleStore(this.env)
      .getMany(people.map((p) => p.handle))
      .catch((err) => {
        this.note("warn", "people.unavailable", errorFields(err));
        return {} as Awaited<ReturnType<ReturnType<typeof peopleStore>["getMany"]>>;
      });
    // A name given on the profile page counts as being told it.
    for (const p of people) {
      const name = profiles[p.handle]?.name;
      if (name && !p.name) {
        this.sql`UPDATE participants SET name = ${name} WHERE handle = ${p.handle}`;
        p.name = name;
      }
    }
    const lines = people
      .map((p) => [this.label(p.handle, people), profiles[p.handle] ? profileLines(profiles[p.handle]) : ""] as const)
      .filter(([, line]) => line)
      .map(([who, line]) => `\n- ${who}: ${line}`);
    const text = lines.join("") || "nothing yet";

    if (!direct) {
      // The bot cannot open a DM with someone who has never texted it, so in a
      // group the most it can do is say where onboarding happens.
      const strangers = people.filter((p) => missingFields(profiles[p.handle]).length > 3).map((p) => this.label(p.handle, people));
      return {
        text: strangers.length
          ? `${text}\nNo profile yet: ${strangers.join(", ")}. At most once in this chat, and only when it fits, mention that anyone can text you directly to set up a profile so plans suit them. If the transcript shows you already said it, never repeat it.`
          : text,
        onboarding: "",
      };
    }

    // Onboarding. The harness decides what is still missing; the model only
    // words the next question, so it cannot loop or skip ahead.
    const me = people[0];
    const missing = me ? missingFields(profiles[me.handle]) : [];
    if (!missing.length) {
      return { text, onboarding: "" };
    }
    const first = missing.length === ONBOARDING.length;
    return {
      text,
      onboarding: `\nOnboarding: still unknown about this person, in order: ${missing.map((m) => `${m.key} (${m.ask})`).join("; ")}.
- First call save_profile with everything their latest message answered — one message can answer several — and put anything they declined in skipped. "skip", "pass" or "rather not" means skipped. Then send_message.
- ${first ? "This is your first exchange: say in one line who you are (a planner they can add to group chats) and that a few quick questions will make plans fit them, then ask the first one. A tappable profile card appears right under your message, so add in a few words that they can tap it to do it all at once, or just answer here." : "Ask only the next unknown item, as one short friendly question. No lists, no preamble."}
- If they asked for something else instead, help with that and leave onboarding for later. Never ask about an item that is not in the unknown list.`,
    };
  }

  // ------------------------------------------------------------ shopping list

  /**
   * Records a cart and puts its card in the thread — posting the first time,
   * redrawing in place after that. Shared by the shop tool and by an edit made
   * from the run viewer, so the two cannot drift apart.
   *
   * The items are logged with their variant ids: that is what lets the viewer
   * send the same cart back with different quantities.
   */
  private async postCartCard(shop: string, mine: CartSummary): Promise<string | undefined> {
    this.note("info", "cart.updated", {
      shop,
      lines: mine.lines.length,
      total: mine.total,
      checkoutUrl: mine.checkoutUrl,
      imageUrl: mine.lines.find((l) => l.imageUrl)?.imageUrl,
      items: mine.lines.map((l) => ({
        variantId: l.variantId,
        title: l.title,
        quantity: l.quantity,
        price: l.price,
        imageUrl: l.imageUrl,
      })),
    });
    // The photo first, so the pay card lands directly under what it is for —
    // and the photo is of the things themselves. A drawn ticket saying "The
    // Sorbet" tells a group nothing; the bouquet does. Only photos not already
    // in the thread are sent, so editing a quantity does not repost them.
    const shown: string[] = JSON.parse(this.getMeta(`cart_photos:${shop}`) || "[]");
    const photos = [...new Set(mine.lines.map((l) => l.imageUrl).filter((u): u is string => Boolean(u)))];
    const fresh = photos.filter((u) => !shown.includes(u)).slice(0, 4);
    if (fresh.length) {
      const id = await timed("agent", "cart.photos", { shop, count: fresh.length }, () => sendPhotos(this.env, this.name, fresh.map((u) => sizedImage(u))), this.note).catch(
        () => undefined,
      );
      if (id) {
        const caption = `[photo: ${mine.lines.filter((l) => l.imageUrl && fresh.includes(l.imageUrl)).map((l) => l.title).join(", ")}]`;
        this.sql`INSERT INTO messages (linq_id, direction, body, ts) VALUES (${id}, 'out', ${caption}, ${Date.now()})`;
        this.setMeta(`cart_photos:${shop}`, JSON.stringify([...shown, ...fresh].slice(-20)));
      }
    } else if (!photos.length) {
      // A store with no product images still gets something to look at.
      await this.postTicket("cart", cartTicket(mine, this.headcount()));
    }

    const messageId = this.getMeta(`cart_message_id:${shop}`);
    if (messageId) {
      // updateCard returns the card's new id; the old one is dead after a redraw.
      const newId = await timed("agent", "cart.update", { shop, version: this.state.version }, () =>
        updateCard(this.env, messageId, this.name, this.state, 0, "cart", shop),
        this.note,
      ).catch(() => undefined);
      if (newId) this.setMeta(`cart_message_id:${shop}`, newId);
    } else {
      const id = await sendCard(this.env, this.name, this.name, this.state, 0, "cart", shop);
      this.setMeta(`cart_message_id:${shop}`, id);
    }
    // Empty the first time round: the caller uses it to say "posted" vs "redrawn".
    return messageId || undefined;
  }

  /**
   * Change a cart's quantities from the run viewer. This is a person acting
   * inside the group's chat from outside it: the store cart is rewritten, the
   * card in the thread is redrawn, and the checkout link changes. Gated by
   * RUNS_TOKEN at the route, and a quantity of 0 drops that line.
   */
  async editCart(shop: string, lines: { variantId: string; quantity: number }[]) {
    const key = shopKey(shop);
    const wanted = lines.filter((l) => l.variantId && l.quantity > 0);
    if (!wanted.length) return { ok: false, detail: "a cart needs at least one line" };

    const cart = await setCart(this.env, key, wanted, this.getMeta(`cart_id:${key}`) || undefined);
    this.setMeta(`cart_id:${key}`, cart.id);
    if (!cart.lines.length) return { ok: false, detail: cart.messages.join("; ") || "the store rejected every line" };

    const mine = { shop: key, checkoutUrl: cart.checkoutUrl, total: cart.total, lines: cart.lines };
    const before = this.carts();
    const at = before.findIndex((c) => shopKey(c.shop) === key);
    this.saveCarts(at === -1 ? [...before, mine] : before.map((c, i) => (i === at ? mine : c)));
    this.note("info", "cart.edited", { shop: key, lines: mine.lines.length, total: mine.total, source: "run-viewer" });
    await this.postCartCard(key, mine);
    return { ok: true, total: mine.total, lines: mine.lines.length };
  }

  /** Every store's cart. Reads pre-multi-store state (a single `cart`) too. */
  private carts(): CartSummary[] {
    return cartsOf(this.state);
  }

  /** Writing carts also retires the legacy single-cart field for good. */
  private saveCarts(carts: CartSummary[]) {
    this.publish({ carts, cart: undefined });
  }

  /**
   * Who a cost is split across: the people who said they are in, once anyone
   * has; until then everyone in the chat.
   */
  private headcount(): number {
    const going = this.rsvps().going.length;
    return going || this.participants().length;
  }

  /** One line for tool results: what the whole list looks like now. */
  private shoppingListLine(): string {
    const carts = this.carts();
    if (!carts.length) return "Shopping list: empty.";
    const sum = cartsTotal(carts);
    const people = this.headcount();
    const total = sum ? `${sum.symbol}${sum.amount.toFixed(2)}` : "mixed currencies, not summed";
    const split = sum && people > 1 ? `, ${sum.symbol}${(sum.amount / people).toFixed(2)} each across ${people}` : "";
    return `Shopping list: ${carts.length} store${carts.length === 1 ? "" : "s"}, ${total}${split}. ${carts
      .map((c) => `${c.shop} ${c.total}${c.paidBy ? ` (paid by ${c.paidBy})` : " (unpaid)"}`)
      .join("; ")}.`;
  }

  /** The full list for the model's turn context: every store, item and total. */
  private shoppingListContext(): string {
    const carts = this.carts();
    if (!carts.length) return "empty";
    return `${this.shoppingListLine()} Items — ${carts
      .map((c) => `${c.shop}: ${c.lines.map((l) => `${l.quantity}x ${l.title} @ ${l.price}`).join(", ")}`)
      .join(" | ")}`;
  }

  /** What the model is told about headcount, so quantities can be sized to it. */
  private headcountContext(): string {
    const r = this.rsvps();
    const asked = r.going.length + r.out.length > 0 || this.getMeta("rsvp_open") === "1";
    if (!asked) return `not asked yet; ${this.participants().length} in the chat`;
    return `${r.going.length} in${r.going.length ? ` (${r.going.join(", ")})` : ""}, ${r.out.length} out, ${r.waiting.length} no reply — ${r.locked ? "LOCKED" : "still open"}`;
  }

  private rsvps(): Rsvps {
    const people = this.participants();
    const answers = new Map(this.sql<{ handle: string; answer: string }>`SELECT handle, answer FROM rsvps`.map((r) => [r.handle, r.answer]));
    const names = (want: string | undefined) => people.filter((p) => answers.get(p.handle) === want).map((p) => this.label(p.handle, people));
    return {
      title: this.getMeta("rsvp_title") || "Who's in?",
      when: this.getMeta("rsvp_when") || undefined,
      going: names("in"),
      out: names("out"),
      waiting: names(undefined),
      locked: this.getMeta("rsvp_open") !== "1",
    };
  }

  private async recordRsvp(handle: string, answer: "in" | "out", source: string) {
    this.sql`INSERT INTO rsvps (handle, answer) VALUES (${handle}, ${answer})
             ON CONFLICT(handle) DO UPDATE SET answer = excluded.answer`;
    this.note("info", "rsvp", { from: mask(handle), answer, source });
    // Photos cannot redraw, so nothing is posted per answer — only the close.
    if (this.rsvps().waiting.length === 0) await this.lockHeadcount();
  }

  private async lockHeadcount() {
    if (this.getMeta("rsvp_open") !== "1") return;
    this.setMeta("rsvp_open", "0");
    await this.postTicket("rsvp", rsvpTicket(this.rsvps()));
  }

  /** Read receipt, typing bubble and — once per chat — the name and photo. */
  private async acknowledge() {
    // Each is "ok", "dry" or the error, so the run viewer shows what Linq said.
    const read = await markRead(this.env, this.name);
    const typing = await this.typing();
    const firstTime = this.getMeta("contact_card_shared") !== "1";
    const contactCard = firstTime ? await shareContactCard(this.env, this.name) : "already shared";
    // A failure (no card set up yet) is tried again at the next wake.
    if (contactCard === "ok" || contactCard === "dry") this.setMeta("contact_card_shared", "1");
    const failed = [read, typing, contactCard].some((r) => !["ok", "dry", "fresh", "already shared"].includes(r));
    this.note(failed ? "warn" : "info", "presence", { read, typing, contactCard });
  }

  /** Raises the bubble, or refreshes it before its ~85s runs out. */
  private async typing() {
    if (Date.now() - this.typingAt < TYPING_REFRESH_MS) return "fresh";
    this.typingAt = Date.now();
    return startTyping(this.env, this.name);
  }

  private async say(text: string, opts: SendOptions = {}) {
    this.setMeta("awaiting_answer_until", "0");
    this.typingAt = 0; // a send clears the bubble
    const id = await timed("agent", "message.out", { chars: text.length, ...this.body(text) }, () => sendText(this.env, this.name, text, opts), this.note);
    this.sql`INSERT INTO messages (linq_id, direction, body, ts) VALUES (${id}, 'out', ${text}, ${Date.now()})`;
  }

  // ------------------------------------------------------------- agent turn

  /**
   * Scheduler callback. Turns are serialised: a message that lands mid-turn
   * sets a flag and the loop goes round again, so the model never runs twice
   * concurrently over the same chat.
   */
  async runTurn() {
    if (this.turnRunning) {
      this.turnRequested = true;
      return;
    }
    this.turnRunning = true;
    try {
      do {
        this.turnRequested = false;
        await this.think();
      } while (this.turnRequested);
    } catch (err) {
      // Scheduler callbacks have no caller to report to; without this a crash
      // mid-turn is invisible.
      this.note("error", "turn.crashed", errorFields(err));
    } finally {
      this.turnRunning = false;
      // After the first reply, not before: the text introduces, the card offers the shortcut.
      await this.offerProfileCard().catch((err) => this.note("warn", "profile_card.failed", errorFields(err)));
      // A turn that ended in silence must not leave the bubble hanging.
      if (this.typingAt) {
        this.typingAt = 0;
        await stopTyping(this.env, this.name);
      }
    }
  }

  private async think() {
    const { client, model, profile } = llmFor(this.env);
    // Why this turn is running. A vote-triggered turn has a specific job; with
    // no stated purpose the model fills the silence with chatter.
    const reason = this.getMeta("turn_reason");
    const votesIn = reason === "votes_in";
    const availabilityIn = reason === "availability_in";
    this.setMeta("turn_reason", "");
    const people = this.participants();

    const history = this.sql<{ direction: string; author: string | null; body: string | null }>`
      SELECT direction, author, body FROM messages ORDER BY id DESC LIMIT ${HISTORY_LIMIT}`.reverse();
    const transcript = history
      .map((m) => `${m.direction === "in" ? this.label(m.author, people) : "you"}: ${m.body ?? ""}`)
      .join("\n");

    const direct = this.getMeta("is_group") === "0";
    const about = await this.aboutPeople(people, direct);

    // Carts get their own "Shopping list" line below, whatever the plan's status.
    const plan = this.state.status === "idle" ? "none yet" : JSON.stringify({ ...this.state, carts: undefined, cart: undefined });
    const research = this.researchContext();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `People in the chat: ${people.map((p) => this.label(p.handle, people)).join(", ")}
About the people: ${about.text}
Where the group is based: ${this.getMeta("area") || "UNKNOWN — nobody has said. Before any research, ask where they are; never assume a city, and do not reuse a location from an earlier search unless the group itself stated it."}
Current plan: ${plan}
Shopping list: ${this.shoppingListContext()}
Headcount: ${this.headcountContext()}
Research: ${research.text}
Now: ${new Date().toISOString()}
${
  availabilityIn
    ? `You were woken because the availability check just finished; each ballot option's real open times are in its availability field in the plan above, read from the venue's own booking page. Tell the group in one or two lines which options have which times, plainly, including any that have nothing open or could not be checked. Say nothing else.${this.getMeta("side_availability") ? ` Venues not on the ballot: ${this.getMeta("side_availability")}.` : ""}`
    : votesIn
    ? "You were woken because everyone has now voted, not because of a new message. Call get_votes, then name the winner in one line and ask whether to book it. If it is a tie, say so and ask the group to break it. Say nothing else."
    : this.getMeta("is_group") === "0"
      ? `This is a direct one-to-one chat, so every message is addressed to you: reply once rather than staying silent, then stop.${about.onboarding}${this.pendingIntroContext()}`
      : ""
}

Transcript (most recent last):
${transcript}`,
      },
    ];

    const started = Date.now();
    let tokens = 0;
    const toolsUsed: string[] = [];
    const end = (level: Level, outcome: string, extra: Fields = {}) =>
      this.note(level, "turn.end", { outcome, ms: Date.now() - started, tokens, tools: toolsUsed, ...extra });

    this.note("info", "turn.start", { llm: `${profile}/${model}`, history: history.length });
    let spoke = false;
    let reminded = false;
    let askedQuestion = false;
    let workSinceSend = 0;
    let sendsThisTurn = 0;
    const sentThisTurn = new Set<string>();
    for (let step = 0; step < MAX_STEPS; step++) {
      let res;
      if (!spoke) await this.typing();
      try {
        res = await client.chat.completions.create({ model, messages, tools: openAiTools() });
      } catch (err) {
        end("error", "llm_failed", { step, ...errorFields(err) });
        return;
      }
      tokens += res.usage?.total_tokens ?? 0;
      const reply = res.choices[0].message;
      messages.push(reply);

      const calls = (reply.tool_calls ?? []).filter((c) => c.type === "function");
      // What the model decided on this round trip. Its prose is reasoning, not
      // anything the group sees — text reaches the chat only through
      // send_message — so it is the closest thing to a record of its thinking.
      this.note("info", "turn.step", {
        step: step + 1,
        calls: calls.map((c) => c.function.name),
        ...(reply.content?.trim() && reply.content.trim() !== "NOOP"
          ? this.body(reply.content.trim(), "thinking")
          : {}),
      });
      if (calls.length === 0) {
        // Text reaches the chat only through send_message, never from raw
        // content: some models leak their reasoning into content, and that
        // must not be texted to a group. A model that answered in content
        // gets one reminder to send it properly.
        const text = reply.content?.trim();
        const wantsToSpeak = Boolean(text) && text !== "NOOP" && !spoke;
        if (wantsToSpeak && !reminded) {
          reminded = true;
          messages.push({
            role: "user",
            content:
              "That reply was NOT delivered: nobody in the chat saw it, because only send_message reaches them. If you meant it for the chat, call send_message now with exactly the words to send (one or two short lines, no reasoning). Reply NOOP only if you truly have nothing to say.",
          });
          continue;
        }
        if (wantsToSpeak) this.note("warn", "turn.content_dropped", { chars: text!.length });
        end("info", spoke ? "replied" : "silent", { steps: step + 1 });
        if (research.deliveredId) this.sql`UPDATE research SET delivered = 1 WHERE id = ${research.deliveredId}`;
        return;
      }

      const run = (call: (typeof calls)[number]) =>
        timed(
          "agent",
          "tool",
          // Arguments are useful for every tool except the one carrying message text.
          { tool: call.function.name, args: call.function.name === "send_message" ? "(text)" : call.function.arguments.slice(0, 300) },
          () => this.runTool(call.function.name, call.function.arguments),
          this.note,
        );
      // Lookups the model asked for together are fetched together: two stores
      // searched in one step should cost one wait, not two. Everything else
      // keeps its turn in the loop below, where order is the point.
      const early = new Map<string, Promise<string>>();
      if (calls.filter((c) => CONCURRENT_TOOLS.has(c.function.name)).length > 1) {
        for (const call of calls) {
          if (!CONCURRENT_TOOLS.has(call.function.name)) continue;
          const started = run(call);
          // The loop can end the turn before reaching this call; awaited or not, it must not go unhandled.
          started.catch(() => {});
          early.set(call.id, started);
        }
      }

      for (const call of calls) {
        let output: string;
        const tool = call.function.name;
        toolsUsed.push(tool);

        // A model that loses track can send the same line twice in one turn;
        // in a group chat that reads as a glitch, so the repeat is swallowed.
        // A model that keeps rephrasing its reply once sent eight messages in
        // twenty seconds, so a second text with NOTHING DONE since the first
        // ends the turn. But a text, then real work, then a text about that work
        // is legitimate — blocking it silently threw away a finished purse
        // search. So the test is whether any other tool ran in between, with a
        // ceiling on texts per turn as the backstop.
        if (tool === "send_message" && spoke && (workSinceSend === 0 || sendsThisTurn >= MAX_SENDS_PER_TURN)) {
          end("warn", "replied", { steps: step + 1, extraSendBlocked: true, reason: workSinceSend === 0 ? "nothing new to report" : "send ceiling" });
          if (research.deliveredId) this.sql`UPDATE research SET delivered = 1 WHERE id = ${research.deliveredId}`;
          return;
        }
        if (tool === "send_message") {
          const key = call.function.arguments.toLowerCase().replace(/[^a-z0-9]+/g, "");
          if (sentThisTurn.has(key)) {
            this.note("warn", "turn.duplicate_send_skipped", {});
            messages.push({ role: "tool", tool_call_id: call.id, content: "Already sent this turn. Do not repeat it." });
            continue;
          }
          sentThisTurn.add(key);
        }

        try {
          output = await (early.get(call.id) ?? run(call));
          if (tool !== "send_message") workSinceSend++;
          if (tool === "send_message") {
            spoke = true;
            sendsThisTurn++;
            workSinceSend = 0;
            // A question hands the conversation to the humans. There is nothing
            // left to do until they answer, so don't ask the model again — that
            // is exactly where it started rephrasing itself.
            if (/\?\s*$/.test(parseToolArgs("send_message", call.function.arguments).text)) askedQuestion = true;
          }
        } catch (err) {
          // Already logged by timed(). Bad arguments are the model's to fix; an
          // infrastructure failure is not, and retrying it only burns tokens.
          output =
            err instanceof ZodError
              ? `Invalid arguments, fix and retry: ${err.message.slice(0, 600)}`
              : `Failed: ${err instanceof Error ? err.message : String(err)}. This is a system problem, not your arguments. Do not call ${tool} again this turn.`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }

      if (askedQuestion) {
        this.setMeta("awaiting_answer_until", String(Date.now() + ANSWER_WINDOW_MS));
        this.setMeta("awaiting_answer_wakes", "0");
        end("info", "replied", { steps: step + 1, awaitingAnswer: true });
        if (research.deliveredId) this.sql`UPDATE research SET delivered = 1 WHERE id = ${research.deliveredId}`;
        return;
      }
    }
    end("warn", "max_steps");
    if (research.deliveredId) this.sql`UPDATE research SET delivered = 1 WHERE id = ${research.deliveredId}`;
  }

  private async runTool(name: string, rawArgs: string): Promise<string> {
    if (!(name in toolSchemas)) return `Unknown tool: ${name}`;

    switch (name as ToolName) {
      case "send_message": {
        const { text } = parseToolArgs("send_message", rawArgs);
        const celebrate = this.celebrateNextSend;
        this.celebrateNextSend = false;
        await this.say(text, celebrate ? { screenEffect: "confetti" } : {});
        return "sent";
      }

      case "remember_area": {
        const { area } = parseToolArgs("remember_area", rawArgs);
        this.setMeta("area", area.slice(0, 120));
        return "remembered";
      }

      case "remember_name": {
        const { who, name: goesBy } = parseToolArgs("remember_name", rawArgs);
        const person = this.participants().find((p) => this.label(p.handle) === who);
        if (!person) return `No participant labelled ${who}`;
        this.sql`UPDATE participants SET name = ${goesBy} WHERE handle = ${person.handle}`;
        return "remembered";
      }

      case "remember_fact": {
        const { who, fact } = parseToolArgs("remember_fact", rawArgs);
        const person = this.participants().find((p) => this.label(p.handle) === who);
        if (!person) return `No participant labelled ${who}`;
        await peopleStore(this.env).addFact(person.handle, fact);
        return "remembered";
      }

      case "save_profile": {
        const { skipped, ...fields } = parseToolArgs("save_profile", rawArgs);
        if (this.getMeta("is_group") !== "0") return "Direct chats only. In a group, use remember_fact for what someone says about themselves.";
        const person = this.participants()[0];
        if (!person) return "Nobody to save it for yet.";
        const store = peopleStore(this.env);
        const before = (await store.getMany([person.handle]))[person.handle];
        // Being introduced to strangers needs a clear yes to that question. A
        // stray "yeah sure" to something else must not count, so the opt-in is
        // only accepted when it was the question asked, or they raised it.
        const lastIn = this.sql<{ body: string | null }>`SELECT body FROM messages WHERE direction = 'in' ORDER BY id DESC LIMIT 1`[0]?.body ?? "";
        const askedAboutMatching = missingFields(before)[0]?.key === "matchOptIn" || /match|introduc|meet (new )?people/i.test(lastIn);
        let refused = "";
        if (fields.matchOptIn !== undefined && !askedAboutMatching) {
          delete fields.matchOptIn;
          refused = " matchOptIn was NOT saved: they have not been asked that question yet.";
        }
        if (fields.links) fields.links = fields.links.map((l) => l.trim().slice(0, 120)).filter(Boolean);
        if (fields.links && !fields.links.length) delete fields.links;
        const saved = await store.save(person.handle, {
          ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== "")),
          skipped: [...new Set([...(before?.skipped ?? []), ...(skipped ?? [])])],
        });
        if (fields.name) this.sql`UPDATE participants SET name = ${fields.name} WHERE handle = ${person.handle}`;
        if (fields.links?.length) await this.schedule(3, "enrichFromLinks");
        if (!(await syncMatchPool(this.env, person.handle, saved))) this.note("warn", "match_pool.failed", {});
        const left = missingFields(saved);
        if (!left.length && this.getMeta("onboarded") !== "1") {
          this.setMeta("onboarded", "1");
          // The "you're all set" text that follows this save lands with confetti.
          this.celebrateNextSend = true;
          // The form is the "edit anytime" door, so it follows the last answer.
          await this.schedule(8, "offerProfile");
        }
        return (left.length ? `Saved. Still unknown: ${left.map((m) => m.key).join(", ")}. Ask only about ${left[0].key} next.` : "Saved. Nothing left to ask: tell them they're set.") + refused;
      }

      case "send_profile_link": {
        if (this.getMeta("is_group") !== "0") {
          return "Not in a group: the link is private. Tell them to text you directly and say 'profile'.";
        }
        return (await this.sendProfileLink()) ? "Link sent as its own message. Do not paste it again." : "Nobody to send it to yet.";
      }

      case "forget_person": {
        const { who } = parseToolArgs("forget_person", rawArgs);
        const person = this.participants().find((p) => this.label(p.handle) === who);
        if (!person) return `No participant labelled ${who}`;
        await peopleStore(this.env).forget(person.handle);

        // "Forget me" has to mean this chat too, not only the shared profile:
        // the name this chat learned, and in their own direct chat the area and
        // the record that onboarding already happened — otherwise they are still
        // greeted by name, and a fresh start never offers the profile card again.
        this.sql`UPDATE participants SET name = NULL WHERE handle = ${person.handle}`;
        if (this.getMeta("is_group") === "0") {
          for (const key of ["area", "profile_card_sent", "profile_link_sent", "profile_ack_at"]) this.setMeta(key, "");
          // Not in the same breath as the deletion: the card waits until they write again.
          this.setMeta("profile_card_hold", "1");
        }
        this.note("info", "person.forgotten", { who: mask(person.handle) });
        return "Deleted their profile and everything remembered about them, here and in every other chat. Confirm that in one line and do not use their name.";
      }

      case "research": {
        const args = parseToolArgs("research", rawArgs);
        return this.startResearch(args);
      }

      case "propose_plan": {
        const args = parseToolArgs("propose_plan", rawArgs);
        const options: PlanOption[] = args.options.map((o) => ({
          ...o,
          id: crypto.randomUUID().slice(0, 8),
        }));

        // New options invalidate old votes.
        this.sql`DELETE FROM votes`;
        this.publish({
          title: args.title,
          options,
          status: "voting",
          chosenOptionId: undefined,
          bookingNote: undefined,
        });

        // A new set of options is a moment worth a photo; votes are not.
        await this.planTicketIfNew();
        // Edit the card in place while it is still on screen; once it has
        // scrolled away, a quiet edit is invisible, so post a new one.
        const cardFresh = Date.now() - Number(this.getMeta("plan_card_at") ?? 0) < CARD_STALE_MS;
        if (this.getMeta("card_message_id") && cardFresh) {
          await this.syncCard();
        } else {
          const id = await sendCard(
            this.env,
            this.name,
            this.name,
            this.state,
            this.participants().length,
          );
this.rememberCardId(id);
          this.setMeta("plan_card_at", String(Date.now()));
          // Recipients without the extension see a static card with no
          // affordance, so spell out the tapback convention once.
          await this.say(`react to vote:\n${tapbackLegend(this.state)}`);
        }

        // The nudge is tied to this ballot. Without that, the timer from an
        // earlier vote fires onto whatever ballot is open when it goes off —
        // it once nagged for votes four seconds after a new card appeared.
        const ballot = String(Date.now());
        this.setMeta("ballot_id", ballot);
        await this.schedule(NUDGE_AFTER_SECONDS, "nudge", { ballot });
        return JSON.stringify({ options });
      }

      case "get_votes": {
        return JSON.stringify({
          tally: this.state.options.map((o) => ({
            optionId: o.id,
            title: o.title,
            votes: this.state.counts[o.id] ?? 0,
          })),
          awaiting: this.state.awaiting,
        });
      }

      case "check_availability": {
        const args = parseToolArgs("check_availability", rawArgs);
        const checks = [
          ...(args.optionIds ?? [])
            .map((id) => this.state.options.find((o) => o.id === id))
            .filter((o): o is PlanOption => Boolean(o?.bookingUrl))
            .map((o) => ({ optionId: o.id, title: o.title, url: o.bookingUrl! })),
          // Not everything in an outing is up for a vote: the spa after dinner is
          // checked by its own link, under an id the ballot will never use.
          ...(args.venues ?? [])
            .filter((v) => /^https?:\/\//.test(v.bookingUrl))
            .map((v, i) => ({ optionId: `venue:${i}`, title: v.title, url: v.bookingUrl })),
        ].slice(0, 3);
        if (!checks.length) return "None of those options has an online booking link, so there is nothing to check. Say so.";

        const params: AvailabilityParams = { mode: "availability", partySize: args.partySize, isoTime: args.isoTime, checks };
        const workflowId = await this.runWorkflow("BOOKING_WORKFLOW", params);
        this.note("info", "availability.started", { workflowId: short(workflowId), options: checks.map((c) => c.title) });
        return `Checking ${checks.length} booking page${checks.length === 1 ? "" : "s"} now; it takes a minute or two each and the results arrive on their own. Tell the group you're checking in one short line, then stop.`;
      }

      case "book_option": {
        const args = parseToolArgs("book_option", rawArgs);
        // Either a ballot option, or a venue that is part of the outing without
        // being voted on (the spa after dinner). Only the first kind moves the plan.
        const onBallot = args.optionId ? this.state.options.find((o) => o.id === args.optionId) : undefined;
        if (args.optionId && !onBallot) return "No such option";
        if (!onBallot && !args.venue) return "Say what to book: an optionId from the ballot, or a venue from the Research findings.";
        const option: { id?: string; title: string; bookingUrl?: string } = onBallot ?? { title: args.venue!.title, bookingUrl: args.venue!.bookingUrl };
        if (onBallot && (this.state.status === "booking" || this.state.status === "booked" || this.state.status === "handoff")) {
          return `Already ${this.state.status}`;
        }
        if (this.getMeta("booking_running") === "1") return "A booking is already running; one browser at a time. Wait for it to finish.";

        // Validate before touching state: a refused call must leave the plan as it was.
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.contactEmail) || /example\.(com|org)$/i.test(args.contactEmail)) {
          return "That is not a real email address. Ask the person booking for theirs; do not invent one.";
        }
        if (!option.bookingUrl) return "This option has no online booking link, so there is nothing to drive. Tell the group they will need to call or book it themselves.";

        this.setMeta("booking_running", "1");
        this.setMeta("booking_for", JSON.stringify({ title: option.title, onBallot: Boolean(onBallot) }));
        if (onBallot) {
          this.publish({ status: "booking", chosenOptionId: onBallot.id });
          await this.syncCard();
        }

        // The booker's own number, from whoever spoke last: venues ask for one.
        const lastSpeaker = this.sql<{ author: string | null }>`
          SELECT author FROM messages WHERE direction = 'in' ORDER BY id DESC LIMIT 1`[0]?.author;
        const params: BookingParams = {
          title: option.title,
          url: option.bookingUrl ?? "",
          partySize: args.partySize,
          isoTime: args.isoTime,
          contact: {
            name: args.contactName,
            email: args.contactEmail,
            phone: args.contactPhone ?? (lastSpeaker && /^\+?\d{8,}$/.test(lastSpeaker) ? lastSpeaker : undefined),
          },
        };
        const workflowId = await this.runWorkflow("BOOKING_WORKFLOW", params);
        this.note("info", "booking.started", { workflowId: short(workflowId), option: option.title });
        return "Booking started. The card updates and the chat is told when it finishes — do not announce success yet.";
      }

      case "shop_search": {
        const { shop, query } = parseToolArgs("shop_search", rawArgs);
        const found = await searchCatalog(this.env, shop, query);
        // Remembered because the cart will not tell us: it names lines by variant.
        for (const p of found) {
          for (const v of p.variants) {
            this.sql`INSERT INTO product_names (variant_id, name) VALUES (${v.variantId}, ${productName(p.title, v.label)})
                     ON CONFLICT(variant_id) DO UPDATE SET name = excluded.name`;
          }
        }
        return found.length ? JSON.stringify(found) : `Nothing at ${shop} matches "${query}".`;
      }

      case "shop_build_cart": {
        const args = parseToolArgs("shop_build_cart", rawArgs);
        const shop = shopKey(args.shop);
        // One cart and one card per shop; a second call edits both. The id holds
        // the cart's secret key, so it lives in meta rather than the public state.
        const names = Object.fromEntries(
          this.sql<{ variant_id: string; name: string }>`SELECT variant_id, name FROM product_names`.map((r) => [r.variant_id, r.name]),
        );
        const cart = await setCart(this.env, shop, args.lines, this.getMeta(`cart_id:${shop}`) || undefined, names);
        this.setMeta(`cart_id:${shop}`, cart.id);
        if (!cart.lines.length) {
          return `Nothing could be added, so no card was posted. Store says: ${cart.messages.join("; ") || "no reason given"}. Choose a different variant from shop_search.`;
        }
        // Replace this store's entry and leave every other store's cart alone.
        // An edited cart is unpaid again: what was paid for is no longer what is in it.
        const mine = { shop, checkoutUrl: cart.checkoutUrl, total: cart.total, lines: cart.lines };
        // In place, so the list does not reshuffle every time one store is edited.
        const before = this.carts();
        const at = before.findIndex((c) => shopKey(c.shop) === shop);
        this.saveCarts(at === -1 ? [...before, mine] : before.map((c, i) => (i === at ? mine : c)));
        // The catalog already hands back a product image per line; recording one
        // gives the run viewer something to show for a step with no browser
        // behind it — UCP is plain JSON-RPC, so there is no page to capture.
        const messageId = await this.postCartCard(shop, mine);
        const summary = cart.lines.map((l) => `${l.quantity}x ${l.title} (${l.price})`).join(", ");
        return `Cart card for ${shop} ${messageId ? "redrawn" : "posted"} with its checkout link. ${summary}. Total ${cart.total}.${
          cart.messages.length ? ` Store says: ${cart.messages.join("; ")}` : ""
        } ${this.shoppingListLine()}`;
      }

      case "shop_drop_cart": {
        const shop = shopKey(parseToolArgs("shop_drop_cart", rawArgs).shop);
        const carts = this.carts();
        if (!carts.some((c) => shopKey(c.shop) === shop)) {
          return `There is no cart at ${shop}. ${this.shoppingListLine()}`;
        }
        this.saveCarts(carts.filter((c) => shopKey(c.shop) !== shop));
        const cartId = this.getMeta(`cart_id:${shop}`);
        // The checkout link already in the thread cannot be unsent, so at least
        // ask the store to void the cart behind it.
        const cancelled = cartId ? await cancelCart(this.env, shop, cartId) : false;
        this.setMeta(`cart_id:${shop}`, "");
        this.setMeta(`cart_message_id:${shop}`, "");
        this.setMeta(`cart_photos:${shop}`, "");
        this.note("info", "cart.dropped", { shop, cancelledAtStore: cancelled });
        return `Dropped the ${shop} cart. Its old checkout card is still in the thread, so tell the group in one line not to use it. ${this.shoppingListLine()}`;
      }

      case "show_shopping_list": {
        const carts = this.carts();
        if (!carts.length) return "The shopping list is empty: no carts have been built.";
        await this.postTicket("list", shoppingListTicket(carts, this.headcount()));
        return `Shopping list ticket posted. ${this.shoppingListLine()}`;
      }

      case "mark_paid": {
        const { who, shop: named } = parseToolArgs("mark_paid", rawArgs);
        const carts = this.carts();
        if (!carts.length) return "There is no cart in this chat.";
        // Tolerate "milk bar" for milkbarstore.com, but never guess between stores.
        const norm = (s: string) => shopKey(s).replace(/[^a-z0-9]/g, "");
        const hits = carts.filter((c) => norm(c.shop).includes(norm(named)) || norm(named).includes(norm(c.shop).replace(/(com|ca|co|store|shop)$/g, "")));
        const cart = hits.length === 1 ? hits[0] : carts.length === 1 ? carts[0] : undefined;
        if (!cart) return `Which store? "${named}" does not pick out one cart. ${this.shoppingListLine()}`;
        if (cart.paidBy) return `${cart.shop} is already marked paid by ${cart.paidBy}.`;

        const paid = { ...cart, paidBy: who };
        this.saveCarts(carts.map((c) => (c === cart ? paid : c)));
        await this.postTicket("cart", cartTicket(paid, this.headcount()));
        return `PAID ticket posted for ${cart.shop}. ${this.shoppingListLine()}`;
      }

      case "show_venue": {
        const { name } = parseToolArgs("show_venue", rawArgs);
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
        const same = (s: string) => norm(s).includes(norm(name)) || norm(name).includes(norm(s));
        const report = this.sql<{ report: string }>`SELECT report FROM research WHERE ok = 1 ORDER BY id DESC LIMIT 1`[0];
        const found = report ? (JSON.parse(report.report) as ResearchReport).candidates.find((c) => same(c.name)) : undefined;
        const slot = this.state.options.findIndex((o) => same(o.title));
        const option = this.state.options[slot];
        // Only what research found or the plan already says: nothing is invented here.
        if (!found && !option) return `Nothing is known about "${name}". Run research first, or use the exact name.`;
        await this.postTicket(
          "venue",
          venueTicket(
            found
              ? { name: found.name, kind: found.kind, price: found.price, why: found.why, address: found.address, caveat: found.caveat }
              : { name: option.title, why: option.subtitle },
            this.state.status === "voting" ? slot : -1,
            option ? (this.state.counts[option.id] ?? 0) : 0,
          ),
        );
        return "Venue ticket posted. Do not repeat its contents in text.";
      }

      case "ask_rsvp": {
        const args = parseToolArgs("ask_rsvp", rawArgs);
        this.sql`DELETE FROM rsvps`;
        this.setMeta("rsvp_open", "1");
        this.setMeta("rsvp_title", args.title ?? "");
        this.setMeta("rsvp_when", args.when ?? "");
        await this.postTicket("rsvp", rsvpTicket(this.rsvps()));
        return "Who's in ticket posted. People answer with a thumbs up or down on it; record_rsvp covers anyone who answers in words.";
      }

      case "record_rsvp": {
        const { who, answer } = parseToolArgs("record_rsvp", rawArgs);
        if (this.getMeta("rsvp_open") !== "1") return "No headcount is open. Call ask_rsvp first.";
        const person = this.participants().find((p) => this.label(p.handle) === who);
        if (!person) return `No participant labelled ${who}`;
        await this.recordRsvp(person.handle, answer, "text");
        return JSON.stringify(this.rsvps());
      }

      case "get_rsvps":
        return JSON.stringify(this.rsvps());

      case "lock_headcount": {
        if (this.getMeta("rsvp_open") !== "1") return "No headcount is open.";
        await this.lockHeadcount();
        return JSON.stringify(this.rsvps());
      }

      case "introduce_match": {
        const { a, b, common } = parseToolArgs("introduce_match", rawArgs);
        await this.postTicket("match", matchTicket(a, b, common));
        return "Introduction ticket posted. Follow it with one short line, not a summary of the ticket.";
      }

      case "join_match_pool": {
        const { who, blurb } = parseToolArgs("join_match_pool", rawArgs);
        const person = this.participants().find((p) => this.label(p.handle) === who);
        if (!person) return `No participant labelled ${who}`;
        await upsertProfile(this.env, { id: person.handle, name: this.label(person.handle), blurb });
        return "added to the pool";
      }

      case "find_matches": {
        const { who, lookingFor, near } = parseToolArgs("find_matches", rawArgs);
        if (this.getMeta("is_group") !== "0") return "Not in a group: pairing is private. Tell them to text you directly.";
        const person = this.participants().find((p) => this.label(p.handle) === who);
        if (!person) return `No participant labelled ${who}`;
        const store = peopleStore(this.env);
        const profile = (await store.getMany([person.handle]))[person.handle];
        // Searching the pool means being findable in it: same consent both ways.
        if (!profile?.matchOptIn) return "They are not in the match pool themselves. Ask whether they want to be introduced to people (save_profile matchOptIn) before searching.";
        // A place they named beats where they live: "i'm visiting vancouver, anyone there?"
        const where = near || profile.area;
        const query = [lookingFor, profile.interests, where && `Based in ${where}`].filter(Boolean).join(". ");
        const exclude = [person.handle, ...(await store.pairedWith(person.handle))];
        // Vectorize understands meaning ("bouldering" finds "climbing") but takes a
        // minute or two to index a new profile, and is absent without a login; the
        // shared-word scan is instant and always there. Meaning first, then words.
        const [semantic, lexical] = await Promise.all([
          findMatches(this.env, query, exclude).catch((err) => {
            this.note("warn", "match.index_unavailable", errorFields(err));
            return [];
          }),
          store.scanPool(query, exclude),
        ]);
        const merged = [...semantic, ...lexical.filter((l) => !semantic.some((m) => m.id === l.id))];
        // Only people an introduction can actually reach: still opted in, with a
        // direct chat to ask them in. The index can hold entries older than that rule.
        const reachable = await store.getMany(merged.map((m) => m.id));
        const matches = merged
          .filter((m) => reachable[m.id]?.matchOptIn && reachable[m.id]?.dmChat)
          .filter((m) => !near || (reachable[m.id]?.area ?? "").toLowerCase().includes(near.split(/[ ,]/)[0].toLowerCase()))
          .slice(0, 3);
        if (!matches.length && near) return `Nobody in the pool is based in ${near} yet. Say so plainly, and offer to look without the location.`;
        if (!matches.length) return "Nobody new in the pool fits yet. Say so plainly; more people join over time.";

        // The model gets refs and blurbs. Handles and names stay here, keyed by
        // ref, until the other person has said yes.
        const candidates: Record<string, string> = {};
        const shown: Candidate[] = matches.map((m, i) => {
          candidates[`c${i + 1}`] = m.id;
          return { ref: `c${i + 1}`, blurb: m.blurb, score: m.score };
        });
        this.setMeta("match_candidates", JSON.stringify(candidates));
        this.note("info", "match.search", { candidates: shown.length, top: shown[0]?.score });
        return JSON.stringify(shown);
      }

      case "request_intro": {
        const { candidate, common } = parseToolArgs("request_intro", rawArgs);
        const asker = this.participants()[0];
        if (this.getMeta("is_group") !== "0" || !asker) return "Not in a group: pairing is private.";
        const to = (JSON.parse(this.getMeta("match_candidates") || "{}") as Record<string, string>)[candidate];
        if (!to) return `No candidate ${candidate}. Call find_matches first and use one of its refs.`;
        const store = peopleStore(this.env);
        if ((await store.pendingFrom(asker.handle)).length >= MAX_PENDING_PER_ASKER) {
          return "They already have an introduction waiting on an answer. One at a time: tell them you will let them know when it comes back.";
        }
        const target = (await store.getMany([to]))[to];
        if (!target?.matchOptIn || !target.dmChat) return "That person can no longer be reached for introductions. Offer another candidate.";
        // One question at a time for them too; a second ask would overwrite the first.
        if ((await store.pendingTo(to)).length) return "That person cannot be asked right now. Offer another candidate, or suggest trying again in a day or two. Do not say why.";

        const intro: Intro = { id: crypto.randomUUID().slice(0, 12), from: asker.handle, fromChat: this.name, to, common, status: "pending", created: Date.now() };
        await store.createIntro(intro);
        const theirs = await getAgentByName<Env, PlanAgent>(this.env.PlanAgent, target.dmChat);
        await theirs.introAsk(intro);
        await this.schedule(Math.ceil(INTRO_TTL_MS / 1000), "introExpired", { id: intro.id });
        this.note("info", "intro.requested", { intro: intro.id });
        return "Asked them privately. Tell the asker, in one or two short lines: you have asked, and a group chat with the two of them opens the moment the other person says yes. Do not promise a yes.";
      }

      case "answer_intro": {
        const { answer } = parseToolArgs("answer_intro", rawArgs);
        const id = this.getMeta("pending_intro");
        if (!id) return "No introduction is waiting on this person.";
        this.setMeta("pending_intro", "");
        this.setMeta("pending_intro_common", "");
        const store = peopleStore(this.env);
        const intro = await store.getIntro(id);
        if (!intro || intro.status !== "pending") return "That introduction is no longer open. Tell them so, kindly.";

        const asker = await getAgentByName<Env, PlanAgent>(this.env.PlanAgent, intro.fromChat);
        if (answer === "no") {
          await store.updateIntro(id, { status: "declined" });
          await asker.introAnswered(intro, null);
          this.note("info", "intro.declined", { intro: id });
          return "Recorded. The other person is only told it did not work out, not who. Acknowledge in one short line.";
        }

        const profiles = await store.getMany([intro.from, intro.to]);
        const a = profiles[intro.from]?.name ?? "someone";
        const b = profiles[intro.to]?.name ?? "someone";
        let chat: string;
        try {
          chat = await createGroupChat(this.env, [intro.from, intro.to], openingText(a, b, intro));
        } catch (err) {
          // Their yes still stands: put the question back so a retry needs no re-asking.
          this.setMeta("pending_intro", id);
          this.setMeta("pending_intro_common", intro.common.map((c) => c.text).join(", "));
          this.note("error", "intro.chat_failed", errorFields(err));
          return "Failed: the group chat could not be opened. This is a system problem. Tell them you hit a snag opening the chat and will try again if they say yes once more.";
        }
        await store.updateIntro(id, { status: "accepted", chat });
        const room = await getAgentByName<Env, PlanAgent>(this.env.PlanAgent, chat);
        await room.introOpened(intro, a, b);
        await asker.introAnswered(intro, chat);
        this.note("info", "intro.accepted", { intro: id, chat: short(chat) });
        return "Done: a group chat with the two of them is open and the introduction is posted there. Tell them to look for it, in one short line.";
      }
    }
  }

  // --------------------------------------------------------------- research

  /** Also called directly by the simulator, to test the pipeline without the model choosing to. */
  async startResearch(params: ResearchParams): Promise<string> {
    const since = Number(this.getMeta("research_started") ?? 0);
    if (since && Date.now() - since < RESEARCH_STALE_MS) {
      return "Research is already running. Wait for it to finish.";
    }
    this.setMeta("research_started", String(Date.now()));
    this.setMeta("research_progress_at", String(Date.now()));
    this.setMeta("research_brief", params.brief.slice(0, 200));
    await this.schedule(RESEARCH_WATCHDOG_SECONDS, "researchWatchdog");
    const workflowId = await this.runWorkflow("RESEARCH_WORKFLOW", params);
    this.note("info", "research.started", { workflowId: short(workflowId), depth: params.depth, brief: params.brief.slice(0, 120), near: params.near });
    return "Research started; it takes a few minutes. Tell the group you're looking into it in one short line, then stop. The findings will arrive on their own.";
  }

  /** Called over RPC by ResearchWorkflow as it moves through its stages. */
  async researchProgress(stage: string, fields: Fields = {}) {
    this.setMeta("research_progress_at", String(Date.now()));
    if (stage === "browser" && typeof fields.liveUrl === "string") {
      // Same treatment as a booking: the url itself stays out of run history —
      // it carries a session token — and /live/<chat> redirects to it instead.
      this.setMeta("live_url", fields.liveUrl);
      this.note("info", "research.browser", { provider: fields.provider, live: true });
      return;
    }
    this.note("info", `research.${stage}`, fields);
  }

  /**
   * Scheduler callback. A run whose workflow dies (runtime restart, Browserbase
   * outage, an exception outside a step) never calls researchFinished, and the
   * agent — having told the group it is "looking into it" — would wait in
   * silence forever. A run that has reported nothing for a while is declared
   * dead and sent down the normal failure path, which tells the group. If the
   * run was merely slow, its real result still arrives later and is shared.
   */
  async researchWatchdog() {
    const since = Number(this.getMeta("research_started") ?? 0);
    if (!since) return; // finished normally
    const silentFor = Date.now() - Number(this.getMeta("research_progress_at") ?? since);
    if (silentFor < RESEARCH_SILENCE_LIMIT_MS) {
      await this.schedule(RESEARCH_WATCHDOG_SECONDS, "researchWatchdog");
      return;
    }
    this.note("warn", "research.abandoned", { silentForS: Math.round(silentFor / 1000) });
    await this.researchFinished({
      ok: false,
      brief: this.getMeta("research_brief") ?? "",
      summary: "",
      candidates: [],
      stats: { queries: 0, hits: 0, pagesRead: 0, pagesFailed: 0, tokens: 0, ms: Date.now() - since },
      sessions: [],
      detail: "the search stopped responding partway through (a system problem, not a lack of results); offer to try again",
    });
  }

  /** Called over RPC by ResearchWorkflow when it finishes, either way. */
  async researchFinished(report: ResearchReport) {
    this.setMeta("research_started", "0");
    this.note(report.ok ? "info" : "warn", "research.finished", {
      ok: report.ok,
      candidates: report.candidates.length,
      ...report.stats,
      detail: report.detail,
      replays: report.sessions.map((id) => `https://browserbase.com/sessions/${id}`),
    });
    this.sql`INSERT INTO research (ts, ok, report) VALUES (${Date.now()}, ${report.ok ? 1 : 0}, ${JSON.stringify(report)})`;
    // Nobody texted, but there is news: give the model a turn to share it.
    await this.schedule(1, "runTurn");
  }

  /** What the model is told about research: in progress, fresh results, or earlier results. */
  private researchContext(): { text: string; deliveredId?: number } {
    const since = Number(this.getMeta("research_started") ?? 0);
    if (since && Date.now() - since < RESEARCH_STALE_MS) {
      return { text: `in progress, started ${Math.round((Date.now() - since) / 1000)}s ago. Do not start another.` };
    }
    const row = this.sql<{ id: number; delivered: number; report: string }>`
      SELECT id, delivered, report FROM research ORDER BY id DESC LIMIT 1`[0];
    if (!row) return { text: "none yet" };

    const report = JSON.parse(row.report) as ResearchReport;
    const body = report.ok
      ? JSON.stringify({
          brief: report.brief,
          summary: report.summary,
          // Shaped like propose_plan options, so the model can pass them straight through.
          options: report.candidates.map((c) => ({
            title: c.name,
            subtitle: [c.price, c.why].filter(Boolean).join(" · ").slice(0, 90),
            bookingUrl: c.bookingUrl,
            address: c.address,
            caveat: c.caveat,
            independentSources: c.sources.length,
          })),
        })
      : `failed: ${report.detail}`;
    if (row.delivered) return { text: `earlier findings, already shared with the group: ${body}` };
    return {
      deliveredId: row.id,
      text: report.ok
        ? `JUST FINISHED — the group has not seen this yet. Whatever else is going on, share the highlights in one or two lines now, then call propose_plan with the best 2-4 options below, passing title, subtitle and bookingUrl through unchanged. ${body}`
        : `JUST FAILED — tell the group in one line that the search came up empty and ask what to change. ${body}`,
    };
  }

  /** Simulator only (see /api/dev in index.ts). */
  async dump() {
    return {
      state: this.state,
      research: this.sql<{ report: string }>`SELECT report FROM research ORDER BY id DESC LIMIT 1`.map((r) => JSON.parse(r.report))[0],
      transcript: this.sql<Row>`SELECT direction, author, body FROM messages ORDER BY id`,
      votes: this.sql<Row>`SELECT voter, option_id, source FROM votes`,
    };
  }

  /**
   * Simulator only: run one tool exactly as the model would, without a model.
   * Deterministic and free, which makes it the way to iterate on cards.
   */
  async devRunTool(tool: string, args: unknown) {
    this.note("info", "dev.tool", { tool });
    return this.runTool(tool, JSON.stringify(args ?? {}));
  }

  /** Simulator only: id of the agent's most recent text, to simulate replying to it. */
  async lastOwnMessageId() {
    return this.sql<{ linq_id: string }>`
      SELECT linq_id FROM messages WHERE direction = 'out' AND linq_id IS NOT NULL ORDER BY id DESC LIMIT 1`[0]?.linq_id;
  }

  /** Simulator only: the open Who's in ticket's message id. */
  async currentRsvpId() {
    return this.sql<{ message_id: string }>`
      SELECT message_id FROM tickets WHERE kind = 'rsvp' AND message_id IS NOT NULL ORDER BY ts DESC LIMIT 1`[0]?.message_id;
  }

  /** Simulator only: the open ballot's id, so its nudge can be fired on demand. */
  async currentBallot() {
    return this.getMeta("ballot_id");
  }

  /** Simulator only: the plan card's current message id. */
  async currentCardId() {
    return this.getMeta("card_message_id");
  }

  /** Most recent events, oldest first. Simulator only. */
  async events(limit = 100) {
    return this.sql<{ ts: number; level: string; event: string; fields: string }>`
      SELECT ts, level, event, fields FROM events ORDER BY id DESC LIMIT ${limit}`.reverse();
  }

  // ------------------------------------------------------ scheduled + workflow

  /** Fires a while after voting opens. */
  async nudge(payload?: { ballot?: string }) {
    if (payload?.ballot !== this.getMeta("ballot_id")) return; // an older ballot's timer
    if (this.getMeta("is_group") !== "1") return; // nobody to chase in a one-to-one chat
    if (this.state.status !== "voting" || this.state.awaiting.length === 0) return;
    this.note("info", "nudge", { awaiting: this.state.awaiting.length });
    // Only name people whose names are known; "…5178" is not how friends talk.
    const waiting = this.state.awaiting;
    const named = waiting.every((w) => !w.startsWith("…"));
    await this.say(
      named
        ? `still need a vote from ${waiting.join(", ")}`
        : `still waiting on ${waiting.length} ${waiting.length === 1 ? "vote" : "votes"}`,
    );
  }

  /** Called over RPC by BookingWorkflow when it finishes, either way. */
  /**
   * A workflow that throws outside its own error handling never reports back,
   * and whatever the agent told the group it was doing just never happens.
   * Record it, and say so, instead of leaving the chat waiting.
   */
  async onWorkflowError(workflowName: string, workflowId: string, error: string) {
    this.note("error", "workflow.crashed", { workflow: workflowName, id: short(workflowId), error: String(error).slice(0, 400) });
    if (workflowName === "BOOKING_WORKFLOW") {
      this.setMeta("booking_running", "");
      this.setMeta("booking_for", "");
      if (this.state.status === "booking") this.publish({ status: "failed", bookingNote: "the booking run crashed" });
      await this.say("that didn't work on my end, sorry. something broke while I was on the booking site.");
    }
  }

  /** Called over RPC by BookingWorkflow when an availability check finishes. */
  async availabilityFinished(results: AvailabilityResult[]) {
    this.note("info", "availability.finished", { results: results.map((r) => ({ option: r.title.slice(0, 40), ok: r.ok, slots: r.slots })) });
    const byId = new Map(results.map((r) => [r.optionId, r]));
    this.publish({
      options: this.state.options.map((o) => {
        const r = byId.get(o.id);
        if (!r) return o;
        return { ...o, availability: r.ok ? (r.slots.length ? `open: ${r.slots.join(", ")}` : "nothing open that day") : `couldn't check (${r.summary.slice(0, 80)})` };
      }),
    });
    // Venues outside the ballot have no option to hang the result on, so their
    // times travel to the model in the wake-up note instead.
    const offBallot = results.filter((r) => r.optionId.startsWith("venue:"));
    this.setMeta(
      "side_availability",
      offBallot.map((r) => `${r.title}: ${r.ok ? (r.slots.length ? `open ${r.slots.join(", ")}` : "nothing open that day") : `could not check (${r.summary.slice(0, 80)})`}`).join("; "),
    );
    // Nobody texted, but there is news: give the model a turn to share it.
    this.setMeta("turn_reason", "availability_in");
    await this.schedule(1, "runTurn");
  }

  /** Called over RPC by BookingWorkflow while the pilot works. */
  async bookingProgress(stage: string, fields: Fields = {}) {
    if (stage === "browser" && typeof fields.liveUrl === "string") {
      // Served as a short redirect: the raw live-view url is long and ugly in a text.
      this.setMeta("live_url", fields.liveUrl);
      this.note("info", "booking.browser", { provider: fields.provider, live: true });
      await this.say(`booking it now. watch the browser: ${this.env.PUBLIC_BASE_URL}/live/${encodeURIComponent(this.name)}`);
      return;
    }
    this.note("info", `booking.${stage}`, fields);
  }

  /** Where /live/<chat> redirects: the Browserbase live view of the current booking run. */
  async liveUrl() {
    return this.getMeta("live_url");
  }

  /** Stores the pilot's final screenshot (base64 JPEG) and returns its id. */
  async saveShot(base64: string): Promise<string> {
    const id = crypto.randomUUID().slice(0, 12);
    this.sql`INSERT INTO shots (id, jpeg, ts) VALUES (${id}, ${base64}, ${Date.now()})`;
    this.sql`DELETE FROM shots WHERE ts < ${Date.now() - 3 * 24 * 3600 * 1000}`;
    return id;
  }

  async getShot(id: string): Promise<string | null> {
    return this.sql<{ jpeg: string }>`SELECT jpeg FROM shots WHERE id = ${id}`[0]?.jpeg ?? null;
  }

  /** Called over RPC by BookingWorkflow when it finishes, whatever the outcome. */
  async bookingFinished(result: BookingResult) {
    // What was being booked is recorded when the run starts: it may be a venue
    // that was never on the ballot, in which case the plan's status is not its to change.
    const inFlight = JSON.parse(this.getMeta("booking_for") || "{}") as { title?: string; onBallot?: boolean };
    const onBallot = inFlight.onBallot !== false;
    const option = this.state.options.find((o) => o.id === this.state.chosenOptionId);
    const name = inFlight.title ?? option?.title ?? "it";
    this.setMeta("booking_running", "");
    this.setMeta("booking_for", "");
    this.setMeta("live_url", "");
    this.note(result.ok ? "info" : "warn", "booking.finished", {
      status: result.status,
      steps: result.steps,
      tokens: result.tokens,
      replay: result.replayUrl,
      // The pilot's last frame is already saved and served; carrying its id
      // here is what lets the run viewer show how far the booking actually got.
      shotId: result.shotId,
    });

    // Three outcomes, not two: confirmed, taken as far as the agent is allowed
    // to go (a person finishes it), or genuinely failed.
    const handedOff = result.status === "ready" || result.status === "needs_payment";
    if (onBallot) {
      this.publish({
        status: result.ok ? "booked" : handedOff ? "handoff" : "failed",
        bookingNote: result.ok ? result.confirmation : result.detail,
      });
      await this.syncCard();
      if (result.ok) await this.planTicketIfNew();
    }

    if (result.ok) {
      await this.say(`booked ${name}${result.confirmation ? `. confirmation: ${result.confirmation}` : ""}`, { screenEffect: "confetti" });
    } else if (handedOff) {
      await this.say(`${name}: ${result.detail}\nfinish it here: ${result.handoffUrl}`);
    } else {
      await this.say(`couldn't book ${name}: ${result.detail}${result.handoffUrl ? `\nyou can book it yourself here: ${result.handoffUrl}` : ""}`);
    }

    // The pilot's last view of the page: evidence of how far it really got.
    if (result.shotId) {
      await sendPhoto(this.env, this.name, `${this.env.PUBLIC_BASE_URL}/shot/${encodeURIComponent(this.name)}/${result.shotId}.jpg`).catch((err) =>
        this.note("warn", "booking.shot_failed", errorFields(err)),
      );
    }
  }
}
