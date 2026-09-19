import { Agent, callable } from "agents";
import type OpenAI from "openai";
import { ZodError } from "zod";
import { EMPTY_PLAN, REACTION_SLOTS, type PlanOption, type PlanState } from "../types";
import { llmFor } from "./llm";
import { errorFields, log, mask, short, timed, type Fields, type Level } from "./log";
import { cartTicket, matchTicket, planTicket, rsvpTicket, venueTicket, type Rsvps, type Ticket } from "./card";
import { sendCard, sendPhoto, sendText, tapbackLegend, updateCard } from "./linq";
import { openAiTools, parseToolArgs, toolSchemas, type ToolName } from "./tools";
import { KNOWN_SHOPS, searchCatalog, setCart } from "./tools/shopify";
import { findMatches, upsertProfile } from "./tools/match";
import { RunRecorder } from "./runs";
import type { BookingParams, BookingResult } from "./booking";
import type { ResearchParams, ResearchReport } from "./research";

const SYSTEM = `You are a planning agent living inside an iMessage group chat. You help the
group brainstorm a hangout and then actually make it happen: pick a place, agree
on a time, book it, and order anything they need.

- Write like a friend texting: one or two short lines, no markdown, no lists.
- Send at most one message per turn. After send_message you are done talking:
  reply NOOP unless you still have a non-message tool to call.
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
- Brainstorm in plain text. Once there are 2-4 concrete options, call
  propose_plan; it posts the card and opens voting. Call it again to redraw the
  same card when options change rather than describing changes in text.
- People vote by reacting to the card with a tapback; the card shows the live
  tally. Never ask anyone to reply with a number, and do not comment on
  individual votes.
- Check get_votes before naming a winner. Do not book while people are still
  voting unless someone in the chat tells you to go ahead.
- book_option makes a real reservation. Call it at most once per plan.
- You cannot pay for anything. shop_build_cart posts the cart card with a
  checkout link for a human to complete. When the group changes the order, call
  it again with the whole new cart; never describe cart changes in text.
- Quote shop prices exactly as shop_search returns them. Stores known to work:
${KNOWN_SHOPS.map((s) => `  ${s.shop} (${s.sells})`).join("\n")}
  Other Shopify stores work too; if shop_search says a domain is not one, move on.
- Tickets are photos the group sees: show_venue when someone asks about one
  place, ask_rsvp once a time and place are fixed, mark_paid when a person says
  they paid, introduce_match for a pair from the pool. A ticket speaks for
  itself, so never restate one in text.
- Only add someone to the match pool when they themselves asked to join.
- In a group you sleep while people talk among themselves, and are woken only
  when someone @mentions you, replies to one of your messages, or answers a
  question you asked. You have still read everything said while you slept — use
  it, and do not ask for anything the group already said. When woken with a
  request, start by confirming what you understood in one line.
- If, despite being woken, there is truly nothing for you to do, reply with
  exactly NOOP and nothing else.`;

