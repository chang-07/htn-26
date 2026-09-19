import { RUN_TIMEOUT_MS, RUN_TIMEOUT_MESSAGE } from "../shared/run-timeout.ts";

export class RunTimeoutError extends Error {
  constructor() { super(RUN_TIMEOUT_MESSAGE); this.name = "RunTimeoutError"; }
}
// Reserved outside the recorder's sequence space, so late progress cannot overwrite the error.
export const TIMEOUT_SEQ = 2147483647;

/** Atomic conditional writes make timer/read races and repeated sweeps idempotent. */
export async function expireRunRecords(db: D1Database, capture: (error: Error, runId: string) => string | undefined, now = Date.now()) {
  const { results } = await db.prepare(
    "SELECT run_id, chat, started, tokens, steps, tools FROM runs WHERE ended IS NULL AND started <= ? ORDER BY started LIMIT 100",
  ).bind(now - RUN_TIMEOUT_MS).all<{ run_id: string; chat: string; started: number; tokens: number | null; steps: number | null; tools: string | null }>();
  const expired = [];
  for (const row of results) {
    const ended = row.started + RUN_TIMEOUT_MS;
    const fields: Record<string, unknown> = { error: RUN_TIMEOUT_MESSAGE, errorType: "RunTimeoutError", timeoutMs: RUN_TIMEOUT_MS, detectedAt: now };
    const writes = await db.batch([
      db.prepare(`INSERT INTO run_events (run_id, seq, ts, level, event, fields)
        SELECT run_id, ?, ?, 'error', 'run.timeout', ? FROM runs WHERE run_id = ? AND ended IS NULL`)
        .bind(TIMEOUT_SEQ, ended, JSON.stringify(fields), row.run_id),
      db.prepare(`UPDATE runs SET ended = ?, outcome = 'timed_out', level = 'error', ms = ?, events = events + 1
        WHERE run_id = ? AND ended IS NULL`).bind(ended, RUN_TIMEOUT_MS, row.run_id),
    ]);
    if (!writes[1].meta.changes) continue;
    // Capture only the winning transition, after it is durably stored. Never send message bodies.
    try {
      const eventId = capture(new RunTimeoutError(), row.run_id);
      if (eventId) {
        fields.sentryEventId = eventId;
        await db.prepare("UPDATE run_events SET fields = ? WHERE run_id = ? AND seq = ?")
          .bind(JSON.stringify(fields), row.run_id, TIMEOUT_SEQ).run();
      }
    } catch { /* The timeout stays visible even if Sentry is unavailable. */ }
    expired.push({
      run: { runId: row.run_id, ended, outcome: "timed_out", level: "error" as const, ms: RUN_TIMEOUT_MS,
        tokens: row.tokens, steps: row.steps, tools: JSON.parse(row.tools || "[]") as string[] },
      event: { runId: row.run_id, chat: row.chat, seq: TIMEOUT_SEQ, ts: ended, level: "error" as const, event: "run.timeout", fields },
    });
  }
  return expired;
}
