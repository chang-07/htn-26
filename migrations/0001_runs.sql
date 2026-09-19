-- Run history for the agent-run viewer.
--
-- A "run" is one agent turn: everything between turn.start and turn.end, plus
-- the events that led into it (the inbound message, a research callback) since
-- the previous turn closed. The chat's own Durable Object keeps a 300-row ring
-- buffer for live debugging; this table is the durable, cross-chat copy.

CREATE TABLE IF NOT EXISTS runs (
  run_id   TEXT PRIMARY KEY,
  chat     TEXT NOT NULL,
  -- What woke the agent: "message.in", "vote.cast", "research.finished", ...
  trigger  TEXT,
  started  INTEGER NOT NULL,
  -- NULL while the run is still going; the viewer shows those as live.
  ended    INTEGER,
  -- turn.end's outcome: replied | silent | llm_failed | max_steps | crashed.
  outcome  TEXT,
  -- Worst level seen in the run, so the list can flag bad runs without a join.
  level    TEXT NOT NULL DEFAULT 'info',
  ms       INTEGER,
  tokens   INTEGER,
  steps    INTEGER,
  -- JSON array of tool names, in call order.
  tools    TEXT NOT NULL DEFAULT '[]',
  events   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS runs_started      ON runs (started DESC);
CREATE INDEX IF NOT EXISTS runs_chat_started ON runs (chat, started DESC);

CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  -- Per-run sequence. Ordering by ts alone ties: several events share a ms.
  seq    INTEGER NOT NULL,
  ts     INTEGER NOT NULL,
  level  TEXT NOT NULL,
  event  TEXT NOT NULL,
  fields TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