const MAX_STEPS = 8;
const HISTORY_LIMIT = 40;
const NUDGE_AFTER_SECONDS = 20 * 60;
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

  private turnRunning = false;
  private turnRequested = false;

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
    });
    if (!wake) return;

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
    if (this.cardIds().includes(id) || id === this.getMeta("cart_message_id")) return true;
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
    if (this.getMeta("plan_ticket_key") === key) return;
    this.setMeta("plan_ticket_key", key);
    await this.postTicket("plan", planTicket(this.state));
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

  private async say(text: string) {
    this.setMeta("awaiting_answer_until", "0");
    const id = await timed("agent", "message.out", { chars: text.length }, () => sendText(this.env, this.name, text), this.note);
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
    }
  }

  private async think() {
    const { client, model, profile } = llmFor(this.env);
    // Why this turn is running. A vote-triggered turn has a specific job; with
    // no stated purpose the model fills the silence with chatter.
    const votesIn = this.getMeta("turn_reason") === "votes_in";
    this.setMeta("turn_reason", "");
    const people = this.participants();

    const history = this.sql<{ direction: string; author: string | null; body: string | null }>`
      SELECT direction, author, body FROM messages ORDER BY id DESC LIMIT ${HISTORY_LIMIT}`.reverse();
    const transcript = history
      .map((m) => `${m.direction === "in" ? this.label(m.author, people) : "you"}: ${m.body ?? ""}`)
      .join("\n");

    const plan = this.state.status === "idle" ? "none yet" : JSON.stringify(this.state);
    const research = this.researchContext();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `People in the chat: ${people.map((p) => this.label(p.handle, people)).join(", ")}
Where the group is based: ${this.getMeta("area") ?? "UNKNOWN — nobody has said. Before any research, ask where they are; never assume a city, and do not reuse a location from an earlier search unless the group itself stated it."}
Current plan: ${plan}
Research: ${research.text}
Now: ${new Date().toISOString()}
${
  votesIn
    ? "You were woken because everyone has now voted, not because of a new message. Call get_votes, then name the winner in one line and ask whether to book it. If it is a tie, say so and ask the group to break it. Say nothing else."
    : this.getMeta("is_group") === "0"
      ? "This is a direct one-to-one chat, so every message is addressed to you: reply once rather than staying silent, then stop."
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
    const sentThisTurn = new Set<string>();
    for (let step = 0; step < MAX_STEPS; step++) {
      let res;
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

      for (const call of calls) {
        let output: string;
        const tool = call.function.name;
        toolsUsed.push(tool);

        // A model that loses track can send the same line twice in one turn;
        // in a group chat that reads as a glitch, so the repeat is swallowed.
        // One text per turn. A model that keeps rephrasing its reply sent eight
        // messages in twenty seconds; a second attempt ends the turn instead.
        if (tool === "send_message" && spoke) {
          end("warn", "replied", { steps: step + 1, extraSendBlocked: true });
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
          output = await timed(
            "agent",
            "tool",
            // Arguments are useful for every tool except the one carrying message text.
            { tool, args: tool === "send_message" ? "(text)" : call.function.arguments.slice(0, 300) },
            () => this.runTool(tool, call.function.arguments),
            this.note,
          );
          if (tool === "send_message") {
            spoke = true;
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
        await this.say(text);
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
        if (this.getMeta("card_message_id")) {
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

      case "book_option": {
        const args = parseToolArgs("book_option", rawArgs);
        const option = this.state.options.find((o) => o.id === args.optionId);
        if (!option) return "No such option";
        if (this.state.status === "booking" || this.state.status === "booked") {
          return `Already ${this.state.status}`;
        }

        this.publish({ status: "booking", chosenOptionId: option.id });
        await this.syncCard();

        const params: BookingParams = {
          title: option.title,
          url: option.bookingUrl ?? "",
          partySize: args.partySize,
          isoTime: args.isoTime,
        };
        const workflowId = await this.runWorkflow("BOOKING_WORKFLOW", params);
        this.note("info", "booking.started", { workflowId: short(workflowId), option: option.title });
        return "Booking started. The card updates and the chat is told when it finishes — do not announce success yet.";
      }

      case "shop_search": {
        const { shop, query } = parseToolArgs("shop_search", rawArgs);
        const found = await searchCatalog(this.env, shop, query);
        return found.length ? JSON.stringify(found) : `Nothing at ${shop} matches "${query}".`;
      }

      case "shop_build_cart": {
        const { shop, lines } = parseToolArgs("shop_build_cart", rawArgs);
        // One cart and one card per shop; a second call edits both. The id holds
        // the cart's secret key, so it lives in meta rather than the public state.
        const cart = await setCart(this.env, shop, lines, this.getMeta(`cart_id:${shop}`) || undefined);
        this.setMeta(`cart_id:${shop}`, cart.id);
        if (!cart.lines.length) {
          return `Nothing could be added, so no card was posted. Store says: ${cart.messages.join("; ") || "no reason given"}. Choose a different variant from shop_search.`;
        }
        this.publish({ cart: { shop, checkoutUrl: cart.checkoutUrl, total: cart.total, lines: cart.lines } });
        // The photo first, so the pay card lands directly under what it is for.
        await this.postTicket("cart", cartTicket(this.state.cart!, this.participants().length));

        const messageId = this.getMeta(`cart_message_id:${shop}`);
        if (messageId) {
          // updateCard returns the card's new id; the old one is dead after a redraw.
          const newId = await timed("agent", "cart.update", { version: this.state.version }, () =>
            updateCard(this.env, messageId, this.name, this.state, 0, "cart"),
            this.note,
          ).catch(() => undefined);
          if (newId) this.setMeta(`cart_message_id:${shop}`, newId);
        } else {
          const id = await sendCard(this.env, this.name, this.name, this.state, 0, "cart");
          this.setMeta(`cart_message_id:${shop}`, id);
        }
        const summary = cart.lines.map((l) => `${l.quantity}x ${l.title} (${l.price})`).join(", ");
        return `Cart card ${messageId ? "redrawn" : "posted"} with its checkout link. ${summary}. Total ${cart.total}.${
          cart.messages.length ? ` Store says: ${cart.messages.join("; ")}` : ""
        }`;
      }

      case "mark_paid": {
        const { who } = parseToolArgs("mark_paid", rawArgs);
        if (!this.state.cart) return "There is no cart in this chat.";
        await this.postTicket("cart", cartTicket(this.state.cart, this.participants().length, who));
        return "PAID ticket posted.";
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
        const { blurb } = parseToolArgs("find_matches", rawArgs);
        const matches = await findMatches(this.env, blurb);
        // Handles are the vector ids; keep them out of the model's context.
        return JSON.stringify(matches.map(({ id: _id, ...rest }) => rest));
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
  async bookingFinished(result: BookingResult) {
    const option = this.state.options.find((o) => o.id === this.state.chosenOptionId);
    this.note(result.ok ? "info" : "warn", "booking.finished", { ok: result.ok, detail: result.detail });
    this.publish({
      status: result.ok ? "booked" : "failed",
      bookingNote: result.ok ? result.confirmation : result.detail,
    });
    await this.syncCard();
    if (result.ok) await this.planTicketIfNew();
    await this.say(
      result.ok
        ? `booked ${option?.title ?? "it"}${result.confirmation ? ` — ${result.confirmation}` : ""}`
        : `couldn't book ${option?.title ?? "it"}: ${result.detail ?? "unknown error"}`,
    );
  }
}
