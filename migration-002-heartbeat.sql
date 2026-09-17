-- Design Hub migration 002
-- Local-agent heartbeat.
--
-- Everything between the board and the runner is pull-only: the runner reads
-- the queue, the Hub never reaches out to it. So a press that queues Figma or
-- Mobbin work — both local-only, both OAuth on a person's own machine, never
-- reachable from GitHub Actions — looked identical whether or not any machine
-- was actually going to pick it up. Silence from a laptop that had stopped
-- checking in read exactly like silence from one that had never existed.
--
-- The local runner now posts here every time it wakes up, whether or not it
-- found anything queued, so the board can say which of those it actually is.
--
-- Purely additive: one new table, nothing existing touched.

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  machine      TEXT PRIMARY KEY,   -- hostname, e.g. "dave-bell-jr"
  capabilities TEXT,               -- JSON array, e.g. ["research","design","figma","mobbin"]
  last_seen    TEXT NOT NULL,
  first_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);
