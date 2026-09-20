import { collectPlanMedia, generateCover, mediaKey, mediaCompanies, type MediaFile } from "./plan-media";
import { findLocations, getWeather } from "./weather";
import { telemetryScope, traceOperation, traceFields, safeFields } from "./telemetry";
import { Agent, callable, getAgentByName } from "agents";
import type OpenAI from "openai";
import { ZodError } from "zod";
import { EMPTY_PLAN, ITEM_EMOJI, REACTION_SLOTS, cartsOf, cartsTotal, shopKey, type CartSummary, type ItineraryItem, type PlanOption, type PlanState } from "../types";
import { llmFor, modelExtras } from "./llm";
import { readLinks } from "./social";
import { missingFields, ONBOARDING, people as peopleStore, profileLines, syncMatchPool, type Profile } from "./people";
import { errorFields, log, mask, short, timed, type Fields, type Level } from "./log";
import { cartTicket, invoiceTicket, itineraryTicket, matchTicket, planTicket, rsvpTicket, shoppingListTicket, venueTicket, type Rsvps, type Ticket } from "./card";
import { SourceError } from "./sources/fetch";
import { flightOption, searchFlights } from "./sources/flights";
import { searchStays, stayOption } from "./sources/stays";
import { cityTz, eventOption, findEvents } from "./sources/events";
import { describeFlight, flightStatus } from "./sources/flight-status";
import { orderStatus } from "./sources/order-status";
import { baselineFor, diffFlight, diffOrder, flightWatchActive, orderWatchActive } from "./sources/watch";
import type { FlightStatus, OrderStatus } from "./sources/types";
import { tripKind } from "./sources/kind";
import { fmtMoney, invoiceFor, parseMoney, type Expense, type Invoice } from "../invoice";
import { type PaymentConnection, attachLink, connectPayments, dressChat, markRead, readLocation, readPlaces, requestLocation, stopLocation, paymentConnection, planIconUrl, revokePayments, sendAttachCard, sendCard, sendLinkCard, hasAppIdentity, sendGameCard, sendTicketCard, sendMusicCard, updateMusicCard, sendPhoto, sendPhotos, sizedImage, verifyPayments, sendText, createGroupChat, shareContactCard, startTyping, stopTyping, updateCard, type SendOptions } from "./linq";
import { groupName } from "../dressing";
import { isComplete, parseAddress, type Address, type Delivery } from "../delivery";
import type { ShipTo } from "./checkout";
import type { PayParams, PayResult } from "./booking";
import { openAiTools, parseToolArgs, toolSchemas, type ToolName } from "./tools";
import { KNOWN_SHOPS, cancelCart, productName, searchCatalog, setCart } from "./tools/shopify";
import { findMatches } from "./tools/match";
import { searchTrack } from "./tools/music";
import { GameSpecZ, advance as gameAdvance, answer as gameAnswer, generateGame, joinGame, newGame, roundComplete, view as gameView, type GameState } from "./game";
import { ANSWER_RELAY_SECONDS, askText, declinedText, expiredText, INTRO_TTL_MS, MAX_PENDING_PER_ASKER, openingText, type Candidate, type Intro } from "./intros";
import { RunRecorder } from "./runs";
import { startConcurrent } from "./tool-concurrency";
import { redirectFor, travelKindOf } from "./research-routing";
import type { AvailabilityParams, AvailabilityResult, BookingParams, BookingResult } from "./booking";
import type { ResearchParams, ResearchReport } from "./research";

