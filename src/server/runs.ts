/**
 * Run history: what the agent did, turn by turn, across every chat.
 *
 * Three pieces:
 *
 *   RunRecorder  lives inside each PlanAgent. It knows where turns begin and
 *                end, so it is the only thing that can group loose events into
 *                runs. Produces rows; never touches D1 itself.
 *   RunHub       one Durable Object for the whole Worker. Single writer to D1,
 *                and the fan-out point for the live viewer's WebSocket.
 *   listRuns/…   plain D1 reads for the HTTP API.
 *
 * Why a hub rather than writing D1 from each agent: D1 has no transactions
 * across calls and every chat would be an independent writer racing on the same
 * two tables. One hub batches them and gets WebSocket fan-out for free.
 *
 * Privacy: these rows are whatever `note()` already logged, which masks phone
 * numbers and records message bodies as lengths. Nothing new is exposed — but
 * the viewer is reachable from the internet, so see requireRunsAuth().
 */
import { Agent, getAgentByName, type Connection } from "agents";
import type { Fields, Level } from "./log";
import { errorFields, log } from "./log";

/** One logged event, already bound to the run it belongs to. */
export type RunEventRow = {
  runId: string;
  chat: string;
  seq: number;
  ts: number;
  level: Level;
  event: string;
  fields: Fields;
};

export type RunSummary = {
  runId: string;
  chat: string;
  trigger: string | null;
  started: number;
  ended: number | null;
  outcome: string | null;
  level: Level;
  ms: number | null;
  tokens: number | null;
  steps: number | null;
  tools: string[];
  events: number;
};

/** Sent to the viewer over the hub's WebSocket. */
export type RunFeedMessage =
  | { type: "hello"; runs: RunSummary[] }
  | { type: "run.open"; run: RunOpen }
  | { type: "run.close"; run: RunClose }
  | { type: "events"; events: RunEventRow[] };

type RunOpen = { runId: string; chat: string; trigger: string; started: number };
type RunClose = {
  runId: string;
  ended: number;
  outcome: string;
  level: Level;
  ms: number | null;
  tokens: number | null;
  steps: number | null;
  tools: string[];
};

/** Events that open and close a run. Everything else lands inside the open one. */
const RUN_START = "turn.start";
const RUN_END = new Set(["turn.end", "turn.crashed"]);
/** Loose events waiting to be adopted by the next turn are flushed after this. */
const ORPHAN_MAX_AGE_MS = 2 * 60 * 1000;
/**
 * How long out-of-turn events wait to be adopted by a turn. A message that
 * wakes the agent is followed by turn.start about two seconds later, so this
 * has to outlast that; anything still unclaimed afterwards is its own run.
 */
const ORPHAN_FLUSH_MS = 6_000;
const ORPHAN_MAX = 50;

const LEVEL_RANK: Record<Level, number> = { info: 0, warn: 1, error: 2 };
const worst = (a: Level, b: Level) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);
/** The same ranking in SQL, for the level rollup on the run row. */
const RANK_SQL = (expr: string) => `(CASE ${expr} WHEN 'error' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END)`;

/**
 * Groups a chat's event stream into runs and ships them to the hub.
 *
 * A run is one agent turn plus its lead-in: the inbound message that woke it,
 * a research callback that landed first. Those arrive *before* turn.start, so
 * they are held in `orphans` and adopted when the turn opens. Events that are
 * never adopted (a research workflow reporting into a silent chat) are flushed
 * as a run of their own rather than being lost.
 */
export class RunRecorder {
  private runId: string | null = null;
  private seq = 0;
  private orphans: { ts: number; level: Level; event: string; fields: Fields }[] = [];

  constructor(
    private readonly env: Env,
    private readonly chat: string,
    /** Keeps the DO alive until the write lands; the turn itself never waits. */
    private readonly background: (p: Promise<unknown>) => void,
  ) {}

  record(level: Level, event: string, fields: Fields) {
    const ts = Date.now();

    if (event === RUN_START) {
      // A turn that crashed without logging turn.end leaves the previous run
      // open; opening a new one is what closes it (ended stays NULL, and the
      // viewer shows it as abandoned rather than silently merging the two).
      this.open(fields);
      this.emit([
        // Lead-in first, in arrival order, so the timeline reads correctly.
        ...this.drainOrphans(),
        { ts, level, event, fields },
      ]);
      return;
    }

    if (!this.runId) {
      this.orphans.push({ ts, level, event, fields });
      const stale = ts - this.orphans[0].ts > ORPHAN_MAX_AGE_MS;
      if (stale || this.orphans.length >= ORPHAN_MAX) this.flushOrphans();
      else this.armFlush();
      return;
    }

