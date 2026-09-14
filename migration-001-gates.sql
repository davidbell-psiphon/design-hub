-- Design Hub migration 001
-- Constrained gate decisions, re-openable gates, mockup + handoff state.
--
-- Purely additive. No drops, no rewrites, no data loss.
-- Existing code ignores columns it does not know about, so this is safe to
-- run before the application changes land.
--
-- RUN THE CHECK BLOCK FIRST (see CHECK.sql) — if any of these columns already
-- exist, SQLite will error on that statement and stop.

-- ── Constrained decisions ────────────────────────────────────────────────
-- The "Yes" bug: a three-option question got a free-text answer that named
-- nothing, and the client reported GATE: DECIDED. Options now carry stable
-- ids and the answer must match one.

-- JSON array: [{"id":"d1","label":"Icon-only corner button","summary":"..."}]
ALTER TABLE agent_sessions ADD COLUMN options TEXT;

-- Must equal one of options[].id. Enforced in the Worker, not here —
-- SQLite cannot validate membership of a JSON array in a CHECK constraint.
ALTER TABLE agent_sessions ADD COLUMN response_option_id TEXT;

-- Free text lives alongside the choice, never instead of it.
-- Carries "revise because the primary CTA is buried" without ever
-- being mistaken for the decision itself.
ALTER TABLE agent_sessions ADD COLUMN response_note TEXT;


-- ── Re-openable gates ────────────────────────────────────────────────────
-- gates.md lists "Revise — [feedback]" as a valid answer, which implies
-- returning to the same gate. Today an answered gate can never reopen.
-- Incrementing the round clears the decision and puts it back in front of you.

ALTER TABLE agent_sessions ADD COLUMN gate_round INTEGER DEFAULT 1;


-- ── Mockups and handoff ──────────────────────────────────────────────────
-- "AI-design done" means a spec was written, not that anything was drawn.
-- These give the two missing completion levels somewhere to live.

ALTER TABLE agent_sessions ADD COLUMN mockups_url TEXT;
ALTER TABLE agent_sessions ADD COLUMN mockups_at  TEXT;
ALTER TABLE agent_sessions ADD COLUMN handoff_at  TEXT;


-- ── Decision history ─────────────────────────────────────────────────────
-- One row per answered round. The session row holds the current state;
-- this holds the trail, so a revised direction does not erase the first.

CREATE TABLE IF NOT EXISTS gate_decisions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL,
  gate_round         INTEGER NOT NULL,
  options_snapshot   TEXT,           -- what was offered, as JSON
  response_option_id TEXT,           -- what was chosen
  response_note      TEXT,           -- why, if anything was said
  decided_at         TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gate_decisions_session
  ON gate_decisions(session_id, gate_round);
