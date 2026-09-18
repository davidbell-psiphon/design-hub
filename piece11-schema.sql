-- Piece 11: three kinds of fact, three homes.
-- Run with: npx wrangler d1 execute design-hub --remote --file=./piece11-schema.sql
--
-- WHY THE SESSION TABLE IS CALLED stage_sessions
--
-- Because `sessions` was taken, and finding that out cost a failed deploy.
--
-- The retired chat organiser left a `sessions` table in the live database: the
-- password-auth one, token and expires_at, dead since Cloudflare Access took
-- over. It is still there because section 13 step 4 has not been run. So
-- CREATE TABLE IF NOT EXISTS sessions did nothing at all, silently, and the
-- next statement failed with `no such column: requested_at`.
--
-- The local suite could not see it: the harness built a database with the four
-- live tables and nothing else, so the name was free. freshDb creates the
-- legacy tables now, which is what production actually looks like.
--
-- Before adding a table here, check schema.sql for the name.
--
-- WHAT THIS IS FOR
--
-- agent_sessions held three different kinds of thing in one row:
--
--   the issue    Linear owns it. The Hub keeps a copy so the board can render
--                without a Linear call per card
--   the card     what you decided about the issue here: dismissed, set aside,
--                a Figma destination, a brand correction
--   the session  what a run is doing right now, and the gate it is sitting at
--
-- Section 2 says a session is (issue_key, stage). The row was one per issue, so
-- there was one gate, one status and one error per ISSUE, not per stage. That
-- works today only because runs are serialised and one stage is ever in flight.
-- It stops working the moment research is Drift while design is Unverified
-- (section 3), or research failed while design waits on a gate (section 4), or
-- a design gate is reopened without disturbing research history (section 8).
--
-- So the three go into two tables, split on who owns them.
--
-- NOTHING IS DROPPED. agent_sessions is left exactly as it is, frozen at the
-- moment migration-004 copies out of it. It becomes the rollback: revert the
-- Worker and it is still there, still correct. Nothing reads or writes it
-- afterwards.

-- ── The card: one per Linear issue ───────────────────────────────────────
--
-- Keyed by the issue key outright (section 2). There is no separate id, no
-- alias and nothing to reconcile: the key IS the primary key, so a second card
-- for one issue cannot be written rather than being merged away afterwards.
CREATE TABLE IF NOT EXISTS cards (
  issue_key      TEXT PRIMARY KEY,   -- RYV-84. Section 2: the only identity.

  -- ── Linear-owned. A cache, and allowed to be one on the three conditions in
  -- section 5: it is obviously a cache here, it has a visible age, and no
  -- decision is made from it. Every reader pass REPLACES these wholesale.
  -- Never COALESCE one of them, or a stale value survives for ever and the
  -- cache has quietly become a second home.
  linear_uuid    TEXT,               -- the internal Linear id, for mutations
  title          TEXT,
  description    TEXT,               -- the Linear description, and only ever that
  url            TEXT,
  team           TEXT,
  linear_state   TEXT,               -- backlog | started | completed | canceled
  labels         TEXT,               -- JSON array. Linear owns the whole set
  linear_project TEXT,
  linear_read_at TEXT,               -- the visible age section 5 asks for

  -- ── Hub-owned. Your decisions about the issue. A reader pass must never
  -- touch any of these, which is the other half of the section 5 pair.
  brand          TEXT,               -- conduit. Named for what it holds: the old
                                     -- column was called project, held the brand,
                                     -- and needed a comment to say so every time.
  track          TEXT,               -- app | website
  figma_url      TEXT,               -- your destination override
  dismissed_at   TEXT,               -- no-design: not design work at all
  set_aside_at   TEXT,               -- design work, but not for these agents

  created_at     TEXT DEFAULT (datetime('now')),
  updated_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cards_brand     ON cards(brand);
CREATE INDEX IF NOT EXISTS idx_cards_team      ON cards(team);
CREATE INDEX IF NOT EXISTS idx_cards_state     ON cards(linear_state);
CREATE INDEX IF NOT EXISTS idx_cards_dismissed ON cards(dismissed_at);

-- ── The session: one per (issue, stage) ──────────────────────────────────
--
-- The identity in section 2, as the primary key. A session EXISTS only once a
-- stage has been asked for or has run, which is what makes Not started in
-- section 3 the absence of a row rather than a status meaning two things.
--
-- The gate columns live here and ONLY here. They were on the card. They moved
-- rather than being copied, because a fact in two places is how every bug in
-- section 11 started.
CREATE TABLE IF NOT EXISTS stage_sessions (
  issue_key    TEXT NOT NULL,

  -- Deliberately unconstrained. The Hub runs research and design, and the
  -- trigger route refuses anything else. But that is the trigger vocabulary of
  -- the Hub, not a fact about what a session may be. CLAUDE.md: the Hub knows
  -- sessions, brands, states and prompts, and does not know what a gate or a QA
  -- agent is. A CHECK here would put the stage names of another agent system in
  -- the gift of this file.
  stage        TEXT NOT NULL,

  system       TEXT NOT NULL DEFAULT 'design-ai',  -- keeps another system pluggable

  -- blocked is reserved and nothing writes it yet. It is in the CHECK because
  -- changing a CHECK in SQLite means rebuilding the table, and section 4 is
  -- explicit that it must not be merged into error: a failed run crashed, a
  -- blocked run completed and correctly reported that it could not proceed.
  -- The research run that found every source unavailable was blocked, and
  -- treating that as a failure discards its most valuable output.
  status       TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','waiting','done','error','blocked')),

  -- ── The gate (section 8) ──
  prompt       TEXT,                 -- the question put to a human
  detail       TEXT,                 -- the context an agent gives behind it. NOT
                                     -- the Linear description, which is
                                     -- cards.description. The two sharing a
                                     -- column is why a guard was needed to stop
                                     -- a cron read wiping this.
  options      TEXT,                 -- JSON array of id, label, summary
  gate_round   INTEGER DEFAULT 1,
  response     TEXT,                 -- the decision in words, copied off the option
  response_option_id TEXT,           -- only ever an id that was actually offered
  response_note TEXT,
  responded_at TEXT,

  -- ── The run (section 4) ──
  requested_at TEXT,                 -- queued. NULL means not queued. The stage
                                     -- is the row, so there is no requested_stage.
  started_at   TEXT,                 -- when a runner claimed it
  agent_posted_at TEXT,              -- an agent has written here
  last_error   TEXT,                 -- section 4: an error that exists only in a
  last_error_at TEXT,                -- terminal you have closed is not an error state

  -- ── What the stage produced ──
  mockups_url  TEXT,
  mockups_at   TEXT,
  handoff_at   TEXT,

  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now')),

  PRIMARY KEY (issue_key, stage)
);

CREATE INDEX IF NOT EXISTS idx_stage_sessions_queued ON stage_sessions(requested_at);
CREATE INDEX IF NOT EXISTS idx_stage_sessions_status ON stage_sessions(status);
CREATE INDEX IF NOT EXISTS idx_stage_sessions_issue  ON stage_sessions(issue_key);
