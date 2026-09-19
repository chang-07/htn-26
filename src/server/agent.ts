import { Agent, callable } from "agents";
import type OpenAI from "openai";
import { ZodError } from "zod";
import { EMPTY_PLAN, REACTION_SLOTS, type PlanOption, type PlanState } from "../types";
import { llmFor } from "./llm";
import { errorFields, log, mask, short, timed, type Fields, type Level } from "./log";
import { sendCard, sendText, tapbackLegend, updateCard } from "./linq";
import { openAiTools, parseToolArgs, toolSchemas, type ToolName } from "./tools";
import { searchPlaces } from "./tools/places";
import { createCart, searchCatalog } from "./tools/shopify";
import { findMatches, upsertProfile } from "./tools/match";
import type { BookingParams, BookingResult } from "./booking";

const SYSTEM = `You are a planning agent living inside an iMessage group chat. You help the
group brainstorm a hangout and then actually make it happen: pick a place, agree
on a time, book it, and order anything they need.

- Write like a friend texting: one or two short lines, no markdown, no lists.
- Do not announce what you are about to do. Do it, then report the result.
- Never invent a venue, address or price. Every option you propose must come
  from a search_places or shop_search result in this conversation.
- Brainstorm in plain text. Once there are 2-4 concrete options, call
  propose_plan; it posts the card and opens voting. Call it again to redraw the
  same card when options change rather than describing changes in text.
- People vote by reacting to the card with a tapback; the card shows the live
  tally. Never ask anyone to reply with a number, and do not comment on
  individual votes.
- Check get_votes before naming a winner. Do not book while people are still
  voting unless someone in the chat tells you to go ahead.
- book_option makes a real reservation. Call it at most once per plan.
- You cannot pay for anything. shop_build_cart posts a checkout link for a
  human to complete.
- Only add someone to the match pool when they themselves asked to join.
- Most messages in a group chat are not for you. If you have nothing useful to
  add, reply with exactly NOOP and nothing else.`;

