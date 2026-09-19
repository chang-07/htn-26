// Seed a clearly marked LOCAL fixture. No models, messages or external services are called.
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const started = Date.now() - 5000;
const runId = "observability-local-smoke";
const traceId = "a".repeat(32);
const events = [
  [0, "info", "turn.start", { llm: "synthetic/local-check", history: 0 }],
  [0, "info", "trace.start", { operation: "agent.model", op: "gen_ai.chat", spanId: "1".repeat(16), started }],
  [1800, "info", "trace.end", { operation: "agent.model", op: "gen_ai.chat", spanId: "1".repeat(16), started, ms: 1800, status: "ok" }],
  [1800, "info", "turn.step", { step: 1, decision: "Selected synthetic search (fixture only)", calls: ["search"], tokens: 1250, inputTokens: 1000, outputTokens: 250, cachedTokens: 500, reasoningTokens: 40 }],
  [1800, "info", "trace.start", { operation: "provider.search", op: "http.client", spanId: "2".repeat(16), started: started + 1800 }],
  [2600, "error", "trace.end", { operation: "provider.search", op: "http.client", spanId: "2".repeat(16), started: started + 1800, ms: 800, status: "error", error: "Synthetic provider timeout — test fixture", errorType: "TimeoutError" }],
  [2600, "warn", "llm.validation_failed", { retry: true, attempt: 1 }],
  [3000, "info", "turn.end", { outcome: "synthetic-check", tokens: 1250, steps: 1, ms: 3000, tools: ["synthetic search"] }],
];
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sql = [
  `DELETE FROM run_events WHERE run_id=${quote(runId)};`,
  `INSERT OR REPLACE INTO runs (run_id, chat, trigger, started, ended, outcome, level, ms, tokens, steps, tools, events) VALUES (${quote(runId)}, 'LOCAL SYNTHETIC CHECK', 'message.in', ${started}, ${started + 3000}, 'synthetic-check', 'error', 3000, 1250, 1, '["synthetic search"]', ${events.length});`,
  ...events.map(([offset, level, event, fields], seq) => `INSERT INTO run_events (run_id, seq, ts, level, event, fields) VALUES (${quote(runId)}, ${seq}, ${started + offset}, ${quote(level)}, ${quote(event)}, ${quote(JSON.stringify({ traceId, ...fields }))});`),
].join("\n");
const dir = await mkdtemp(join(tmpdir(), "plan-observability-"));
const file = join(dir, "fixture.sql");
await writeFile(file, sql);
const result = spawnSync("npx", ["wrangler", "d1", "execute", "htn-runs", "--local", "--file", file], { stdio: "inherit", env: { ...process.env, WRANGLER_LOG_PATH: join(dir, "wrangler.log") } });
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Local fixture: http://localhost:5173/runs/${runId}`);
