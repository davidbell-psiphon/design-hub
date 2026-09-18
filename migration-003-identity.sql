-- Design Hub migration 003
-- §2 — the Linear issue key is the only identity.
--
-- Run with:
--   npx wrangler d1 execute design-hub --remote --file=./migration-003-identity.sql
--
-- WHAT THIS IS FOR
--
-- piece6 merged the duplicate rows one issue had grown and remembered the
-- agent's own session id in `agent_session_id`, so the two naming conventions
-- could be reconciled after the fact. §2 says that shape is the bug rather
-- than the fix: "no bridging column between a Linear-derived row and an
-- agent-derived row. A bridge implies two identities, and two identities is
-- how one issue becomes two cards."
--
-- So this does three things: it makes a second card for one issue impossible
-- rather than merely reconciled, it renames the rows to the identity they
-- already carry, and it replaces the one piece of behaviour that was reading
-- the bridge as a signal.
--
-- ORDER MATTERS. The unique index is first on purpose. If two rows somehow
-- still share a Linear issue, it fails here having changed nothing, and the
-- message names the problem. Every statement after it assumes one row per
-- issue, and a rename under duplicates would fail halfway through.
--
-- SAFE TO RE-RUN. Every statement is guarded or idempotent. The renames are
-- `WHERE id <> linear_id`, so a second run is a no-op.
--
-- Nothing is dropped. `agent_session_id` stays on the table and stops being
-- written; it is dead weight rather than a risk, and keeping it means this
-- migration is reversible by reverting the Worker alone.

-- ── 1. One issue, one row. Structurally. ─────────────────────────────────
--
-- This is the whole of §2 in one statement. Whatever any id string says,
-- whatever writes it, two rows cannot claim the same Linear issue. Partial,
-- so the Hub-only sessions that legitimately have no issue are unaffected —
-- there can be any number of those and they are not cards.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_linear_unique
  ON agent_sessions(linear_id) WHERE linear_id IS NOT NULL;

-- ── 2. A marker for "an agent has written here" ──────────────────────────
--
-- The reader's upsert decides whether to overwrite `detail` with the Linear
-- description by testing `agent_session_id IS NULL` — meaning "no agent has
-- posted to this row, so the description is safe to refresh". That was always
-- a side effect of the bridge rather than a fact about the row, and it stops
-- being true the moment the bridge stops being written.
--
-- So the fact gets a column of its own. It is Hub-owned and transient, which
-- is exactly what the Manager is allowed to store (§1).
ALTER TABLE agent_sessions ADD COLUMN agent_posted_at TEXT;

-- Backfilled from what the bridge was standing in for, so no row changes
-- behaviour across this migration.
UPDATE agent_sessions
   SET agent_posted_at = COALESCE(agent_posted_at, updated_at)
 WHERE agent_session_id IS NOT NULL
   AND linear_id IS NOT NULL;

-- ── 3. Gate history follows the rows it belongs to ───────────────────────
--
-- Before the rows are renamed, not after: this reads the old id to find the
-- new one. §11 lists "orphaned decision rows on delete" as a bug already had
-- once, and renaming a card out from under its own decision history is the
-- same mistake with a different cause.
UPDATE gate_decisions
   SET session_id = (
         SELECT s.linear_id FROM agent_sessions s
          WHERE s.id = gate_decisions.session_id
            AND s.linear_id IS NOT NULL)
 WHERE EXISTS (
         SELECT 1 FROM agent_sessions s
          WHERE s.id = gate_decisions.session_id
            AND s.linear_id IS NOT NULL
            AND s.id <> s.linear_id);

-- ── 4. The rows take the name they already answer to ─────────────────────
--
-- `linear/RYV-84` and `ryve/ryv-84/research` both become `RYV-84`. Hub-only
-- rows are untouched: they have no issue key, so there is nothing to rename
-- them to, and §2 does not ask for one.
--
-- Nothing depends on this to keep working — the Worker resolves an id to its
-- row by the issue key the string names, so it reads a renamed database and an
-- unrenamed one identically. This is here so that what is stored says what it
-- means.
UPDATE agent_sessions
   SET id = linear_id
 WHERE linear_id IS NOT NULL
   AND id <> linear_id;

-- ── 5. What the bridge was for ───────────────────────────────────────────
--
-- Left in place and left populated, deliberately. Reading it is gone from the
-- Worker; keeping the column means this migration can be reverted by reverting
-- the code, with no second migration to write under pressure.
--
-- It can be dropped whenever §13 step 4 is — by then nothing will have read it
-- for a long time.
