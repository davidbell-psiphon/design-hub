-- Design Hub migration 004
-- Move what is in agent_sessions into the two tables piece11 created.
--
-- Run with:
--   npx wrangler d1 execute design-hub --remote --file=./piece11-schema.sql
--   npx wrangler d1 execute design-hub --remote --file=./migration-004-grain.sql
--   npx wrangler deploy
--
-- IN THAT ORDER, AND IN ONE SITTING. The currently deployed Worker keeps
-- reading `agent_sessions` and is unaffected by either file, so there is no
-- moment where the board is broken. But anything it writes between the copy
-- and the deploy lands in the old table and is not carried across. That window
-- should be a minute, not a morning. If the cron does fire inside it, press
-- Read Linear afterwards: Linear owns almost everything in `cards` and the
-- read puts it back.
--
-- SAFE TO RE-RUN. Every insert is INSERT OR IGNORE, so a second run adds what
-- is missing and overwrites nothing. That also means it will not pick up
-- changes made to `agent_sessions` after the first run — by then the new
-- tables are the truth and the old one is a snapshot.
--
-- NOTHING IS DROPPED. `agent_sessions` is untouched. It is the rollback.

-- ── Cards ────────────────────────────────────────────────────────────────
--
-- Only rows with a Linear issue. §2: a record with no issue key is not a card,
-- so the Hub-only sessions do not become one — they are left in the old table,
-- which is the honest place for them until something needs them again.
--
-- `description` takes the Linear description, which is what `detail` held
-- unless an agent had posted to the row. Where an agent had, the description
-- is left null and the next reader pass fills it in from Linear — the agent's
-- own context goes to sessions.detail below, and the two stop sharing a
-- column for good.
INSERT OR IGNORE INTO cards (
  issue_key, linear_uuid, title, description, url, team, linear_state, labels,
  linear_project, linear_read_at, brand, track, figma_url, dismissed_at,
  set_aside_at, created_at, updated_at)
SELECT
  linear_id,
  linear_uuid,
  title,
  CASE WHEN agent_posted_at IS NULL THEN detail ELSE NULL END,
  url,
  team,
  linear_state,
  labels,
  linear_project,
  updated_at,          -- the age of this cache is the last time anything wrote it
  project,             -- the column named `project` held the brand
  track,
  figma_url,
  dismissed_at,
  set_aside_at,
  created_at,
  updated_at
FROM agent_sessions
WHERE linear_id IS NOT NULL;

-- ── Sessions ─────────────────────────────────────────────────────────────
--
-- One per card, because one is all the old grain could hold. Which stage it
-- was is read back in this order:
--
--   the stage queued, if one is           — the most current statement of intent
--   else `phase`, if it names a stage     — what the agent last reported
--   else 'research'                       — the reader's default on every row
--
-- `phase` can hold 'qa', which was a stage the board offered and nothing ever
-- implemented (§12 retired the label). Those land on 'research'. The cost of
-- getting one of them wrong is small: which stage a card has *reached* is
-- derived from Linear labels, never from this row.
--
-- Rows the reader created and nothing ever ran get a session too, and that is
-- deliberate for this one migration: `status` and `prompt` on them are real
-- values the board may be rendering right now, and dropping them to make
-- "no session means not started" true from day one would change what is on
-- screen. New cards get no session until a stage is asked for.
INSERT OR IGNORE INTO sessions (
  issue_key, stage, system, status, prompt, detail, options, gate_round,
  response, response_option_id, response_note, responded_at,
  requested_at, agent_posted_at, mockups_url, mockups_at, handoff_at,
  created_at, updated_at)
SELECT
  linear_id,
  CASE
    WHEN requested_stage IN ('research','design') THEN requested_stage
    WHEN phase IN ('research','design')           THEN phase
    ELSE 'research'
  END,
  COALESCE(system, 'design-ai'),
  CASE WHEN status IN ('active','waiting','done','error') THEN status ELSE 'active' END,
  prompt,
  CASE WHEN agent_posted_at IS NOT NULL THEN detail ELSE NULL END,
  options,
  COALESCE(gate_round, 1),
  response,
  response_option_id,
  response_note,
  responded_at,
  -- Only carried when something is actually queued. `requested_at` alone is
  -- what says "queued" now, so carrying it across on a card with no
  -- requested_stage would queue work nobody asked for.
  CASE WHEN requested_stage IS NOT NULL THEN requested_at ELSE NULL END,
  agent_posted_at,
  mockups_url,
  mockups_at,
  handoff_at,
  created_at,
  updated_at
FROM agent_sessions
WHERE linear_id IS NOT NULL;

-- ── Gate history follows the session, not just the issue ─────────────────
--
-- A gate belongs to (issue_key, stage) — §2 — so its history does too. With
-- one session per card there was no ambiguity and `session_id` alone was
-- enough; with two, a design round archived against the issue would show up
-- in research's history.
--
-- `session_id` already holds the issue key after migration-003, so only the
-- stage is missing. It is filled in from the session each card has, which at
-- this point is exactly one.
ALTER TABLE gate_decisions ADD COLUMN stage TEXT;

UPDATE gate_decisions
   SET stage = (SELECT s.stage FROM sessions s WHERE s.issue_key = gate_decisions.session_id)
 WHERE stage IS NULL
   AND EXISTS (SELECT 1 FROM sessions s WHERE s.issue_key = gate_decisions.session_id);

-- ── Check it landed ──────────────────────────────────────────────────────
--
-- Run this after, and read it rather than assuming:
--
--   SELECT
--     (SELECT COUNT(*) FROM agent_sessions WHERE linear_id IS NOT NULL) AS was,
--     (SELECT COUNT(*) FROM cards)    AS cards,
--     (SELECT COUNT(*) FROM sessions) AS sessions;
--
-- `was` and `cards` must be equal. `sessions` must equal them too after this
-- migration, because the old grain held exactly one session per card.