    this.emit([{ ts, level, event, fields }]);
    if (RUN_END.has(event)) this.close(level, fields);
  }

  private flushArmed = false;

  /**
   * Out-of-turn events used to be flushed only when a LATER event happened to
   * arrive — so a vote, a research callback or a message stored while the agent
   * slept stayed invisible until something else occurred, and was lost outright
   * if the Durable Object was evicted first. A timer flushes them on their own.
   */
  private armFlush() {
    if (this.flushArmed) return;
    this.flushArmed = true;
    this.background(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          this.flushArmed = false;
          // A turn that opened meanwhile has already adopted them.
          if (!this.runId && this.orphans.length) this.flushOrphans();
          resolve();
        }, ORPHAN_FLUSH_MS),
      ),
    );
  }

  /** Give unclaimed events a run of their own, labelled as what it is. */
  private flushOrphans() {
    if (!this.orphans.length) return;
    const rank: Record<Level, number> = { info: 0, warn: 1, error: 2 };
    const worst = this.orphans.reduce<Level>((w, o) => (rank[o.level] > rank[w] ? o.level : w), "info");
    this.open({ trigger: this.orphans[0].event });
    this.emit(this.drainOrphans());
    // Not a crash: nothing ran. Without an outcome close() would call it one.
    this.close(worst, { outcome: "background" });
  }

  private open(fields: Fields) {
    this.runId = crypto.randomUUID();
    this.seq = 0;
    const trigger =
      typeof fields.trigger === "string" ? fields.trigger : (this.orphans[0]?.event ?? RUN_START);
    this.send({
      kind: "open",
      run: { runId: this.runId, chat: this.chat, trigger, started: Date.now() },
    });
  }

  private close(level: Level = "info", fields: Fields = {}) {
    if (!this.runId) return;
    this.send({
      kind: "close",
      run: {
        runId: this.runId,
        ended: Date.now(),
        outcome: typeof fields.outcome === "string" ? fields.outcome : "crashed",
        level,
        ms: num(fields.ms),
        tokens: num(fields.tokens),
        steps: num(fields.steps),
        tools: Array.isArray(fields.tools) ? (fields.tools as string[]) : [],
      },
    });
    this.runId = null;
  }

  private drainOrphans() {
    const held = this.orphans;
    this.orphans = [];
    return held;
  }

  private emit(items: { ts: number; level: Level; event: string; fields: Fields }[]) {
    const runId = this.runId!;
    const rows: RunEventRow[] = items.map((i) => ({ ...i, runId, chat: this.chat, seq: this.seq++ }));
    this.send({ kind: "events", events: rows });
  }

  private send(msg: HubMessage) {
    this.background(
      (async () => {
        const hub = await getAgentByName<Env, RunHub>(this.env.RunHub, HUB_NAME);
        await hub.ingest(msg);
      })().catch((err) => {
        // Losing run history must never take down a turn, so this is logged and
        // dropped. If the hub is broken the chat still works.
        log("warn", "runs", "hub.ingest_failed", { chat: this.chat, ...errorFields(err) });
      }),
    );
  }
}

const num = (v: unknown) => (typeof v === "number" ? v : null);

// ------------------------------------------------------------------- the hub

export const HUB_NAME = "global";

type HubMessage =
  | { kind: "open"; run: RunOpen }
  | { kind: "close"; run: RunClose }
  | { kind: "events"; events: RunEventRow[] };

/**
 * The Worker's single run-history writer, and the socket the viewer holds.
 *
 * It is an Agent purely for the plumbing: `routeAgentRequest` already serves
 * /agents/run-hub/global, and `broadcast` already fans out to every open
 * viewer. It keeps no state of its own — D1 is the store.
 */
export class RunHub extends Agent<Env, Record<string, never>> {
  initialState = {};

