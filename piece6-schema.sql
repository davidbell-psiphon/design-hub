-- Piece 6: one card per Linear issue
-- Run with: npx wrangler d1 execute design-hub --remote --file=./piece6-schema.sql
--
-- The reader keys its rows `linear/RYV-84`; the design-ai agent posts its own
-- `ryve/ryv-84/research`. Both write agent_sessions, neither collided with the
-- other on the primary key, so one Linear issue ended up with two rows — the
-- Linear card and a sibling agent card — and triggering research added a row
-- instead of moving the card that was already there.
--
-- The agent's contract does not change: it keeps posting and polling the id it
-- always used. This column is what remembers that id on the row it now shares
-- with the reader, and the Worker resolves it on every :id route.
ALTER TABLE agent_sessions ADD COLUMN agent_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_alias ON agent_sessions(agent_session_id);

-- ── Merge the duplicates already in the table ────────────────────────────
--
-- A twin is an agent-written row (no linear_id, not keyed `linear/…`) whose
-- session id carries a Linear key as one of its path segments. Wrapping both
-- sides in slashes is what makes that a whole-segment match, so
-- `conduit/wallet-flow/design` cannot match anything and a genuinely Hub-only
-- session is left exactly as it is.
--
-- The agent's state moves onto the Linear row, which keeps the Linear-owned
-- identity — linear_id, linear_uuid, title, url, team, and the dismissed_at
-- and triggered_at history the board buckets by. Where an issue somehow has
-- more than one twin (research and design posted as separate sessions), the
-- most recently updated one wins and the alias points at it.
UPDATE agent_sessions AS r
SET agent_session_id = a.id,
    system       = COALESCE(a.system, r.system),
    phase        = COALESCE(a.phase, r.phase),
    status       = COALESCE(a.status, r.status),
    prompt       = COALESCE(a.prompt, r.prompt),
    detail       = COALESCE(a.detail, r.detail),
    figma_url    = COALESCE(a.figma_url, r.figma_url),
    project      = COALESCE(r.project, a.project),
    track        = COALESCE(r.track, a.track),
    response     = COALESCE(r.response, a.response),
    responded_at = COALESCE(r.responded_at, a.responded_at),
    updated_at   = datetime('now')
FROM agent_sessions AS a
WHERE r.linear_id IS NOT NULL
  AND a.linear_id IS NULL
  AND a.id NOT LIKE 'linear/%'
  AND '/' || lower(a.id) || '/' LIKE '%/' || lower(r.linear_id) || '/%'
  -- Newest twin only, so the join can never be ambiguous.
  AND NOT EXISTS (
    SELECT 1 FROM agent_sessions AS a2
     WHERE a2.linear_id IS NULL
       AND a2.id NOT LIKE 'linear/%'
       AND a2.id <> a.id
       AND '/' || lower(a2.id) || '/' LIKE '%/' || lower(r.linear_id) || '/%'
       AND (a2.updated_at > a.updated_at
            OR (a2.updated_at = a.updated_at AND a2.id > a.id))
  );

-- Now drop every twin, including the older ones whose state was not adopted:
-- their work lives on the Linear row, and leaving them behind would leave the
-- duplicate rows this piece exists to remove.
DELETE FROM agent_sessions
 WHERE linear_id IS NULL
   AND id NOT LIKE 'linear/%'
   AND EXISTS (
     SELECT 1 FROM agent_sessions AS r
      WHERE r.linear_id IS NOT NULL
        AND '/' || lower(agent_sessions.id) || '/'
            LIKE '%/' || lower(r.linear_id) || '/%'
   );

-- Agent rows with no Linear row to merge into keep working as they always did;
-- this just fills in the alias the new lookups read, so a later reader pass
-- finds one by its key instead of inserting a second card beside it.
UPDATE agent_sessions
   SET agent_session_id = COALESCE(agent_session_id, id)
 WHERE linear_id IS NULL
   AND id NOT LIKE 'linear/%';