const MAX_STEPS = 8;
const HISTORY_LIMIT = 40;
const NUDGE_AFTER_SECONDS = 20 * 60;
const EVENT_HISTORY = 300;

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
    this.sql`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      level TEXT NOT NULL, event TEXT NOT NULL, fields TEXT NOT NULL
    )`;
  }

  /**
   * Logs to the console *and* to this chat's own event history. The console
   * scrolls away and `wrangler tail` only shows what happens while you watch;
   * the history answers "what did the agent do with that message an hour ago?"
   * via GET /api/dev/logs?chat=<id>.
   */
  private note = (level: Level, event: string, fields: Fields = {}) => {
    log(level, "agent", event, { chat: short(this.name), ...fields });
    this.sql`INSERT INTO events (ts, level, event, fields) VALUES (${Date.now()}, ${level}, ${event}, ${JSON.stringify(fields)})`;
    this.sql`DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ${EVENT_HISTORY}`;
  };

  // ---------------------------------------------------------------- ingress
  // Called over RPC by the webhook Worker. These return quickly: the slow
  // agent turn is handed to the scheduler so Linq gets its 200 immediately.

  async ingestMessage(msg: { linqId: string; from: string; text: string; isGroup?: boolean }) {
    const seen = this.sql<Row>`SELECT 1 FROM messages WHERE linq_id = ${msg.linqId}`;
    if (seen.length) {
      this.note("info", "message.duplicate", { linqId: short(msg.linqId) }); // Linq retries webhooks
      return;
    }
    this.note("info", "message.in", { from: mask(msg.from), chars: msg.text.length, group: msg.isGroup });

    if (msg.isGroup !== undefined) this.setMeta("is_group", msg.isGroup ? "1" : "0");
    this.sql`INSERT OR IGNORE INTO participants (handle) VALUES (${msg.from})`;
    this.sql`INSERT INTO messages (linq_id, direction, author, body, ts)
             VALUES (${msg.linqId}, 'in', ${msg.from}, ${msg.text}, ${Date.now()})`;

    // A short delay batches a burst of texts into a single turn.
    await this.schedule(2, "runTurn");
  }

  async ingestReaction(r: { messageId: string; from: string; reactionType: string }) {
    if (r.messageId !== this.getMeta("card_message_id")) {
      this.note("info", "reaction.ignored", { reason: "not on the plan card", type: r.reactionType });
      return;
    }
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
    if (this.state.awaiting.length === 0) await this.schedule(2, "runTurn");
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

  private async syncCard() {
    const messageId = this.getMeta("card_message_id");
    if (!messageId) return;
    // A failed redraw must not abort the turn that caused it; timed() records it.
    await timed("agent", "card.update", { version: this.state.version }, () =>
      updateCard(this.env, messageId, this.name, this.state, this.participants().length),
      this.note,
    ).catch(() => {});
  }

  private async say(text: string) {
    await timed("agent", "message.out", { chars: text.length }, () => sendText(this.env, this.name, text), this.note);
    this.sql`INSERT INTO messages (direction, body, ts) VALUES ('out', ${text}, ${Date.now()})`;
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
    const people = this.participants();

    const history = this.sql<{ direction: string; author: string | null; body: string | null }>`
      SELECT direction, author, body FROM messages ORDER BY id DESC LIMIT ${HISTORY_LIMIT}`.reverse();
    const transcript = history
      .map((m) => `${m.direction === "in" ? this.label(m.author, people) : "you"}: ${m.body ?? ""}`)
      .join("\n");

    const plan = this.state.status === "idle" ? "none yet" : JSON.stringify(this.state);

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `People in the chat: ${people.map((p) => this.label(p.handle, people)).join(", ")}
Current plan: ${plan}
Now: ${new Date().toISOString()}
${
  this.getMeta("is_group") === "0"
    ? "This is a direct one-to-one chat, so every message is addressed to you: always reply, never NOOP."
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
        // Smaller dev models often answer in plain content instead of calling
        // send_message, so treat trailing content as the message.
        const text = reply.content?.trim();
        const silent = !text || text === "NOOP";
        if (!silent && !spoke) await this.say(text);
        // "silent" is a decision, not a failure — but it is the first thing to
        // check when someone asks why the agent did not answer.
        end("info", spoke || !silent ? "replied" : "silent", { steps: step + 1 });
        return;
      }

      for (const call of calls) {
        let output: string;
        const tool = call.function.name;
        toolsUsed.push(tool);
        try {
          output = await timed(
            "agent",
            "tool",
            // Arguments are useful for every tool except the one carrying message text.
            { tool, args: tool === "send_message" ? "(text)" : call.function.arguments.slice(0, 300) },
            () => this.runTool(tool, call.function.arguments),
            this.note,
          );
          if (tool === "send_message") spoke = true;
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
    }
    end("warn", "max_steps");
  }

  private async runTool(name: string, rawArgs: string): Promise<string> {
    if (!(name in toolSchemas)) return `Unknown tool: ${name}`;

    switch (name as ToolName) {
      case "send_message": {
        const { text } = parseToolArgs("send_message", rawArgs);
        await this.say(text);
        return "sent";
      }

      case "remember_name": {
        const { who, name: goesBy } = parseToolArgs("remember_name", rawArgs);
        const person = this.participants().find((p) => this.label(p.handle) === who);
        if (!person) return `No participant labelled ${who}`;
        this.sql`UPDATE participants SET name = ${goesBy} WHERE handle = ${person.handle}`;
        return "remembered";
      }

      case "search_places": {
        const { query, near } = parseToolArgs("search_places", rawArgs);
        return JSON.stringify(await searchPlaces(query, near));
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
          if (id) this.setMeta("card_message_id", id);
          // Recipients without the extension see a static card with no
          // affordance, so spell out the tapback convention once.
          await this.say(`react to vote:\n${tapbackLegend(this.state)}`);
        }

        await this.schedule(NUDGE_AFTER_SECONDS, "nudge");
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
        return JSON.stringify(found).slice(0, 6000);
      }

      case "shop_build_cart": {
        const { shop, lines } = parseToolArgs("shop_build_cart", rawArgs);
        const result = await createCart(this.env, shop, lines);
        const cart = result?.cart ?? result;
        const checkoutUrl: string | undefined = cart?.checkout_url ?? cart?.continue_url;
        if (!checkoutUrl) return `Cart created but no checkout url found: ${JSON.stringify(cart).slice(0, 800)}`;

        this.publish({
          cart: {
            shop,
            checkoutUrl,
            lines: lines.map((l) => ({ title: l.title, quantity: l.quantity })),
          },
        });
        await this.say(checkoutUrl);
        return "Checkout link posted to the chat.";
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

  /** Simulator only (see /api/dev in index.ts). */
  async dump() {
    return {
      state: this.state,
      transcript: this.sql<Row>`SELECT direction, author, body FROM messages ORDER BY id`,
      votes: this.sql<Row>`SELECT voter, option_id, source FROM votes`,
    };
  }

  /** Most recent events, oldest first. Simulator only. */
  async events(limit = 100) {
    return this.sql<{ ts: number; level: string; event: string; fields: string }>`
      SELECT ts, level, event, fields FROM events ORDER BY id DESC LIMIT ${limit}`.reverse();
  }

  // ------------------------------------------------------ scheduled + workflow

  /** Fires a while after voting opens. */
  async nudge() {
    if (this.state.status !== "voting" || this.state.awaiting.length === 0) return;
    this.note("info", "nudge", { awaiting: this.state.awaiting.length });
    await this.say(`still need a vote from ${this.state.awaiting.join(", ")}`);
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
    await this.say(
      result.ok
        ? `booked ${option?.title ?? "it"}${result.confirmation ? ` — ${result.confirmation}` : ""}`
        : `couldn't book ${option?.title ?? "it"}: ${result.detail ?? "unknown error"}`,
    );
  }
}
