import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { expireRunRecords, RunTimeoutError, TIMEOUT_SEQ } from "../src/server/run-timeouts.ts";
import { mergeRunState, RUN_TIMEOUT_MS } from "../src/shared/run-timeout.ts";

function database(t) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync("migrations/0001_runs.sql", "utf8"));
  t.after(() => sql.close());
  const db = { prepare(query) {
    const statement = sql.prepare(query);
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async all() { return { results: statement.all(...values) }; },
      async first() { return statement.get(...values) ?? null; },
      async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
    };
  }, async batch(statements) {
    sql.exec("BEGIN");
    try { const results = []; for (const s of statements) results.push(await s.run()); sql.exec("COMMIT"); return results; }
    catch (error) { sql.exec("ROLLBACK"); throw error; }
  } };
  const add = (id, started, ended = null) => sql.prepare("INSERT INTO runs (run_id,chat,started,ended,events,tools) VALUES (?, 'chat', ?, ?, 1, '[]')").run(id, started, ended);
  return { sql, db, add };
}

test("30-minute deadline persists an error and captures one Sentry exception", async (t) => {
  const { sql, db, add } = database(t);
  add("stuck", 100); add("fresh", 101); add("closed", 0, 1);
  let captures = 0;
  const capture = (error, id) => { captures++; assert.ok(error instanceof RunTimeoutError); assert.equal(id, "stuck"); return "sentry-id"; };
  const result = await expireRunRecords(db, capture, 100 + RUN_TIMEOUT_MS);
  assert.equal(result.length, 1);
  assert.equal(result[0].run.outcome, "timed_out");
  const run = sql.prepare("SELECT * FROM runs WHERE run_id='stuck'").get();
  assert.equal(run.level, "error"); assert.equal(run.ms, RUN_TIMEOUT_MS); assert.equal(run.ended, 100 + RUN_TIMEOUT_MS);
  const event = sql.prepare("SELECT * FROM run_events WHERE run_id='stuck'").get();
  assert.equal(event.seq, TIMEOUT_SEQ); assert.equal(event.event, "run.timeout");
  assert.equal(JSON.parse(event.fields).sentryEventId, "sentry-id");
  await expireRunRecords(db, capture, 100 + RUN_TIMEOUT_MS);
  assert.equal(captures, 1);
  assert.equal(sql.prepare("SELECT ended FROM runs WHERE run_id='fresh'").get().ended, null);
});

test("historical stranded runs are repaired after restart without an in-memory timer", async (t) => {
  const { db, add } = database(t); add("old", 0);
  const result = await expireRunRecords(db, () => undefined, 10 * RUN_TIMEOUT_MS);
  assert.equal(result[0].run.ended, RUN_TIMEOUT_MS);
  assert.equal(result[0].event.fields.detectedAt, 10 * RUN_TIMEOUT_MS);
});

test("Sentry failure cannot leave the frontend stuck running", async (t) => {
  const { db, add } = database(t); add("old", 0);
  const result = await expireRunRecords(db, () => { throw Error("Sentry unavailable"); }, RUN_TIMEOUT_MS);
  assert.equal(result[0].run.outcome, "timed_out");
  assert.equal(result[0].event.fields.sentryEventId, undefined);
});

test("a completion winning the race before the batch is never overwritten or reported", async (t) => {
  const { db, sql, add } = database(t); add("race", 0);
  const batch = db.batch;
  db.batch = async (statements) => {
    sql.prepare("UPDATE runs SET ended=1, outcome='replied' WHERE run_id='race'").run();
    return batch(statements);
  };
  assert.deepEqual(await expireRunRecords(db, () => assert.fail("false timeout"), RUN_TIMEOUT_MS), []);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM run_events").get().n, 0);
});

test("delayed snapshots cannot resurrect closed or timed-out runs", () => {
  const running = { ended: null, outcome: null };
  const completed = { ended: 1, outcome: "background" };
  const expired = { ended: 2, outcome: "timed_out" };
  assert.equal(mergeRunState(completed, running), completed);
  assert.equal(mergeRunState(expired, completed), expired);
  assert.equal(mergeRunState(running, expired), expired);
});

// Real hub SQL and fan-out, with only the Agents runtime replaced.
const bundle = await build({ entryPoints: ["src/server/runs.ts"], bundle: true, write: false, format: "esm", platform: "node", plugins: [{
  name: "agent-runtime", setup(b) {
    b.onResolve({ filter: /^agents$/ }, () => ({ path: "agents", namespace: "mock" }));
    b.onLoad({ filter: /.*/, namespace: "mock" }, () => ({ contents: "export class Agent {} export const getAgentByName = () => {};", loader: "js" }));
  },
}] });
const { RunHub } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("hub schedules a durable sweep, broadcasts timeout, and rejects late close/replayed open", async (t) => {
  const { db, sql, add } = database(t); add("old", 0);
  const hub = new RunHub(); hub.env = { RUNS_DB: db };
  const scheduled = []; const feed = [];
  hub.schedule = async (...args) => scheduled.push(args);
  hub.broadcast = (raw) => feed.push(JSON.parse(raw));
  await hub.onStart();
  assert.deepEqual(scheduled[0], ["* * * * *", "expireRuns"]);
  await Promise.all([hub.expireRuns(), hub.expireRuns()]);
  assert.deepEqual(feed.map((m) => m.type), ["events", "run.close"]);
  assert.equal(feed[1].run.outcome, "timed_out");
  await hub.ingest({ kind: "close", run: { runId: "old", ended: Date.now(), outcome: "replied", level: "info", ms: 1, tokens: 1, steps: 1, tools: [] } });
  assert.equal(feed.length, 2);
  await hub.ingest({ kind: "open", run: { runId: "old", chat: "chat", started: Date.now(), trigger: "turn.start" } });
  assert.equal(feed.length, 2);
  assert.equal(sql.prepare("SELECT outcome FROM runs WHERE run_id='old'").get().outcome, "timed_out");
});