const SYSTEM = `You are Whim, a planning agent living inside an iMessage group chat. You help the
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
- When a request needs several lookups that do not depend on each other
  (flights and a hotel, two stores, a place and its weather), make all of
  those calls in the same reply. They run at the same time, so the group
  waits once instead of once per call.
- "In the area" and "nearby" mean the group's own area, shown below. When
  someone states where they are, call remember_area; pass that area as the
  research "near" unless they name somewhere else for this outing.
- In a one-to-one chat where the area is unknown, offer a choice: they can type
  where they are, or share their location and you will take just the city.
  Call request_location only after they say yes to sharing. Never in a group.
- When someone says they shared their location, or asks anything that depends on
  where people are (how far apart, what is between us), call read_locations —
  it works in groups. Never say a location is set, saved or known unless a tool
  result in this turn said so.
- For outdoor or weather-sensitive plans, resolve the stated destination with find_locations, then get_weather for the actual local date. Ask if the place/date is ambiguous. If beyond the forecast window, suggest rechecking closer to the day. Do not fetch weather for every indoor plan.
- Research delegates site-specific work to a Browserbase specialist only when useful. Use the relevant details, source links and checkedAt in research findings to answer the actual question. Preserve fees, currency, dates and caveats; old findings are not fresh availability. Do not mention skill IDs or claim discovery results are confirmed bookings.
- Never invent a venue, address or price. Every option you propose must come
  from the Research findings below or a shop_search result in this conversation.
- A vote needs at least two real options. If research found only one good
  place, do not pad the list: tell the group about that one and ask whether to
  go with it or look further.
- To find real places (restaurants, bars, activities, venues), call research.
  It takes a few minutes and its findings appear under "Research" below when
  done: tell the group you're on it, then stop. Never start a second run while
  one is in progress, and never invent places, prices or links — propose only
  what research found. Flights, places to stay and ticketed events are never
  research: search_flights, search_stays and find_events answer in this turn.
- For a trip or a night out, work in segments and open one ballot at a time:
  flights first, then where to stay, then what to do. search_flights,
  search_stays and find_events return real options in this turn with their
  prices: put 2-4 on propose_plan and quote the prices exactly. Their links
  open the site's own checkout, so you never book those yourself: once a vote
  settles, call add_to_itinerary, which posts the link, then move to the next
  segment. Flights, stays and events need nobody's name or email and never go
  through book_option: the moment the vote settles, call add_to_itinerary and
  hand the group the link. When someone says they booked it, call confirm_item
  (with what they paid and who paid, so the split is right); when they give a
  flight number, call watch_flight. Never say a flight, room or ticket is
  booked until a person says so. The Itinerary below is the trip so far.
  When the group says "go ahead" or "book it" about a flight, stay or event,
  that means add_to_itinerary.
- When someone comes back to a plan after a while, call propose_plan again
  with the options that still apply: that puts the card back in front of them
  instead of pointing at one far up the thread.
- Brainstorm in plain text. Once there are 2-4 concrete options, call
  propose_plan; it posts the card and opens voting. Call it again to redraw the
  same card when options change rather than describing changes in text.
- People vote by tapping an option on the plan card (a tapback on the card
  counts too); the card shows the live tally. Never ask anyone to reply with a number, and do not comment on
  individual votes.
- Check get_votes before naming a winner. Do not book while people are still
  voting unless someone in the chat tells you to go ahead.
- book_option drives a real browser through a restaurant or venue's booking
  page — never a flight, a hotel room or a ticket, which go to
  add_to_itinerary. Call it at most once per plan. It needs the full name and
  email the reservation goes under: if nobody has given them, ask who is
  booking and for their email, and never make either up.
- Payment setup is not yours to run. If someone wants you to be able to pay for
  things, tell them to text you "set up payments" in a direct chat; "remove my
  payments" undoes it. Never ask for or accept card details in the chat. You
  have no way to connect, change or remove anyone's payments, so never say you
  did: give them the exact words to text instead.
- You cannot pay for anything yourself, and you never decide who pays. Paying
  is handled outside you: whoever gives a cart a thumbs up, or texts "i'll
  pay", covers it, and the chat is told how it went. If asked how to pay, say
  exactly that in one line. shop_build_cart posts one store's cart card with
  a checkout link a human can also complete by hand. When the group changes that order,
  call it again with that store's whole new cart; never describe cart changes in
  text.
- An event usually shops at several stores (cake from one, balloons from
  another). Each store has its own cart and its own checkout: build them one
  store at a time, and never put one store's variantId in another store's cart.
  The "Shopping list" below is every cart so far. Once the shopping is settled,
  or when someone asks what it all comes to, call show_shopping_list once.
- The Invoice below is who paid what and who owes whom, worked out from the
  carts and every logged expense, split across everyone going. When someone
  says they paid for something outside a cart (the bill, a deposit, the cab),
  call add_expense with the amount they gave; when someone paid another person
  back, add_expense with "for" naming that one person. Asked what they owe or
  how to split it, answer from the Invoice in one line or call show_invoice to
  post it. It posts itself once every cart is paid, so do not post it after
  every change, and never do the arithmetic yourself.
- Orders ship to whoever pays for them unless the group wants one place for
  the whole event ("send it all to the party", "ship everything to Sam's"):
  then call set_delivery with to=event. Use to=venue only when someone
  explicitly asks for it to go to the venue itself. Never ask for, repeat or
  guess a street address in the chat: it is typed on a private form.
- Size quantities to the headcount below, not to the number of people talking:
  if 6 are in, order for 6. If nobody has been asked yet and the amount depends
  on it, ask who is in (ask_rsvp) before building a cart. When the headcount
  changes after a cart is built, say so and offer to resize it.
- Quote shop prices exactly as shop_search returns them. Stores known to work:
${KNOWN_SHOPS.map((s) => `  ${s.shop} (${s.sells})`).join("\n")}
  Other Shopify stores work too; if shop_search says a domain is not one, move on.
  Pick the store by what it sells, not the first on the list. When a store has
  nothing that fits, search one or two others that could before saying so.
  A list of different things (sunscreen and swim shorts) usually means a
  different store for each: search each where it is sold, one cart per store.
- When someone asks for a game ("let's play a game", "make a trivia game about
  X"), call make_game straight away. With no topic named, do not ask for one:
  pick it yourself from what this chat is about (the plan, the city, what
  people here are into). The game card posts itself; people join and play on
  the card. Never list the questions in text.
- When someone names a song for the group playlist, call add_song once per
  song, exactly as they said it. The playlist card in the thread updates
  itself; never list the tracks in text. show_playlist reposts the card when
  someone asks to see or play it.
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

/** Today as YYYY-MM-DD in Toronto, the demo's zone; date-only comparisons use it. */
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

const MAX_STEPS = 8;
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

/** What an invoice ticket showed: the same entries, amounts and payers mean the same ticket. */
const invoiceKey = (inv: Extract<Invoice, { ok: true }>) => JSON.stringify(inv.entries.map((e) => [e.id, e.amount, e.who]));

/**
 * One instance per iMessage group chat, named by the Linq chat id. Public plan
 * state lives in `this.state` and is pushed to every open vote page over
 * WebSocket; anything private (transcript, handles, who voted for what) lives
 * in this object's own SQLite database and never leaves the server.
 */
/**
 * The SDK works out which binding an agent lives under from its class name, and
 * index.ts exports this class wrapped by Sentry, whose name is not "PlanAgent".
 * Left to guess, every workflow launch fails ("Could not detect Agent binding
 * name") — research, availability, booking and paying all at once. So say it.
 */
const WORKFLOW_OPTS = { agentBinding: "PlanAgent" } as const;

export class PlanAgent extends Agent<Env, PlanState> {
  initialState: PlanState = EMPTY_PLAN;

  /** Set when something worth celebrating just happened; consumed by the next text sent. */
  private mediaInFlight = new Set<string>();
  private coverInFlight = new Map<string, Promise<MediaFile>>();
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
    return (this.runs ??= new RunRecorder(this.env, this.name, (promise) => this.ctx.waitUntil(promise), {
      load: () => this.getMeta("runs_last"),
      save: (json) => this.setMeta("runs_last", json),
    }));
  }

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS plan_media (id TEXT PRIMARY KEY, data TEXT NOT NULL, type TEXT NOT NULL)`;
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
    this.sql`CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY, json TEXT NOT NULL, ts INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      level TEXT NOT NULL, event TEXT NOT NULL, fields TEXT NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS watches (item_id TEXT PRIMARY KEY, snapshot TEXT, failures INTEGER NOT NULL DEFAULT 0, started INTEGER NOT NULL, checked INTEGER)`;
    this.queuePlanMedia();
  }

  /**
   * Message bodies for the run viewer, when LOG_BODIES is
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
    const { telemetryExported, ...values } = fields;
    fields = safeFields({ ...traceFields(), ...values });
    fields = log(level, "agent", event, { chat: short(this.name), ...fields }, false, telemetryExported !== true);
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
    // A demo is run more than once. Handled in code so it costs nothing, cannot
    // be talked out of, and wipes the message that asked for it too.
    if (/^\s*(@\S+\s+)?\/reset\s*$/i.test(msg.text)) {
      await this.resetChat();
      await this.say("reset. fresh start, and i still know who you are");
      return;
    }
    if (await this.handlePayText(msg)) return;

    const wake = this.wakeReason(msg);
    // Someone asking again is what re-arms research after a failure.
    if (wake) this.setMeta("research_failed", "0");
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

  /**
   * Back to a chat that has never planned anything, for running a demo again.
   *
   * Goes: the transcript, the plan, votes, carts, the itinerary, expenses,
   * RSVPs, the playlist, games, research, tickets, watches and every timer.
   * Stays: who is in the chat and their names, where the group is based, and
   * that they have been onboarded. What people told the agent about themselves
   * (profile, address, payments) lives with the person, not the chat, and is
   * untouched. Run history stays too: a reset is itself worth seeing there.
   * The thread on people's phones is theirs; nothing can unsend it.
   */
  async resetChat() {
    for (const s of await this.listSchedules().catch(() => [])) await this.cancelSchedule(s.id).catch(() => false);
    // Best effort: an abandoned store cart expires on its own.
    for (const c of this.carts()) {
      const cartId = this.getMeta(`cart_id:${shopKey(c.shop)}`);
      if (cartId) await cancelCart(this.env, shopKey(c.shop), cartId).catch(() => false);
    }

    this.sql`DELETE FROM messages`;
    this.sql`DELETE FROM votes`;
    this.sql`DELETE FROM research`;
    this.sql`DELETE FROM product_names`;
    this.sql`DELETE FROM tickets`;
    this.sql`DELETE FROM rsvps`;
    this.sql`DELETE FROM games`;
    this.sql`DELETE FROM watches`;
    this.sql`DELETE FROM plan_media`;
    const KEEP = ["is_group", "area", "onboarded", "profile_link_sent", "profile_card_sent", "profile_card_hold", "profile_ack_at", "contact_card_shared", "location_seen", "runs_last"];
    for (const { key } of this.sql<{ key: string }>`SELECT key FROM meta`) {
      if (!KEEP.includes(key)) this.sql`DELETE FROM meta WHERE key = ${key}`;
    }
    // The version keeps climbing so an open vote page or card redraws as empty.
    this.setState({ ...EMPTY_PLAN, version: this.state.version + 1 });
    this.note("info", "chat.reset", { kept: this.participants().length });
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
    if (this.cardIds().includes(id) || this.planPhotoIds().includes(id)) return true;
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
    // A thumbs up or a heart on a cart (its card or its photo) is "this one's on me".
    const cart = this.carts().find((c) => this.cartMessages(shopKey(c.shop)).includes(r.messageId));
    if (cart) {
      if (r.reactionType !== "like" && r.reactionType !== "love") return void this.note("info", "reaction.ignored", { reason: "not a pay tapback", type: r.reactionType });
      await this.startPay(shopKey(cart.shop), r.from, "reaction");
      return;
    }
    // The shopping list is every cart at once, and a thumbs up on it means the
    // same thing as on a cart. With one cart unpaid that is the one; with
    // several, which one is theirs to say.
    const onList = this.sql<Row>`SELECT 1 FROM tickets WHERE kind = 'list' AND message_id = ${r.messageId}`.length > 0;
    if (onList) {
      if (r.reactionType !== "like" && r.reactionType !== "love") return void this.note("info", "reaction.ignored", { reason: "not a pay tapback", type: r.reactionType });
      const unpaid = this.carts().filter((c) => !c.paidBy);
      if (!unpaid.length) return void this.note("info", "reaction.ignored", { reason: "every cart is paid", type: r.reactionType });
      if (unpaid.length > 1) return void (await this.say(`which one? thumbs up the cart you're covering: ${unpaid.map((c) => c.shop).join(", ")}`));
      await this.startPay(shopKey(unpaid[0].shop), r.from, "reaction");
      return;
    }
    if (!this.cardIds().includes(r.messageId) && !this.planPhotoIds().includes(r.messageId)) {
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
    // A tap on the card carries no phone number, so it cannot be matched to a
    // name. Each one still is somebody's vote: it stands for one of the people
    // not otherwise accounted for, or "everyone has voted" never comes true
    // for a group that votes on the card.
    const unvoted = people.filter((p) => !voted.has(p.handle));
    const taps = votes.filter((v) => v.voter.startsWith("web:")).length;

    this.setState({
      ...next,
      counts: Object.fromEntries(
        next.options.map((o) => [o.id, votes.filter((v) => v.option_id === o.id).length]),
      ),
      awaiting:
        next.status === "voting"
          ? unvoted.slice(0, Math.max(0, unvoted.length - taps)).map((p) => this.label(p.handle, people))
          : [],
      going: this.splitNames(),
      version: this.state.version + 1,
    });
    this.queuePlanMedia();
  }

  private queuePlanMedia() {
    if (!this.state.title.trim()) return;
    const key = mediaKey(this.state);
    if (this.getMeta("media_requested") === key) return;
    this.setMeta("media_requested", key);
    this.ctx.waitUntil(this.schedule(1, "enrichPlanMedia").catch(() => {
      this.setMeta("media_requested", "");
    }));
  }

  /** Generate an event cover once; fetch company logos independently. */
  async enrichPlanMedia() {
    const snapshot = this.state;
    const key = mediaKey(snapshot);
    if (!snapshot.title.trim() || this.getMeta("media_completed") === key) return;
    if (this.mediaInFlight.has(key)) return;
    this.mediaInFlight.add(key);
    try {
      const cached = JSON.parse(this.getMeta("generated_cover") || "null") as { title: string; cover: NonNullable<PlanState["media"]>["cover"] } | null;
      const input = cached?.title === snapshot.title && cached.cover?.generated
        ? { ...snapshot, media: { title: snapshot.title, logos: snapshot.media?.logos ?? {}, cover: cached.cover } }
        : snapshot;
      const media = await collectPlanMedia(input, () => {
        let pending = this.coverInFlight.get(snapshot.title);
        if (!pending) {
          pending = generateCover(snapshot.title, this.env);
          this.coverInFlight.set(snapshot.title, pending);
        }
        return pending;
      }, async (file: MediaFile) => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.data));
        const id = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
        this.sql`INSERT OR IGNORE INTO plan_media (id, data, type) VALUES (${id}, ${file.data}, ${file.type})`;
        return `/api/plan-media/${encodeURIComponent(this.name)}/${id}`;
      });
      if (media.cover?.generated) this.setMeta("generated_cover", JSON.stringify({ title: snapshot.title, cover: media.cover }));
      // A slow generation must never replace media belonging to a newer event.
      if (mediaKey(this.state) !== key) return;
      this.publish({ media });
      const incomplete = !media.cover || mediaCompanies(snapshot).some(domain => !media.logos[domain]);
      if (incomplete && this.getMeta("media_retried") !== key) {
        this.setMeta("media_retried", key);
        await this.schedule(60, "enrichPlanMedia");
      } else this.setMeta("media_completed", key);
    } finally { this.mediaInFlight.delete(key); this.coverInFlight.delete(snapshot.title); }
  }

  async getPlanMedia(id: string): Promise<MediaFile | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    return this.sql<MediaFile>`SELECT data, type FROM plan_media WHERE id = ${id}`[0] ?? null;
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

  /**
   * Message ids of the open ballot's ticket photos, newest last. The ballot is
   * two messages, the photo and the card under it, and a phone reacts to or
   * replies to the photo far more often than to the card: both belong to it.
   * The list starts over with each ballot, so a tapback on the previous
   * ballot's photo, still visible up the thread, never lands in this one.
   */
  private planPhotoIds(): string[] {
    return JSON.parse(this.getMeta("plan_photo_ids") ?? "[]");
  }

  /** Keeps the playlist card's track count current: first change posts it, later ones redraw it. */
  private async syncMusicCard() {
    const count = (this.state.playlist ?? []).length;
    const existing = this.getMeta("music_card_id");
    if (existing) {
      const newId = await timed("agent", "music_card.update", { tracks: count }, () => updateMusicCard(this.env, existing, this.name, count), this.note).catch(() => undefined);
      if (newId) this.setMeta("music_card_id", newId);
      return;
    }
    const id = await timed("agent", "music_card.out", { tracks: count }, () => sendMusicCard(this.env, this.name, this.name, count), this.note).catch(() => undefined);
    if (id) this.setMeta("music_card_id", id);
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

  /**
   * Called over RPC by /api/widget. The stub does not proxy the `state`
   * property, so the native widget reads it through this method instead.
   */
  async widgetState(): Promise<PlanState> {
    return this.state;
  }

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
    // With our extension configured the ticket ships as a native app card;
    // without it, the rendered PNG photo as before.
    const messageId = await timed("agent", "ticket.out", { kind, tone: ticket.tone, id, native: hasAppIdentity(this.env) }, () =>
      hasAppIdentity(this.env)
        ? sendTicketCard(this.env, this.name, this.name, id, { title: ticket.title, metaLeft: ticket.metaLeft, stubBig: ticket.stub.big, stubLabel: ticket.stub.label })
        : sendPhoto(this.env, this.name, url),
      this.note,
    ).catch(
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
    // An open ballot is the plan card alone: it is the poll, tapped to vote. A
    // static "react to vote" ticket beside it was a second, worse ballot.
    if (this.state.status === "voting") return void this.setMeta("plan_photo_ids", "[]");
    const key = this.state.status === "booked" ? `booked:${this.state.chosenOptionId}` : this.state.options.map((o) => o.title).join("|");
    // The same ballot is not posted twice in a row — but a ballot posted a while
    // ago is far up the thread by now, and re-proposing it means "show me again".
    const fresh = Date.now() - Number(this.getMeta("plan_ticket_at") ?? 0) < CARD_STALE_MS;
    if (this.getMeta("plan_ticket_key") === key && fresh) return;
    // A different ballot, or the confirmation once booked, starts the photo
    // list over: only this ballot's photos take votes.
    if (this.getMeta("plan_ticket_key") !== key) this.setMeta("plan_photo_ids", "[]");
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
    const url = `${this.env.PUBLIC_BASE_URL}/p/${token}`;
    // The same tappable card onboarding offers, so asking for the profile later
    // gets the card again rather than a bare address. The plain link is what is
    // left if the card cannot be sent.
    const id = await timed(
      "agent",
      "profile_card.out",
      { asked: true },
      () => sendLinkCard(this.env, this.name, { title: "Your profile", subtitle: "Change anything, anytime.", button: "Open", url }),
      this.note,
    ).catch(() => undefined);
    if (id) this.sql`INSERT INTO messages (linq_id, direction, body, ts) VALUES (${id}, 'out', ${"[profile card]"}, ${Date.now()})`;
    else await this.say(`${intro}${url}`);
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
        // A plain link first (it opens in Safari, where the page works); Linq's inline card only as a fallback.
        const link = await attachLink(this.env, this.name, msg.from).catch((err: unknown) => void this.note("warn", "payments.attach_link_failed", errorFields(err)));
        if (link) {
          this.note("info", "payments.attach_link", {});
          await this.say(`you're connected. one more step, add a card: ${link}`, { screenEffect: "confetti" });
          // The link is theirs alone; the transcript the model reads gets a placeholder.
          this.sql`UPDATE messages SET body = ${"you're connected. one more step, add a card: [private link]"} WHERE direction = 'out' AND body LIKE ${`%${link}%`}`;
          await this.say("if safari says it blocked a pop-up, tap allow (or settings > safari > block pop-ups off) and reload. i can only ever charge the card for things you approve, one at a time");
        } else {
          await this.say("you're connected. one more step: add a card below. i can only ever charge it for things you approve, one at a time", { screenEffect: "confetti" });
          await timed("agent", "payments.attach_card", {}, () => sendAttachCard(this.env, this.name), this.note).catch(() => undefined);
        }
      } catch (err) {
        this.note("warn", "payments.verify_failed", errorFields(err));
        await this.say("that code didn't work. it may have expired. text \"set up payments\" to get a new one");
        this.setMeta("pay_connect_id", "");
      }
      return true;
    }

    // Loose on purpose (typos, "payment method", "my debit card"): a near miss
    // would fall through to the model, which cannot do any of this and must not pretend to.
    const THING = "(pay\\w*|(credit |debit )?card\\w*|wallet\\w*)";
    if (new RegExp(`\\b(set ?up|connect|add|change|update)\\b.{0,12}\\b${THING}`, "i").test(msg.text)) {
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

    if (new RegExp(`\\b(remove|disconnect|forget|delete|unlink|revoke|cancel)\\b.{0,12}\\b${THING}`, "i").test(msg.text)) {
      await revokePayments(this.env, this.name, msg.from).catch((err: unknown) => this.note("warn", "payments.revoke_failed", errorFields(err)));
      await peopleStore(this.env).save(msg.from, { payments: undefined });
      this.note("info", "payments.revoked", { who: mask(msg.from) });
      await this.say("done. i can no longer request payments from you. your card in the wallet itself is yours to remove");
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------- paying
  // One tapback or one short text, and that person pays for that cart. All of
  // it is code: who pays, how much, and where is never the model's call. The
  // guards, in order: payments switched on, the cart unpaid and not already
  // being paid, the payer's wallet connected, an address on file, and a cap the
  // real total (known only once the store has priced shipping) must sit under.

  private cartMessages(shop: string): string[] {
    return JSON.parse(this.getMeta(`cart_msgs:${shop}`) || "[]");
  }

  private rememberCartMessage(shop: string, id: string) {
    this.setMeta(`cart_msgs:${shop}`, JSON.stringify([...this.cartMessages(shop).filter((x) => x !== id), id].slice(-20)));
  }

  /** "i'll pay", "charge me", "pay": only ever the whole message, and only while a cart is unpaid. */
  private async handlePayText(msg: { from: string; text: string }): Promise<boolean> {
    if (!/^\s*(@\S+\s+)?(i'?ll (pay|get (it|this|that))|i got (it|this|that)|charge (me|it to me)|put it on me|pay( for (it|this|that))?( now)?)\s*[.!]*\s*$/i.test(msg.text)) return false;
    const unpaid = this.carts().filter((c) => !c.paidBy);
    if (!unpaid.length) return false; // not about a cart: leave it to the conversation
    if (unpaid.length > 1) {
      await this.say(`which one? thumbs up the cart you're covering: ${unpaid.map((c) => c.shop).join(", ")}`);
      return true;
    }
    await this.startPay(shopKey(unpaid[0].shop), msg.from, "text");
    return true;
  }

  private async startPay(shop: string, payer: string, source: "reaction" | "text" | "resume") {
    const cart = this.carts().find((c) => shopKey(c.shop) === shop);
    if (!cart) return;
    const who = this.label(payer);
    if (cart.paidBy) return void (await this.say(`${cart.shop} is already paid (${cart.paidBy})`));
    const running = Number(this.getMeta(`pay_running:${shop}`) || 0);
    if (Date.now() - running < 11 * 60_000) return void this.note("info", "pay.ignored", { reason: "already paying this cart", shop });
    this.note("info", "pay.asked", { shop, who: mask(payer), source });

    // The wallet: Linq is the authority, the profile flag only a cache of it.
    // Both are needed before anything is decided, so they are read together.
    const store = peopleStore(this.env);
    const [profiles, wallet] = await Promise.all([
      store.getMany([payer]),
      paymentConnection(this.env, this.name, payer).catch((): PaymentConnection => ({ status: "not_connected" })),
    ]);
    const profile = profiles[payer];
    if (wallet.status !== "connected" && !(wallet.simulated && profile?.payments === "connected")) {
      this.note("info", "pay.needs_wallet", { who: mask(payer) });
      await this.say(`${who}, you haven't set up payments yet. text me "set up payments" in a direct message (takes a minute), then thumbs up the cart again`);
      return;
    }
    // Where it ships. An event address belongs to the chat and is never used
    // unseen: each payer opens the form with it filled in and saves it once.
    // Without one, it is the payer's own address, asked for the first time only.
    const delivery = this.delivery();
    const choice = this.getMeta(`ship_choice:${payer}`);
    const toEvent = delivery && choice !== "own";
    const contact = profile?.shipTo ?? profile?.contact;
    const shipTo: ShipTo | undefined = !toEvent
      ? profile?.shipTo
      : delivery.confirmed && choice === `event:${delivery.stamp}` && contact && isComplete(delivery.address)
        ? { name: contact.name, email: contact.email, ...delivery.address }
        : undefined;
    if (!shipTo) {
      // Asked for on their own private page, and the payment picks itself back up when it is saved.
      this.setMeta(`pay_waiting:${payer}`, shop);
      const token = await store.tokenFor(payer);
      this.note("info", "pay.needs_address", { who: mask(payer), event: !!toEvent });
      await sendLinkCard(this.env, this.name, {
        title: toEvent ? (delivery.confirmed || delivery.source === "venue" ? "Ship it to the event?" : "Where is the event?") : "Where should it ship?",
        subtitle: toEvent
          ? `${who}: check the address and save. I'll pay for ${cart.shop} as soon as you do.`
          : `${who}: one time only. I'll pay for ${cart.shop} as soon as it's saved.`,
        button: toEvent && (delivery.confirmed || delivery.source === "venue") ? "Check address" : "Add address",
        url: `${this.env.PUBLIC_BASE_URL}/p/${token}/ship?chat=${encodeURIComponent(this.name)}`,
      }).catch((err: unknown) => this.note("warn", "pay.address_card_failed", errorFields(err)));
      return;
    }

    this.setMeta(`pay_running:${shop}`, String(Date.now()));
    const params: PayParams = {
      pay: true,
      chat: this.name,
      shop,
      checkoutUrl: cart.checkoutUrl,
      payer,
      shipTo,
      capCents: Number(this.env.PAY_CAP_CENTS) || 6000,
      key: crypto.randomUUID(),
    };
    const workflowId = await this.runWorkflow("BOOKING_WORKFLOW", params, WORKFLOW_OPTS);
    this.note("info", "pay.started", { workflowId: short(workflowId), shop, who: mask(payer), live: this.env.PAYMENTS_LIVE === "true" });
    await this.say(`on it, ${who}. checking out at ${cart.shop}`);
  }

  /** Called from the address page once the person has saved where to ship. */
  async payResume(payer: string) {
    const shop = this.getMeta(`pay_waiting:${payer}`);
    if (!shop) return;
    this.setMeta(`pay_waiting:${payer}`, "");
    await this.startPay(shop, payer, "resume");
  }

  // ------------------------------------------------------------------ delivery
  // One address for the whole event, held here rather than on a person. Like a
  // person's own address it lives outside public state and is never shown to
  // the model, which learns only that one is set.

  private delivery(): Delivery | undefined {
    const raw = this.getMeta("delivery");
    return raw ? (JSON.parse(raw) as Delivery) : undefined;
  }

  /** A new stamp, so everyone who said "ship here" to the old address sees the form again. */
  private setDelivery(next: Omit<Delivery, "stamp"> | undefined) {
    this.setMeta("delivery", next ? JSON.stringify({ ...next, stamp: crypto.randomUUID().slice(0, 8) }) : "");
  }

  private deliveryContext(): string {
    const d = this.delivery();
    if (!d) return "each order ships to whoever pays for it.";
    const where = d.source === "venue" ? `the venue (${d.label})` : "the event";
    return `everything ships to ${where}; ${d.confirmed ? "the address is on file" : "the first person to pay confirms the address on a form"}. You never see it.`;
  }

  /** The address page asks what to prefill. Only someone in this chat is told. */
  async deliveryFor(handle: string): Promise<Pick<Delivery, "source" | "label" | "address" | "confirmed"> | null> {
    const d = this.delivery();
    if (!d || !this.participants().some((p) => p.handle === handle)) return null;
    return { source: d.source, label: d.label, address: d.address, confirmed: d.confirmed };
  }

  /** The address page, on save: this person checked the event address, perhaps correcting it. */
  async deliverySaved(handle: string, address: Address) {
    const d = this.delivery();
    if (!d || !this.participants().some((p) => p.handle === handle)) return;
    const same = d.confirmed && JSON.stringify(d.address) === JSON.stringify(address);
    if (!same) this.setDelivery({ ...d, address, confirmed: true });
    this.setMeta(`ship_choice:${handle}`, `event:${this.delivery()!.stamp}`);
    this.note("info", "delivery.saved", { who: mask(handle), source: d.source, changed: !same });
  }

  /** The address page, on save: this person is sending their order home instead. */
  async deliveryDeclined(handle: string) {
    if (!this.delivery()) return;
    this.setMeta(`ship_choice:${handle}`, "own");
    this.note("info", "delivery.declined", { who: mask(handle) });
  }

  /** Called over RPC by the pay workflow. */
  async payProgress(stage: string, fields: Fields = {}) {
    if (stage === "browser" && typeof fields.liveUrl === "string") this.setMeta("live_url", fields.liveUrl);
    const { liveUrl: _live, ...rest } = fields;
    this.note("info", `pay.${stage}`, rest);
  }

  /** The person has to do something in their wallet before the card can be minted. */
  async payNeedsAction(payer: string, kind: "needs_card" | "needs_approval", url: string, total: string, shop: string) {
    this.note("info", `pay.${kind}`, { who: mask(payer), shop, total });
    // A bare link, not a card: a card opens in an in-app webview, where the
    // passkey these pages need does not work. iMessage opens a plain url in Safari.
    const who = this.label(payer);
    await this.say(kind === "needs_approval" ? `${who}, approve ${total} at ${shop} (one tap with your passkey): ${url}` : `${who}, add a card to pay ${total} at ${shop}, then it goes through on its own: ${url}`);
  }

  async payFinished(result: PayResult) {
    this.setMeta(`pay_running:${result.shop}`, "");
    const who = this.label(result.payer);
    this.note(result.status === "paid" ? "info" : "warn", "pay.finished", { shop: result.shop, status: result.status, total: result.total, who: mask(result.payer), shot: result.shotId });
    const carts = this.carts();
    const cart = carts.find((c) => shopKey(c.shop) === result.shop);

    // A demo with payments off still has to end somewhere. With PAY_MOCK the
    // dry run — a real checkout, really priced, nothing charged — is played out
    // as a purchase: the cart goes paid, the receipt and the split follow. It is
    // marked as a mock in the run log, and PAYMENTS_LIVE always wins over it.
    if (result.status === "dry_run" && cart && this.env.PAY_MOCK === "true" && this.env.PAYMENTS_LIVE !== "true") {
      this.note("warn", "pay.mocked", { shop: result.shop, total: result.total, who: mask(result.payer) });
      result = { ...result, status: "paid", confirmation: `DEMO-${crypto.randomUUID().slice(0, 6).toUpperCase()}`, detail: "demo mode: nothing was charged" };
    }

    if (result.status === "paid" && cart) {
      const paid = { ...cart, paidBy: who, total: result.total ?? cart.total };
      this.saveCarts(carts.map((c) => (c === cart ? paid : c)));
      if (result.orderUrl) {
        const item = await this.addItineraryItem({ kind: "order", title: result.shop, status: "watching", paidBy: who, url: result.orderUrl, watch: { order: { url: result.orderUrl, shop: result.shop } } });
        this.sql`INSERT OR REPLACE INTO watches (item_id, snapshot, failures, started, checked) VALUES (${item.id}, NULL, 0, ${Date.now()}, NULL)`;
        await this.scheduleWatches();
      }
      await this.postTicket("cart", cartTicket(paid, this.headcount()));
      // The store's receipt first, then — if that was the last one — the split.
      await this.invoiceIfSettled();
      await this.say(`paid. ${who} covered ${result.shop}: ${result.total ?? cart.total} with shipping and tax${result.confirmation ? `, order ${result.confirmation}` : ""}. ${result.detail ?? "the receipt goes to their email"}`, { screenEffect: "confetti" });
      return;
    }
    const cap = `$${((Number(this.env.PAY_CAP_CENTS) || 6000) / 100).toFixed(0)}`;
    const line: Record<Exclude<PayResult["status"], "paid">, string> = {
      dry_run: `dry run: ${result.shop} comes to ${result.total} with shipping and tax, and the card form is ready. nothing was charged (payments are switched off)`,
      over_cap: `${result.shop} comes to ${result.total}, over my ${cap} limit per purchase, so i didn't pay. here's the checkout: ${cart?.checkoutUrl ?? ""}`,
      needs_connection: `${who}, your wallet isn't connected. text me "set up payments" in a direct message`,
      not_approved: `${who}, i didn't get your approval in time so nothing was charged. thumbs up the cart to try again`,
      no_card_form: `${result.shop} doesn't take a card on its checkout page, so i can't pay there. here's the checkout: ${cart?.checkoutUrl ?? ""}`,
      failed: result.unsure
        ? `${who}, i pressed pay at ${result.shop} but ${result.detail ?? "the store never confirmed"}. don't retry until you've checked your email for a receipt`
        : `couldn't finish at ${result.shop}: ${result.detail ?? "something went wrong"}. nothing was charged. here's the checkout: ${cart?.checkoutUrl ?? ""}`,
    };
    await this.say(line[result.status as Exclude<PayResult["status"], "paid">]);
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
        this.rememberCartMessage(shop, id); // a thumbs up on the photo counts as one on the cart
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
      if (newId) {
        this.setMeta(`cart_message_id:${shop}`, newId);
        this.rememberCartMessage(shop, newId);
      }
    } else {
      const id = await sendCard(this.env, this.name, this.name, this.state, 0, "cart", shop);
      this.setMeta(`cart_message_id:${shop}`, id);
      this.rememberCartMessage(shop, id);
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

  private itinerary(): ItineraryItem[] {
    return this.state.itinerary ?? [];
  }

  private saveItinerary(items: ItineraryItem[]) {
    this.publish({ itinerary: items });
  }

  private async addItineraryItem(item: Omit<ItineraryItem, "id">): Promise<ItineraryItem> {
    const taken = new Set(this.itinerary().map((i) => i.id));
    let id = "";
    do id = `i${crypto.randomUUID().slice(0, 4)}`;
    while (taken.has(id));
    const added: ItineraryItem = { id, ...item };
    this.saveItinerary([...this.itinerary(), added]);
    this.note("info", "itinerary.added", { id, kind: item.kind, status: item.status, title: item.title.slice(0, 60) });
    return added;
  }

  private async postItinerary() {
    const items = this.itinerary();
    if (!items.length) return;
    await this.postTicket("itinerary", itineraryTicket(items, this.state.title));
  }

  /** One line per stop for the model. */
  private itineraryContext(): string {
    const items = this.itinerary();
    if (!items.length) return "nothing settled yet";
    return items.map((i) => `${i.id} ${ITEM_EMOJI[i.kind]} ${i.title} — ${i.status}${i.note ? ` (${i.note})` : ""}${i.price ? `, ${i.price}` : ""}${i.lastUpdate ? `; ${i.lastUpdate}` : ""}`).join(" | ");
  }

  /**
   * A source failed: log the cause, tell the model something it can say. The
   * cause travels with it, so a key or plan problem (a 402 on the proxy, say)
   * is never softened into "nothing matched": on a real phone, "did not answer"
   * became "the search came up empty again", which sent the person off to
   * change dates that were never the problem.
   */
  private sourceFailure(err: unknown, what: string): string {
    this.note("warn", "source.failed", { what, ...errorFields(err) });
    if (err instanceof SourceError && err.code === "no_browserbase") return `${what} needs BROWSERBASE_API_KEY, which is not set here. Say you can't look that up right now.`;
    const cause = err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120);
    return `${what} could not be reached (${cause}). This is a system problem on this side, not a lack of results: say in one line that the lookup isn't working right now, do NOT say nothing matched or ask them to change dates or airports, and do not call it again this turn.`;
  }

  private static WATCH_SECONDS = 15 * 60;

  /** One timer at a time: a watch added while one is pending does not add a second. */
  private async scheduleWatches() {
    if (!this.activeWatches().length) return;
    if (this.getMeta("watch_timer") === "1") return;
    // Set the flag only once schedule() has actually resolved: if it throws,
    // the flag must not be left set with no timer behind it.
    await this.schedule(PlanAgent.WATCH_SECONDS, "checkWatches");
    this.setMeta("watch_timer", "1");
  }

  private activeWatches(): { item: ItineraryItem; row: { snapshot: string | null; failures: number; started: number } }[] {
    const now = Date.now();
    const out: { item: ItineraryItem; row: { snapshot: string | null; failures: number; started: number } }[] = [];
    for (const item of this.itinerary()) {
      if (!item.watch || item.status === "done") continue;
      const row = this.sql<{ snapshot: string | null; failures: number; started: number }>`SELECT snapshot, failures, started FROM watches WHERE item_id = ${item.id}`[0];
      if (!row) continue;
      let snap: FlightStatus | OrderStatus | undefined;
      if (row.snapshot) {
        try {
          snap = JSON.parse(row.snapshot) as FlightStatus | OrderStatus;
        } catch (err) {
          this.note("warn", "watch.snapshot_bad", { id: item.id, ...errorFields(err) });
        }
      }
      const active = "flight" in item.watch ? flightWatchActive(snap as FlightStatus | undefined, now) : orderWatchActive(row.started, snap as OrderStatus | undefined, now);
      if (active) out.push({ item, row });
    }
    return out;
  }

  /**
   * Scheduled: read every active watch, post only what changed, reschedule
   * while anything is still worth watching. Three failures in a row on one
   * item say so once and back off to hourly for it.
   */
  async checkWatches() {
    this.setMeta("watch_timer", "");
    try {
      const watches = this.activeWatches();
      this.note("info", "watch.check", { active: watches.length });
      // Two phases: every status is read at once (each is a slow proxied
      // fetch of a different site), then what changed is posted in itinerary
      // order, so the chat reads the same as it did when this was one loop.
      const due = watches.filter(({ item, row }) => {
        if (row.failures >= 3 && row.failures % 4 !== 3) {
          this.sql`UPDATE watches SET failures = ${row.failures + 1} WHERE item_id = ${item.id}`;
          return false; // hourly, in 15-minute ticks
        }
        return true;
      });
      const read = await Promise.allSettled(
        due.map(async ({ item }) => {
          const watch = item.watch!; // activeWatches only returns items with one
          if ("flight" in watch) {
            const next = await flightStatus(this.env, watch.flight.ident);
            if (!next) throw new Error("no status");
            return next;
          }
          return orderStatus(this.env, watch.order.url);
        }),
      );
      for (const [i, { item, row }] of due.entries()) {
        const watch = item.watch!;
        const got = read[i];
        try {
          if (got.status === "rejected") throw got.reason;
          const prev = row.snapshot ? JSON.parse(row.snapshot) : undefined;
          if ("flight" in watch) await this.applyWatch(item, got.value, diffFlight(prev, got.value as FlightStatus), prev);
          else await this.applyWatch(item, got.value, diffOrder(prev, got.value as OrderStatus, watch.order.shop), prev);
        } catch (err) {
          const failures = row.failures + 1;
          this.sql`UPDATE watches SET failures = ${failures}, checked = ${Date.now()} WHERE item_id = ${item.id}`;
          this.note("warn", "watch.failed", { id: item.id, failures, ...errorFields(err) });
          if (failures === 3) await this.say(`I can't reach ${"flight" in watch ? "FlightAware" : watch.order.shop} for ${item.title} right now${item.url ? `: ${item.url}` : ""}`);
        }
      }
    } finally {
      await this.scheduleWatches();
    }
  }

  /**
   * Post the lines, then persist the snapshot and settle the item once it is
   * over: an unsent line survives to the next tick. For a flight, the
   * persisted delay holds at the last-announced value (`baselineFor`) so a
   * creeping delay is not lost between the 15-minute steps that get posted.
   */
  private async applyWatch(item: ItineraryItem, next: FlightStatus | OrderStatus, lines: string[], prev?: FlightStatus | OrderStatus) {
    for (const line of lines) {
      await this.say(line);
      this.note("info", "watch.posted", { id: item.id, line: line.slice(0, 80) });
    }
    const snapshot = item.watch && "flight" in item.watch ? baselineFor(prev as FlightStatus | undefined, next as FlightStatus, lines) : next;
    this.sql`UPDATE watches SET snapshot = ${JSON.stringify(snapshot)}, failures = 0, checked = ${Date.now()} WHERE item_id = ${item.id}`;
    const over = "delivered" in next ? next.delivered : next.status === "landed" || next.status === "cancelled";
    if (lines.length || over) {
      const last = lines.at(-1);
      this.saveItinerary(this.itinerary().map((i) => (i.id === item.id ? { ...i, ...(over ? { status: "done" as const } : {}), ...(last ? { lastUpdate: last.replace(/^\S+ (is |now )?/, "").replace(/\.\s*https?:\/\/\S+$/, "") } : {}) } : i)));
    }
    if (over) await this.postItinerary();
  }

  /** Simulator: the store shipped (or delivered) this order. */
  async devShipped(itemId: string, snap: OrderStatus) {
    const item = this.itinerary().find((i) => i.id === itemId);
    if (!item || !item.watch || !("order" in item.watch)) return { error: `no order item ${itemId}` };
    const row = this.sql<{ snapshot: string | null }>`SELECT snapshot FROM watches WHERE item_id = ${itemId}`[0];
    const prev = row?.snapshot ? (JSON.parse(row.snapshot) as OrderStatus) : undefined;
    await this.applyWatch(item, snap, diffOrder(prev, snap, item.watch.order.shop), prev);
    return { ok: true };
  }

  /** Simulator: FlightAware now says this about the flight. */
  async devFlightSnapshot(itemId: string, snap: FlightStatus) {
    const item = this.itinerary().find((i) => i.id === itemId);
    if (!item || !item.watch || !("flight" in item.watch)) return { error: `no flight item ${itemId}` };
    const row = this.sql<{ snapshot: string | null }>`SELECT snapshot FROM watches WHERE item_id = ${itemId}`[0];
    const prev = row?.snapshot ? (JSON.parse(row.snapshot) as FlightStatus) : undefined;
    await this.applyWatch(item, snap, diffFlight(prev, snap), prev);
    return { ok: true };
  }

  /** Simulator: an order item to watch, without a real purchase. */
  async devSeedOrder(shop: string, url: string) {
    const item = await this.addItineraryItem({ kind: "order", title: shop, status: "watching", watch: { order: { url, shop } } });
    this.sql`INSERT OR REPLACE INTO watches (item_id, snapshot, failures, started, checked) VALUES (${item.id}, NULL, 0, ${Date.now()}, NULL)`;
    return { id: item.id };
  }

  /** Simulator: watch this item as a flight without reading FlightAware. */
  async devSeedFlight(itemId: string, ident: string) {
    const item = this.itinerary().find((i) => i.id === itemId);
    if (!item) return { error: `no item ${itemId}` };
    this.saveItinerary(this.itinerary().map((i) => (i.id === itemId ? { ...i, status: "watching" as const, note: ident.toUpperCase(), watch: { flight: { ident } } } : i)));
    this.sql`INSERT OR REPLACE INTO watches (item_id, snapshot, failures, started, checked) VALUES (${itemId}, NULL, 0, ${Date.now()}, NULL)`;
    return { ok: true };
  }

  /**
   * Who a cost is split across: the people who said they are in, once anyone
   * has; until then everyone in the chat.
   */
  private headcount(): number {
    return this.splitNames().length;
  }

  /** The same people, by display name, in the order they joined. */
  private splitNames(): string[] {
    const people = this.participants();
    const going = this.rsvps().going;
    return going.length ? going : people.map((p) => this.label(p.handle, people));
  }

  /**
   * A person as the model names them, resolved to the name the invoice uses.
   * The model may say "…0001" for someone the chat knows as Maya, or the name
   * outright; either way one person gets one line, not two.
   */
  private nameOf(who: string): string {
    const people = this.participants();
    const person = people.find((p) => this.label(p.handle, people) === who || `…${p.handle.slice(-4)}` === who);
    return person ? this.label(person.handle, people) : who;
  }

  // ------------------------------------------------------------------ invoice
  // Who paid what and who owes whom. Nothing is stored for it beyond the
  // expenses people log in the chat: the rest is read off the carts and the
  // headcount every time, so it can never disagree with them (src/invoice.ts).

  private expenses(): Expense[] {
    return this.state.expenses ?? [];
  }

  private invoice(): Invoice {
    return invoiceFor(this.carts(), this.expenses(), this.splitNames());
  }

  /** The whole picture for the model, so "what do I owe?" is read, not worked out. */
  private invoiceContext(): string {
    const inv = this.invoice();
    if (!inv.ok) return inv.reason === "mixed" ? "the carts are in different currencies, so it cannot be added up; quote the amounts as they are" : "nothing yet: no carts and no expenses";
    const money = (c: number) => fmtMoney(inv.symbol, c);
    const balance = (l: (typeof inv.lines)[number]) =>
      `${l.name}${l.paid ? ` paid ${money(l.paid)},` : ""} ${l.net > 0 ? `gets ${money(l.net)}` : l.net < 0 ? `owes ${money(-l.net)}` : "even"}`;
    const entries = inv.entries
      .map((e) => `[${e.kind === "cart" ? "cart" : e.id}] ${e.what} ${money(e.amount)} ${e.who ? `paid by ${e.who}` : "UNPAID"}${e.among.length && e.among.length !== inv.people.length ? ` for ${e.among.join(", ")}` : ""}`)
      .join("; ");
    return `${money(inv.total)} total across ${inv.people.length} (${inv.people.join(", ")}), ${money(inv.paid)} paid${inv.unpaid.length ? `, ${inv.unpaid.length} cart${inv.unpaid.length === 1 ? "" : "s"} still unpaid` : ""}. Balances: ${inv.lines.map(balance).join("; ")}.${
      inv.transfers.length ? ` Settle up: ${inv.transfers.map((t) => `${t.from} → ${t.to} ${money(t.amount)}`).join("; ")}.` : ""
    } Entries: ${entries}.`;
  }

  /**
   * The invoice goes out on its own the moment the last cart is paid: that is
   * when "so what do I owe?" gets asked. Once per state of the books, and never
   * for one person alone, who has nobody to split with.
   */
  private async invoiceIfSettled() {
    const inv = this.invoice();
    if (!inv.ok || !inv.settled || !this.carts().length) return;
    if (inv.lines.filter((l) => l.paid || l.share).length < 2) return;
    if (this.getMeta("invoice_key") === invoiceKey(inv)) return;
    await this.postInvoice(inv);
  }

  /** Posts the ticket and remembers what it showed, so the books are not posted twice unchanged. */
  private async postInvoice(inv: Extract<Invoice, { ok: true }>) {
    this.setMeta("invoice_key", invoiceKey(inv));
    await this.postTicket("invoice", invoiceTicket(inv));
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
    // Who is going is who the invoice splits across, and the page shows it live.
    this.publish({});
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
    // Three independent calls, made together: the bubble should not wait for
    // the receipt, and neither should wait for the card.
    const firstTime = this.getMeta("contact_card_shared") !== "1";
    const [read, typing, contactCard] = await Promise.all([
      markRead(this.env, this.name),
      this.typing(),
      firstTime ? shareContactCard(this.env, this.name) : "already shared",
    ]);
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

  // ------------------------------------------------------------------ games

  private loadGame(id: string): GameState | null {
    const row = this.sql<{ json: string }>`SELECT json FROM games WHERE id = ${id}`[0];
    return row ? (JSON.parse(row.json) as GameState) : null;
  }

  private saveGame(g: GameState) {
    this.sql`INSERT INTO games (id, json, ts) VALUES (${g.id}, ${JSON.stringify(g)}, ${Date.now()})
             ON CONFLICT(id) DO UPDATE SET json = excluded.json`;
  }

  /** Prompt -> spec -> stored game -> card in the thread. RPC from /api/widget and the make_game tool. */
  async gameCreate(topic: string, creator: string, creatorName?: string): Promise<{ id: string; title: string }> {
    const spec = await generateGame(this.env, topic.slice(0, 140));
    const id = crypto.randomUUID().slice(0, 12);
    let g = newGame(id, spec, creator);
    if (creatorName) g = joinGame(g, creator, creatorName);
    this.saveGame(g);
    this.note("info", "game.created", { id, title: spec.title, questions: spec.questions.length });
    await timed("agent", "game.card", { id }, () => sendGameCard(this.env, this.name, this.name, id, spec.title, spec.topic), this.note).catch(() => undefined);
    return { id, title: spec.title };
  }

  /** The redacted per-player view; correct answers never leave early. */
  async gameFetch(id: string, voter: string) {
    const g = this.loadGame(id);
    return g ? gameView(g, voter) : null;
  }

  async gameAct(id: string, voter: string, act: { type: "join"; name: string } | { type: "answer"; choice: number } | { type: "advance" }) {
    let g = this.loadGame(id);
    if (!g) return null;
    if (act.type === "join") g = joinGame(g, voter, act.name);
    if (act.type === "answer") {
      g = gameAnswer(g, voter, act.choice);
      // Everyone in -> straight to the reveal; nobody waits on a host.
      if (roundComplete(g)) g = gameAdvance(g);
    }
    if (act.type === "advance") g = gameAdvance(g);
    this.saveGame(g);
    return gameView(g, voter);
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
        await telemetryScope(this.note, () => traceOperation("agent.turn", "agent", {}, () => this.think()));
      } while (this.turnRequested);
    } catch (err) {
      // Scheduler callbacks have no caller to report to; without this a crash
      // mid-turn is invisible.
      this.note("error", "turn.crashed", errorFields(err));
    } finally {
      this.turnRunning = false;
      // Two unrelated tidy-ups, done together. After the first reply, not
      // before: the text introduces, the card offers the shortcut. And a turn
      // that ended in silence must not leave the bubble hanging.
      const bubbleUp = this.typingAt !== 0;
      this.typingAt = 0;
      await Promise.all([
        this.offerProfileCard().catch((err) => this.note("warn", "profile_card.failed", errorFields(err))),
        bubbleUp ? stopTyping(this.env, this.name) : undefined,
      ]);
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

    // Carts get their own "Shopping list" line below, and the itinerary its own
    // "Itinerary" line, whatever the plan's status.
    const plan = this.state.status === "idle" ? "none yet" : JSON.stringify({ ...this.state, carts: undefined, cart: undefined, itinerary: undefined });
    const research = this.researchContext();

    // The generic votes-in nudge just names the winner and asks whether to book
    // it — right for a restaurant or venue, which does need book_option. A
    // flight, stay or event never does: when the vote settled on exactly one
    // winner and its link says which kind it is, tell the model to call
    // add_to_itinerary directly so it cannot go fish for a name and email.
    let votesInText =
      "You were woken because everyone has now voted, not because of a new message. Call get_votes, then name the winner in one line and ask whether to book it. If it is a tie, say so and ask the group to break it. Say nothing else.";
    if (votesIn) {
      const tally = this.state.options.map((o) => ({ option: o, count: this.state.counts[o.id] ?? 0 }));
      const top = Math.max(0, ...tally.map((t) => t.count));
      const winners = tally.filter((t) => t.count === top);
      const winner = winners.length === 1 ? winners[0].option : undefined;
      const kind = winner ? tripKind(winner.bookingUrl) : undefined;
      if (winner && kind) {
        votesInText = `You were woken because everyone has now voted, not because of a new message. The winner is "${winner.title}" (optionId ${winner.id}), a ${kind} from the trip sources. Call add_to_itinerary with that optionId and kind "${kind}" now — no name, email or booking step is needed, and never call book_option for it — then say one line and stop.`;
      }
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `People in the chat: ${people.map((p) => this.label(p.handle, people)).join(", ")}
About the people: ${about.text}
Where the group is based: ${this.getMeta("area") || "UNKNOWN — nobody has said. Before any research, ask where they are; never assume a city, and do not reuse a location from an earlier search unless the group itself stated it."}
Current plan: ${plan}
Shopping list: ${this.shoppingListContext()}
Delivery: ${this.deliveryContext()}
Headcount: ${this.headcountContext()}
Invoice: ${this.invoiceContext()}
Itinerary: ${this.itineraryContext()}
Research: ${research.text}
Now: ${new Date().toISOString()}
${
  availabilityIn
    ? `You were woken because the availability check just finished; each ballot option's real open times are in its availability field in the plan above, read from the venue's own booking page. Tell the group in one or two lines which options have which times, plainly, including any that have nothing open or could not be checked. Say nothing else.${this.getMeta("side_availability") ? ` Venues not on the ballot: ${this.getMeta("side_availability")}.` : ""}`
    : votesIn
    ? votesInText
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
      // Refreshed alongside the model call, never ahead of it: the bubble is
      // best effort (startTyping never throws) and the model is the long pole.
      if (!spoke) void this.typing().catch(() => {});
      try {
        res = await traceOperation("agent.model", "gen_ai.chat", { model, profile, step: step + 1, promptChars: JSON.stringify(messages).length }, () => client.chat.completions.create({ model, messages, tools: openAiTools(), ...modelExtras(model, "tools") } as never));
      } catch (err) {
        end("error", "llm_failed", { step, ...errorFields(err) });
        return;
      }
      tokens += res.usage?.total_tokens ?? 0;
      const reply = res.choices[0].message;
      messages.push(reply);

      const calls = (reply.tool_calls ?? []).filter((c) => c.type === "function");
      this.note("info", "turn.step", {
        step: step + 1,
        calls: calls.map((c) => c.function.name),
        decision: calls.length ? `Selected ${calls.map((c) => c.function.name).join(", ")}` : "Returned no tool calls",
        responseChars: reply.content?.length ?? 0,
        tokens: res.usage?.total_tokens ?? 0,
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        cachedTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        reasoningTokens: res.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        finishReason: res.choices[0].finish_reason,
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
          { tool: call.function.name, step: step + 1, callId: call.id, argsChars: call.function.arguments.length },
          () => this.runTool(call.function.name, call.function.arguments),
          this.note,
        );
      // Lookups the model asked for together are fetched together: flights and
      // a hotel, or two stores, searched in one step cost one wait, not two.
      // Everything else keeps its turn in the loop below, where order is the
      // point. Which tools qualify, and why, is in tool-concurrency.ts.
      const early = startConcurrent(calls, run);

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
            // A question anywhere in the text, not just at the end: "what dates? i'll
            // need that first." still waits on an answer. A "?" inside a link is not one.
            if (/\?(\s|$)/.test(parseToolArgs("send_message", call.function.arguments).text.replace(/https?:\/\/\S+/g, ""))) askedQuestion = true;
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
      case "find_locations": return JSON.stringify(await findLocations(parseToolArgs("find_locations", rawArgs)));
      case "get_weather": return JSON.stringify(await getWeather(parseToolArgs("get_weather", rawArgs)));
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

      case "request_location": {
        // Apple only allows the request in a 1:1 iMessage chat, and asking in
        // front of a group is not a thing to do to someone anyway.
        if (this.getMeta("is_group") !== "0") return "Not possible in a group chat. Ask where they are instead.";
        const asked = await requestLocation(this.env, this.name);
        this.note("info", "location.requested", { result: asked });
        if (asked === "already_sharing") {
          this.setMeta("location_asked_at", String(Date.now()));
          const took = await this.takeLocation();
          return took ? `Their area is now ${took}, and they have been told. Say nothing more about it.` : "They are sharing, but no position has arrived yet. Say you will pick it up when it lands, then stop.";
        }
        if (asked !== "sent") return "Location sharing is not available here. Ask them to type where they are instead.";
        this.setMeta("location_asked_at", String(Date.now()));
        // The webhook is the fast path; these cover a subscription without it.
        for (const seconds of [25, 90, 240]) await this.schedule(seconds, "checkLocation");
        return "Request sent: their phone is showing the prompt. Say so in one short line, then stop — when they accept, the city is saved and confirmed to them on its own.";
      }

      case "read_locations": {
        const { people: shared, pairs } = await readPlaces(this.env, this.name);
        // Counts only: which cities and how far apart is theirs to hear, not the log's to keep.
        this.note("info", "location.read", { sharing: shared.length, pairs: pairs.length });
        if (!shared.length) {
          return "Nobody in this chat is sharing their location with you, so you know nothing about where they are. To share: open this conversation's details in Messages and tap Share My Location. Do not claim to have anyone's location.";
        }
        const everyone = this.participants();
        const who = (handle: string) => this.label(handle, everyone);
        const ago = (iso?: string) => {
          if (!iso) return "";
          const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
          return mins < 2 ? " (just now)" : mins < 90 ? ` (${mins} min ago)` : ` (${Math.round(mins / 60)} h ago — may be stale)`;
        };
        for (const pl of shared) {
          if (pl.locality) await peopleStore(this.env).save(pl.handle, { area: [pl.locality, pl.region].filter(Boolean).join(", ").slice(0, 120) });
        }
        // Everyone in one place is the chat's area too, so research has somewhere to look.
        const cities = [...new Set(shared.map((pl) => pl.locality).filter(Boolean))];
        if (cities.length === 1 && !this.getMeta("area")) this.setMeta("area", [cities[0], shared[0].region].filter(Boolean).join(", ").slice(0, 120));
        return [
          ...shared.map((pl) => `${who(pl.handle)}: ${pl.locality ?? "somewhere Apple gave no city for"}${ago(pl.updatedAt)}`),
          ...pairs.map((pr) => `${who(pr.a)} and ${who(pr.b)} are ${pr.km < 1 ? "under 1 km" : `about ${pr.km} km`} apart`),
          "Cities and distances only — you do not have addresses or coordinates, so do not guess at them.",
        ].join("\n");
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
        return (await this.sendProfileLink()) ? "Profile card sent as its own message. Do not paste a link or describe it again." : "Nobody to send it to yet.";
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
        // A run that fails at once wakes the model, which would start another,
        // fail again, and text the chat each time round. One failure, one text.
        if (this.getMeta("research_failed") === "1") {
          this.note("warn", "research.retry_blocked", {});
          return "Research just failed and nobody has asked for anything since. Do not retry. Tell them once, in one line, that the search didn't work and ask what to change.";
        }
        // A hotel or flight brief would run for minutes and end in "nothing
        // found"; the tools that actually answer it are a call away.
        const travel = travelKindOf(args.brief);
        if (travel) {
          this.note("info", "research.redirected", { to: travel === "flight" ? "search_flights" : "search_stays", brief: args.brief.slice(0, 120) });
          return redirectFor(travel);
        }
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
          emoji: args.emoji,
          options,
          status: "voting",
          chosenOptionId: undefined,
          bookingNote: undefined,
        });

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

      case "search_flights": {
        const args = parseToolArgs("search_flights", rawArgs);
        if (args.depart < today()) return `${args.depart} is in the past. Ask for the date.`;
        try {
          const flights = await searchFlights(this.env, args);
          this.note("info", "source.flights", { from: args.from, to: args.to, depart: args.depart, found: flights.length });
          if (!flights.length) return `Google Flights showed nothing for ${args.from} to ${args.to} on ${args.depart}. Check the airports and date with the group.`;
          return JSON.stringify({ options: flights.map(flightOption), note: "Each option's bookingUrl opens Google Flights with a Book button; never say a flight is booked until someone confirms." });
        } catch (err) {
          return this.sourceFailure(err, "Google Flights");
        }
      }

      case "search_stays": {
        const args = parseToolArgs("search_stays", rawArgs);
        if (args.checkin < today() || args.checkout <= args.checkin) return "Check-in must be today or later and before check-out. Ask for the dates.";
        try {
          const stays = await searchStays(this.env, args);
          this.note("info", "source.stays", { where: args.where, checkin: args.checkin, found: stays.length });
          if (!stays.length) return `Google Hotels showed nothing in ${args.where} for those dates.`;
          return JSON.stringify({ options: stays.map(stayOption) });
        } catch (err) {
          return this.sourceFailure(err, "Google Hotels");
        }
      }

      case "find_events": {
        const args = parseToolArgs("find_events", rawArgs);
        try {
          const events = await findEvents(this.env, args);
          this.note("info", "source.events", { city: args.city, query: args.query ?? "", found: events.length });
          if (!events.length) return args.query ? `Ticketmaster has no upcoming ${args.query} dates in ${args.city}.` : `Luma lists nothing in ${args.city} for the next month.`;
          return JSON.stringify({ options: events.map((e) => eventOption(e, cityTz(args.city))) });
        } catch (err) {
          return this.sourceFailure(err, args.query ? "Ticketmaster" : "Luma");
        }
      }

      case "add_to_itinerary": {
        const args = parseToolArgs("add_to_itinerary", rawArgs);
        let item: Omit<ItineraryItem, "id">;
        if (args.optionId) {
          const option = this.state.options.find((o) => o.id === args.optionId);
          if (!option) return "No such option";
          const kind = args.kind ?? tripKind(option.bookingUrl);
          if (!kind) return "Say what kind of stop the winner is: flight, stay, event or venue.";
          item = { kind, title: option.title, subtitle: option.subtitle, url: option.bookingUrl, price: option.subtitle?.match(/(?:CA|US)?\$[\d,]+(?:\.\d\d)?/)?.[0], status: option.bookingUrl ? "handoff" : "confirmed" };
        } else if (args.item) {
          item = { ...args.item, status: args.item.url ? "handoff" : "confirmed" };
        } else {
          return "Pass the winning optionId (with kind) or an item.";
        }
        const added = await this.addItineraryItem(item);
        if (args.optionId) {
          this.sql`DELETE FROM votes`;
          this.publish({ options: [], counts: {}, chosenOptionId: undefined, status: "idle", bookingNote: undefined });
          this.setMeta("ballot_id", "");
        }
        await this.postItinerary();
        const finish = added.url ? ` Finish it here: ${added.url}` : "";
        const ask = added.kind === "flight" ? " Tell me the flight number once it's booked and I'll watch it." : added.kind === "stay" || added.kind === "event" ? " Tell me once it's booked and I'll mark it." : "";
        await this.say(`${ITEM_EMOJI[added.kind]} ${added.title}${added.price ? `, ${added.price}` : ""}.${finish}${ask}`);
        return `Added ${added.id}. The ticket and the link are posted; the ballot is clear for the next segment. Itinerary: ${this.itineraryContext()}`;
      }

      case "watch_flight": {
        const args = parseToolArgs("watch_flight", rawArgs);
        let item = args.itemId ? this.itinerary().find((i) => i.id === args.itemId) : undefined;
        if (args.itemId && !item) return `No itinerary item ${args.itemId}. Itinerary: ${this.itineraryContext()}`;
        if (!item && !args.itemId) {
          // No itemId given: attach to the one itinerary item this is clearly
          // about, rather than adding a duplicate flight stop.
          const unwatched = this.itinerary().filter((i) => i.kind === "flight" && !i.watch);
          if (unwatched.length === 1) item = unwatched[0];
        }
        const wasNew = !item;
        const previous = item ? { ...item } : undefined;
        if (!item) item = await this.addItineraryItem({ kind: "flight", title: args.ident.toUpperCase(), status: "watching", watch: { flight: { ident: args.ident, date: args.date } } });
        else this.saveItinerary(this.itinerary().map((i) => (i.id === item!.id ? { ...i, status: "watching", note: args.ident.toUpperCase(), watch: { flight: { ident: args.ident, date: args.date } } } : i)));
        this.sql`INSERT OR REPLACE INTO watches (item_id, snapshot, failures, started, checked) VALUES (${item.id}, NULL, 0, ${Date.now()}, NULL)`;
        try {
          const status = await flightStatus(this.env, args.ident);
          if (!status) {
            // A bad ident must not leave a permanent watch: undo exactly what
            // this call did, whether that was a new item or an existing one.
            this.sql`DELETE FROM watches WHERE item_id = ${item.id}`;
            if (wasNew) this.saveItinerary(this.itinerary().filter((i) => i.id !== item!.id));
            else this.saveItinerary(this.itinerary().map((i) => (i.id === item!.id ? { ...previous! } : i)));
            return `FlightAware has no ${args.ident.toUpperCase()}. Check the flight number with them.`;
          }
          this.sql`UPDATE watches SET snapshot = ${JSON.stringify(status)}, checked = ${Date.now()} WHERE item_id = ${item.id}`;
          const line = describeFlight(status);
          this.saveItinerary(this.itinerary().map((i) => (i.id === item!.id ? { ...i, lastUpdate: line.replace(/^\S+ /, "") } : i)));
          await this.scheduleWatches();
          return `${line}. Watching it: changes are posted on their own, so say this once and stop.`;
        } catch (err) {
          await this.scheduleWatches();
          return this.sourceFailure(err, "FlightAware");
        }
      }

      case "confirm_item": {
        const args = parseToolArgs("confirm_item", rawArgs);
        const item = this.itinerary().find((i) => i.id === args.itemId);
        if (!item) return `No itinerary item ${args.itemId}. Itinerary: ${this.itineraryContext()}`;
        const paidBy = args.paidBy ? this.nameOf(args.paidBy) : undefined;
        this.saveItinerary(this.itinerary().map((i) => (i.id === item.id ? { ...i, status: i.status === "watching" ? "watching" : "confirmed", note: args.note ?? i.note, price: args.price ?? i.price, paidBy: paidBy ?? i.paidBy } : i)));
        this.note("info", "itinerary.confirmed", { id: item.id, paid: Boolean(args.price && paidBy) });
        let expense = "";
        if (args.price && paidBy) {
          expense = await this.runTool("add_expense", JSON.stringify({ who: args.paidBy, amount: args.price, what: item.title.slice(0, 60) }));
        }
        await this.postItinerary();
        return `${item.id} confirmed.${expense ? ` ${expense}` : ""} Itinerary: ${this.itineraryContext()}`;
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
        const workflowId = await this.runWorkflow("BOOKING_WORKFLOW", params, WORKFLOW_OPTS);
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

        // A flight, stay or event never goes through the pilot — a haiku
        // model that has just been told "book it" will otherwise ask for a
        // name and email nobody needs to give it. Send it to add_to_itinerary
        // instead of driving a browser.
        const kind = tripKind(option.bookingUrl);
        if (kind) {
          this.note("info", "booking.redirected", { kind });
          return onBallot
            ? this.runTool("add_to_itinerary", JSON.stringify({ optionId: args.optionId, kind }))
            : this.runTool("add_to_itinerary", JSON.stringify({ item: { kind, title: option.title, url: option.bookingUrl } }));
        }

        if (onBallot && (this.state.status === "booking" || this.state.status === "booked" || this.state.status === "handoff")) {
          return `Already ${this.state.status}`;
        }
        if (this.getMeta("booking_running") === "1") return "A booking is already running; one browser at a time. Wait for it to finish.";

        // A restaurant or venue reservation genuinely needs a name and email —
        // ask rather than invent either.
        if (!args.contactName || !args.contactEmail) return "Ask who is booking and for their email; never make either up.";

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
        const workflowId = await this.runWorkflow("BOOKING_WORKFLOW", params, WORKFLOW_OPTS);
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

      case "set_delivery": {
        const { to, venue } = parseToolArgs("set_delivery", rawArgs);
        // A new destination is a new question for everyone, including whoever chose to ship home.
        this.sql`DELETE FROM meta WHERE key LIKE 'ship_choice:%'`;
        if (to === "payer") {
          this.setDelivery(undefined);
          this.note("info", "delivery.cleared");
          return "Done: each order ships to whoever pays for it.";
        }
        if (to === "event") {
          this.setDelivery({ source: "event", confirmed: false });
          this.note("info", "delivery.set", { source: "event" });
          return "Set. The first person to pay types the event's address on a private form, and everyone after them gets it filled in to check. Say so in one short line; do not ask for the address in the chat.";
        }
        if (!venue) return "Say which venue: its exact name from the Research findings.";
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
        const report = this.sql<{ report: string }>`SELECT report FROM research WHERE ok = 1 ORDER BY id DESC LIMIT 1`[0];
        const found = report ? (JSON.parse(report.report) as ResearchReport).candidates.find((c) => norm(c.name).includes(norm(venue)) || norm(venue).includes(norm(c.name))) : undefined;
        // Only an address research read off the web: nothing is invented here.
        if (!found?.address) return `No address is known for "${venue}". Use to=event instead and the person paying will type it.`;
        this.setDelivery({ source: "venue", label: found.name, address: parseAddress(found.address), confirmed: false });
        this.note("info", "delivery.set", { source: "venue", venue: found.name });
        return `Set: orders ship to ${found.name}. Whoever pays first checks the address on a private form before anything is ordered. Say so in one short line, and mention that the venue should be told to expect a parcel.`;
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

        const paid = { ...cart, paidBy: this.nameOf(who) };
        this.saveCarts(carts.map((c) => (c === cart ? paid : c)));
        await this.postTicket("cart", cartTicket(paid, this.headcount()));
        await this.invoiceIfSettled();
        const inv = this.invoice();
        return `PAID ticket posted for ${cart.shop}. ${this.shoppingListLine()}${inv.ok && inv.settled ? " Every cart is paid, so the invoice ticket went out too: do not post it again." : ""}`;
      }

      case "add_expense": {
        const args = parseToolArgs("add_expense", rawArgs);
        const { cents } = parseMoney(args.amount);
        if (!cents) return `"${args.amount}" is not an amount. Ask how much it was; never guess.`;
        // "for everyone" is the default, not a person.
        const among = (args.for ?? []).filter((n) => !/^(everyone|everybody|all|us)$/i.test(n.trim())).map((n) => this.nameOf(n));
        const taken = new Set(this.expenses().map((e) => e.id));
        let id = "";
        do id = `e${crypto.randomUUID().slice(0, 4)}`;
        while (taken.has(id));
        const expense: Expense = {
          id,
          who: this.nameOf(args.who),
          amount: args.amount.trim(),
          what: args.what.trim().slice(0, 60),
          ...(among.length ? { for: among } : {}),
        };
        this.publish({ expenses: [...this.expenses(), expense] });
        this.note("info", "expense.added", { id: expense.id, amount: expense.amount, what: expense.what, for: expense.for?.length ?? "everyone" });
        return `Logged ${expense.id}: ${expense.who} paid ${expense.amount} for ${expense.what}${expense.for ? ` (${expense.for.join(", ")} only)` : ""}. Invoice now: ${this.invoiceContext()}`;
      }

      case "drop_expense": {
        const { id } = parseToolArgs("drop_expense", rawArgs);
        const before = this.expenses();
        if (!before.some((e) => e.id === id)) return `No expense ${id}. Invoice: ${this.invoiceContext()}`;
        this.publish({ expenses: before.filter((e) => e.id !== id) });
        this.note("info", "expense.dropped", { id });
        return `Dropped ${id}. Invoice now: ${this.invoiceContext()}`;
      }

      case "show_invoice": {
        const inv = this.invoice();
        if (!inv.ok) return inv.reason === "empty" ? "There is nothing on the invoice yet: no carts and no logged expenses." : "The carts are in different currencies, so there is no single invoice to draw. Quote the amounts as they are.";
        await this.postInvoice(inv);
        return `Invoice ticket posted; it speaks for itself. The itemised version is at ${this.env.PUBLIC_BASE_URL}/w/${encodeURIComponent(this.name)} if anyone wants the detail. ${this.invoiceContext()}`;
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
        this.publish({}); // a fresh headcount: the split is everyone again until people answer
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
        // The pool is a view of the profile. Writing the model's blurb straight to
        // the index replaced what they had said about themselves, and left the
        // opt-in unset, so find_matches still turned them away.
        const store = peopleStore(this.env);
        const before = (await store.getMany([person.handle]))[person.handle];
        const saved = await store.save(person.handle, { matchOptIn: true, ...(before?.interests ? {} : { interests: blurb.slice(0, 200) }) });
        if (!(await syncMatchPool(this.env, person.handle, saved))) this.note("warn", "match_pool.failed", {});
        return "added to the pool";
      }

      case "find_matches": {
        const { who, lookingFor, near } = parseToolArgs("find_matches", rawArgs);
        if (this.getMeta("is_group") !== "0") return "Not in a group: pairing is private. Tell them to text you directly.";
        const person = this.participants().find((p) => this.label(p.handle) === who);
        if (!person) return `No participant labelled ${who}`;
        const store = peopleStore(this.env);
        // Their profile and who they have already been offered: two reads that need only the handle.
        const [profiles, paired] = await Promise.all([store.getMany([person.handle]), store.pairedWith(person.handle)]);
        const profile = profiles[person.handle];
        // Searching the pool means being findable in it: same consent both ways.
        if (!profile?.matchOptIn) return "They are not in the match pool themselves. Ask whether they want to be introduced to people (save_profile matchOptIn) before searching.";
        // A place they named beats where they live: "i'm visiting vancouver, anyone there?"
        const where = near || profile.area;
        const query = [lookingFor, profile.interests, where && `Based in ${where}`].filter(Boolean).join(". ");
        const exclude = [person.handle, ...paired];
        // Vectorize understands meaning ("bouldering" finds "climbing") but takes a
        // minute or two to index a new profile, and is absent without a login; the
        // shared-word scan is instant and always there. Meaning first, then words.
        const [semantic, lexical] = await Promise.all([
          // Ask for more than are shown: entries that can no longer be reached are
          // dropped below, and must not use up the three places.
          findMatches(this.env, query, exclude, 10).catch((err) => {
            this.note("warn", "match.index_unavailable", errorFields(err));
            return [];
          }),
          store.scanPool(query, exclude, 10),
        ]);
        const merged = [...semantic, ...lexical.filter((l) => !semantic.some((m) => m.id === l.id))];
        // Only people an introduction can actually reach: still opted in, with a
        // direct chat to ask them in. The index can hold entries older than that rule.
        const reachable = await store.getMany(merged.map((m) => m.id));
        const canReach = merged.filter((m) => reachable[m.id]?.matchOptIn && reachable[m.id]?.dmChat);
        // A place puts people there first; it never hides everyone else. The model
        // fills `near` in with the asker's own city unasked, and as a wall that
        // turned "anyone who likes art" into nobody.
        const place = near?.split(/[ ,]/)[0].toLowerCase();
        const isThere = (m: { id: string }) => !!place && (reachable[m.id]?.area ?? "").toLowerCase().includes(place);
        const there = canReach.filter(isThere);
        const matches = [...there, ...canReach.filter((m) => !isThere(m))].slice(0, 3);
        if (!matches.length) {
          this.note("info", "match.search", { candidates: 0, found: merged.length, near });
          return "Nobody new in the pool fits yet. Say so plainly; more people join over time.";
        }

        // The model gets refs and blurbs. Handles and names stay here, keyed by
        // ref, until the other person has said yes.
        const candidates: Record<string, string> = {};
        const shown: Candidate[] = matches.map((m, i) => {
          candidates[`c${i + 1}`] = m.id;
          return { ref: `c${i + 1}`, blurb: m.blurb, score: m.score };
        });
        this.setMeta("match_candidates", JSON.stringify(candidates));
        this.note("info", "match.search", { candidates: shown.length, top: shown[0]?.score, found: merged.length, near, there: there.length });
        if (near && !there.length) return `Nobody in the pool is based in ${near} yet, so say that plainly. These are the closest fits elsewhere: ${JSON.stringify(shown)}`;
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

      case "add_song": {
        const { title, artist, who } = parseToolArgs("add_song", rawArgs);
        const found = await searchTrack(title, artist);
        if (!found) return `iTunes has nothing for "${title}"${artist ? ` by ${artist}` : ""}. Ask for another spelling or a different song.`;
        const playlist = [...(this.state.playlist ?? [])];
        const key = (t: { title: string; artist: string }) => `${t.title}|${t.artist}`.toLowerCase();
        if (playlist.some((t) => key(t) === key(found))) return `${found.title} — ${found.artist} is already on the playlist (${playlist.length} tracks).`;
        playlist.push({ ...found, addedBy: who });
        this.publish({ playlist });
        this.note("info", "playlist.added", { title: found.title, artist: found.artist, tracks: playlist.length });
        await this.syncMusicCard();
        return `Added ${found.title} — ${found.artist}${found.previewUrl ? "" : " (no preview clip for this one)"}. Playlist has ${playlist.length} track${playlist.length === 1 ? "" : "s"}; its card in the thread updated itself. Do not list the songs in text.`;
      }

      case "make_game": {
        const { topic } = parseToolArgs("make_game", rawArgs);
        try {
          // "let's play a game" names no topic, and the model may leave it out too.
          const made = await this.gameCreate(topic?.trim() || this.state.title || "general knowledge, a fun mix", "agent");
          return `Game card posted: "${made.title}". Tell the group to tap it, join, and play — in one short line. Do not list the questions.`;
        } catch (err) {
          this.note("warn", "game.generate_failed", errorFields(err));
          return "The game generator came up empty. Say so and offer to try a different topic.";
        }
      }

      case "show_playlist": {
        const playlist = this.state.playlist ?? [];
        if (!playlist.length) return "The playlist is empty. Ask the group for songs.";
        // A fresh card, not an update: "show me" means put it back in view.
        const id = await timed("agent", "playlist.card", { tracks: playlist.length }, () => sendMusicCard(this.env, this.name, this.name, playlist.length), this.note).catch(() => undefined);
        if (id) this.setMeta("music_card_id", id);
        return `Playlist card posted (${playlist.length} tracks). Do not also list the songs in text.`;
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
    const workflowId = await this.runWorkflow("RESEARCH_WORKFLOW", params, WORKFLOW_OPTS);
    this.note("info", "research.started", { workflowId: short(workflowId), depth: params.depth, brief: params.brief.slice(0, 120), near: params.near });
    return "Research started; it takes a few minutes. Tell the group you're looking into it in one short line, then stop. The findings will arrive on their own.";
  }

  /** Called over RPC by ResearchWorkflow as it moves through its stages. */
  // ---------------------------------------------------------------- location
  // The agent takes a city, once, and then ends the share so it cannot look
  // again. Coordinates and street addresses are never stored or logged.

  /** How long after asking a share still counts as the answer to that ask. */
  private static LOCATION_WINDOW_MS = 30 * 60 * 1000;

  /** Webhook path: someone in this chat started sharing. */
  async locationShared(sharedBy: string) {
    this.note("info", "location.sharing_started", { who: mask(sharedBy) });
    await this.takeLocation();
  }

  /** Scheduler callback: the fallback when no webhook is subscribed. */
  async checkLocation() {
    await this.takeLocation();
  }

  /**
   * Reads the share and keeps the city. Returns the area it saved.
   *
   * Two cases, told apart by whether the agent asked:
   *  - It asked (onboarding): the city was all it wanted, so it ends the share
   *    and says so.
   *  - The person shared on their own, from the conversation: that is consent
   *    to be read, but the share is theirs — it is left running, which is also
   *    what lets a group ask how far apart everyone is. The first version
   *    ignored these shares entirely, which left a person who had said "here's
   *    my location" talking to an agent that acted as if they had not.
   */
  private async takeLocation(simulated?: { handle: string; locality: string; region?: string }): Promise<string | null> {
    const askedAt = Number(this.getMeta("location_asked_at") || 0);
    const asked = Boolean(askedAt) && Date.now() - askedAt <= PlanAgent.LOCATION_WINDOW_MS;

    const places = simulated ? [simulated] : await readLocation(this.env, this.name);
    const place = places.find((pl) => pl.locality);
    if (!place?.locality) return null;

    if (!asked) {
      const area = [place.locality, place.region].filter(Boolean).join(", ").slice(0, 120);
      // A re-share, or the webhook and a poll both landing, should not repeat the message.
      if (this.getMeta(`location_seen:${place.handle}`) === area) return area;
      this.setMeta(`location_seen:${place.handle}`, area);
      if (!this.getMeta("area")) this.setMeta("area", area);
      await peopleStore(this.env).save(place.handle, { area });
      this.note("info", "location.taken", { who: mask(place.handle), area, shareEnded: false, proactive: true });
      await this.say(`got your location, using ${place.locality} as your area. i only look when someone asks something that needs it, like how far apart you are. stop sharing anytime from the chat details`);
      return area;
    }

    // Claimed before anything slow, so the webhook and a poll cannot both act.
    this.setMeta("location_asked_at", "");
    const area = [place.locality, place.region].filter(Boolean).join(", ").slice(0, 120);
    this.setMeta("area", area);
    await peopleStore(this.env).save(place.handle, { area });
    const stopped = simulated ? "dry" : await stopLocation(this.env, this.name, place.handle);
    const ended = stopped === "ok" || stopped === "dry";
    this.note("info", "location.taken", { who: mask(place.handle), area, shareEnded: ended });

    await this.say(
      ended
        ? `got it, ${place.locality}. i only kept the city, and i've ended the share so i can't see where you are`
        : `got it, ${place.locality}. i only kept the city. you can stop sharing from the chat details whenever you like`,
    );
    return area;
  }

  /** Simulator only: stands in for the person tapping "share" on their phone. */
  async devShareLocation(handle: string, locality: string, region?: string) {
    return this.takeLocation({ handle, locality, region });
  }

  async telemetryProgress(level: Level, event: string, fields: Fields) {
    this.note(level, event, fields);
  }

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
    this.setMeta("research_failed", report.ok ? "0" : "1");
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
            details: c.details,
            sources: c.sources,
            checkedAt: c.checkedAt,
            independentSources: c.sources.length,
          })),
        })
      : `failed: ${report.detail}`;
    // An old failure says nothing about the next run: left standing as "failed: <cause>",
    // it reads as "research is broken" and the model stops calling it at all.
    if (row.delivered && !report.ok) return { text: "none. The last run failed and the group was told. That is over: call research again for any new request that needs real places." };
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
      invoice: this.invoice(),
      research: this.sql<{ report: string }>`SELECT report FROM research ORDER BY id DESC LIMIT 1`.map((r) => JSON.parse(r.report))[0],
      transcript: this.sql<Row>`SELECT direction, author, body FROM messages ORDER BY id`,
      votes: this.sql<Row>`SELECT voter, option_id, source FROM votes`,
      planPhotos: this.planPhotoIds(),
      participants: this.participants().map((p) => p.handle),
      area: this.getMeta("area"),
    };
  }

  /**
   * Simulator only: run one tool exactly as the model would, without a model.
   * Deterministic and free, which makes it the way to iterate on cards.
   */
  async devRunTool(tool: string, args: unknown) {
    return telemetryScope(this.note, async () => {
      this.note("info", "dev.tool", { tool });
      return traceOperation("agent.tool", "function", { tool }, () => this.runTool(tool, JSON.stringify(args ?? {})));
    });
  }

  /** Simulator only: id of the agent's most recent text, to simulate replying to it. */
  async lastOwnMessageId() {
    return this.sql<{ linq_id: string }>`
      SELECT linq_id FROM messages WHERE direction = 'out' AND linq_id IS NOT NULL ORDER BY id DESC LIMIT 1`[0]?.linq_id;
  }

  /** Simulator only: the open Who's in ticket's message id. */
  /** The plan as the vote page and the card images see it. */
  async publicState(): Promise<PlanState> {
    return this.state;
  }

  /** This chat's id, which is this agent's name. Lets a workflow find the agent again after a deploy. */
  async chatId() {
    return this.name;
  }

  /** Dev only: a cart that exists nowhere but here, so the pay guards can be tested offline. */
  async devSeedCart(shop: string, total: string) {
    const key = shopKey(shop);
    this.saveCarts([...this.carts().filter((c) => shopKey(c.shop) !== key), { shop: key, checkoutUrl: `https://${key}/cart/c/dev`, total, lines: [{ title: "Test item", quantity: 1, price: total }] }]);
    this.rememberCartMessage(key, `dry-cart-${key}`);
  }

  /** Dev only: the newest message a cart has in the thread, for the simulator to react to. */
  async currentCartMessageId(shop?: string) {
    const cart = this.carts().find((c) => !shop || shopKey(c.shop) === shopKey(shop));
    return cart ? this.cartMessages(shopKey(cart.shop)).at(-1) : undefined;
  }

  /** Simulator only: the latest shopping list ticket's message id. */
  async currentListId() {
    return this.sql<{ message_id: string }>`
      SELECT message_id FROM tickets WHERE kind = 'list' AND message_id IS NOT NULL ORDER BY ts DESC LIMIT 1`[0]?.message_id;
  }

  async currentRsvpId() {
    return this.sql<{ message_id: string }>`
      SELECT message_id FROM tickets WHERE kind = 'rsvp' AND message_id IS NOT NULL ORDER BY ts DESC LIMIT 1`[0]?.message_id;
  }

  /** Simulator only: the open ballot's latest ticket photo, which is what a phone most often tapbacks. */
  async currentPlanPhotoId() {
    return this.planPhotoIds().at(-1);
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
    // A tap on the card is nobody in particular, so with any of those in, who
    // exactly is still out is a guess: give the count, not names.
    const taps = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM votes WHERE voter LIKE 'web:%'`[0]?.n ?? 0;
    const named = taps === 0 && waiting.every((w) => !w.startsWith("…"));
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
      if (result.ok || handedOff) {
        await this.addItineraryItem({ kind: "venue", title: name, status: result.ok ? "confirmed" : "handoff", note: result.ok ? result.confirmation : undefined, url: option?.bookingUrl });
      }
      if (result.ok) await this.planTicketIfNew();
    }

    if (result.ok) {
      // The dressing posts no message, so it cannot get ahead of the text in the thread.
      await Promise.all([
        this.say(`booked ${name}${result.confirmation ? `. confirmation: ${result.confirmation}` : ""}`, { screenEffect: "confetti" }),
        onBallot ? this.dressChat() : undefined,
      ]);
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

  /**
   * The chat becomes the plan: once booked, the group is renamed after the
   * outing ("🍜 Friday dinner · Kinton Ramen"), its icon becomes the plan's
   * stamp and its background changes. Code, never the model, and best-effort:
   * Linq accepts each change asynchronously and a name or an icon is only for
   * groups, so a direct chat is left alone and a failure is logged, not thrown.
   */
  private async dressChat() {
    if (this.getMeta("is_group") === "0") return;
    const name = groupName(this.state);
    const outcome = await dressChat(this.env, this.name, { name, iconUrl: planIconUrl(this.env, this.name, this.state.version) });
    this.note("info", "chat.dressed", { title: name, ...outcome });
  }

  /**
   * Simulator only: land the booked outcome without a browser, on the first
   * option or the one named. Exercises everything a real confirmation does —
   * the ticket, the confetti, the chat's new name — so it can be shown on demand.
   */
  async devBooked(optionId?: string, confirmation = "DEMO-1234") {
    const option = this.state.options.find((o) => !optionId || o.id === optionId);
    if (!option) return { error: optionId ? "No such option" : "No options to book: propose_plan first" };
    this.setMeta("booking_for", JSON.stringify({ title: option.title, onBallot: true }));
    this.publish({ status: "booking", chosenOptionId: option.id });
    await this.bookingFinished({ ok: true, status: "submitted", confirmation, detail: "confirmed" });
    return { ok: true, name: groupName(this.state) };
  }
}