  /** Called over RPC by every PlanAgent's recorder. */
  async ingest(msg: HubMessage) {
    const db = this.env.RUNS_DB;
    try {
      if (msg.kind === "open") {
        const { runId, chat, trigger, started } = msg.run;
        await db
          .prepare(`INSERT OR REPLACE INTO runs (run_id, chat, trigger, started) VALUES (?, ?, ?, ?)`)
          .bind(runId, chat, trigger, started)
          .run();
      } else if (msg.kind === "close") {
        const r = msg.run;
        await db
          .prepare(
            `UPDATE runs SET ended = ?, outcome = ?, level = ?, ms = ?, tokens = ?, steps = ?, tools = ?
             WHERE run_id = ?`,
          )
          .bind(r.ended, r.outcome, r.level, r.ms, r.tokens, r.steps, JSON.stringify(r.tools), r.runId)
          .run();
      } else if (msg.events.length) {
        const inserts = msg.events.map((e) =>
          db
            .prepare(
              `INSERT OR REPLACE INTO run_events (run_id, seq, ts, level, event, fields)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind(e.runId, e.seq, e.ts, e.level, e.event, JSON.stringify(e.fields)),
        );
        // The count and the worst level are kept on the run row so the list
        // query never has to touch run_events.
        const level = msg.events.reduce<Level>((acc, e) => worst(acc, e.level), "info");
        inserts.push(
          db
            .prepare(
              // Levels do not sort as strings ('error' < 'info' < 'warn'), so
              // rank both sides before deciding whether this batch is worse.
              `UPDATE runs SET events = events + ?,
                 level = CASE WHEN ${RANK_SQL("?")} > ${RANK_SQL("level")} THEN ? ELSE level END
               WHERE run_id = ?`,
            )
            .bind(msg.events.length, level, level, msg.events[0].runId),
        );
        await db.batch(inserts);
      }
    } catch (err) {
      log("warn", "runs", "d1.write_failed", { kind: msg.kind, ...errorFields(err) });
    }

    // Broadcast even if the write failed: a live viewer showing the run is more
    // useful than consistency with a table nobody is reading yet.
    this.push(
      msg.kind === "events"
        ? { type: "events", events: msg.events }
        : msg.kind === "open"
          ? { type: "run.open", run: msg.run }
          : { type: "run.close", run: msg.run },
    );
  }

  /** New viewer: hand it the recent runs so it renders before anything happens. */
  async onConnect(connection: Connection) {
    const runs = await listRuns(this.env, { limit: 50 }).catch(() => []);
    connection.send(JSON.stringify({ type: "hello", runs } satisfies RunFeedMessage));
  }

  private push(msg: RunFeedMessage) {
    try {
      this.broadcast(JSON.stringify(msg));
    } catch {
      // No viewers connected, or a socket died mid-write. Not worth a log line.
    }
  }
}

// ------------------------------------------------------------------- queries

type RunRow = Omit<RunSummary, "tools" | "runId"> & { run_id: string; tools: string };

const toSummary = (r: RunRow): RunSummary => ({
  runId: r.run_id,
  chat: r.chat,
  trigger: r.trigger,
  started: r.started,
  ended: r.ended,
  outcome: r.outcome,
  level: r.level,
  ms: r.ms,
  tokens: r.tokens,
  steps: r.steps,
  tools: JSON.parse(r.tools || "[]"),
  events: r.events,
});

export async function listRuns(
  env: Env,
  opts: { chat?: string; outcome?: string; level?: string; before?: number; limit?: number } = {},
): Promise<RunSummary[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.chat) (where.push("chat = ?"), binds.push(opts.chat));
  if (opts.outcome) (where.push("outcome = ?"), binds.push(opts.outcome));
  if (opts.level) (where.push("level = ?"), binds.push(opts.level));
  if (opts.before) (where.push("started < ?"), binds.push(opts.before));
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const { results } = await env.RUNS_DB.prepare(
    `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY started DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<RunRow>();
  return results.map(toSummary);
}

export async function getRun(env: Env, runId: string) {
  const run = await env.RUNS_DB.prepare(`SELECT * FROM runs WHERE run_id = ?`).bind(runId).first<RunRow>();
  if (!run) return null;
  const { results } = await env.RUNS_DB.prepare(
    `SELECT seq, ts, level, event, fields FROM run_events WHERE run_id = ? ORDER BY seq`,
  )
    .bind(runId)
    .all<{ seq: number; ts: number; level: Level; event: string; fields: string }>();
  return {
    run: toSummary(run),
    events: results.map((e) => ({ ...e, fields: JSON.parse(e.fields) as Fields })),
  };
}

/** Chat picker for the viewer: who has runs, and how recently. */
export async function listChats(env: Env) {
  const { results } = await env.RUNS_DB.prepare(
    `SELECT chat, COUNT(*) AS runs, MAX(started) AS last,
            SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors
     FROM runs GROUP BY chat ORDER BY last DESC LIMIT 100`,
  ).all<{ chat: string; runs: number; last: number; errors: number }>();
  return results;
}

/**
 * The viewer is on the public Worker and run history names tools, briefs and
 * masked handles. If RUNS_TOKEN is set as a secret, every /api/runs request
 * must carry it; if it is unset the viewer is open, which is fine locally and
 * a deliberate choice anywhere else.
 */
export function requireRunsAuth(request: Request, url: URL, env: Env): Response | null {
  const expected = (env as { RUNS_TOKEN?: string }).RUNS_TOKEN;
  if (!expected) return null;
  const given = url.searchParams.get("token") ?? request.headers.get("authorization")?.replace(/^Bearer /, "");
  return given === expected ? null : new Response("unauthorized", { status: 401 });
}
