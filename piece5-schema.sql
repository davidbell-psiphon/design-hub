-- Piece 5: no-design dismissal + completed issues
-- Run with: npx wrangler d1 execute design-hub --file=./piece5-schema.sql --remote

-- Set when the `no-design` label is applied — from the Hub, or seen on the
-- issue by the reader. Null means the card belongs on the main board.
--
-- The reader upserts this with COALESCE(agent_sessions.dismissed_at, excluded...),
-- so a cron run can only ever ADD a dismissal, never clear one. That is what
-- stops a dismissed card being resurrected onto the board by the next read if
-- a label mutation has not propagated yet. The consequence, accepted
-- deliberately: removing the label in Linear does not un-dismiss the card —
-- the Hub's Undo control is the only way back, and it removes the label first.
ALTER TABLE agent_sessions ADD COLUMN dismissed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_dismissed ON agent_sessions(dismissed_at);

-- linear_state now also carries 'completed' and 'canceled', written by the
-- reconciliation pass. No schema change needed — the column is TEXT — but the
-- board reads those two values to build the Completed section.
