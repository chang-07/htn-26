-- The timeout sweep asks for runs that are still open, once a minute and on
-- every /api/runs request. With only runs_started to use, it walked every run
-- ever recorded to find the handful with no end, and D1 bills each row walked.
-- Open runs are a few rows at most, so index just those.

CREATE INDEX IF NOT EXISTS runs_open ON runs (started) WHERE ended IS NULL;
