-- Piece 7: the Hub owns triggering.
-- Run with: npx wrangler d1 execute design-hub --file=./piece7-schema.sql --remote
--
-- Before this, pressing Trigger wrote a `design-ai:go` label onto the Linear
-- issue and the runner polled Linear looking for it — Linear was the message
-- bus between the button and the agent. Now the button writes here, and the
-- runner asks the Hub what has been requested.

-- The queue. Null means nothing is requested for this card.
-- 'research' | 'design' | 'qa'.
ALTER TABLE agent_sessions ADD COLUMN requested_stage TEXT;
ALTER TABLE agent_sessions ADD COLUMN requested_at TEXT;

-- The issue's Linear labels, as a JSON array of names, refreshed on every
-- reader pass. This is what the board reads to decide a card's column, so the
-- stage a card is in lives in Linear and cannot drift out of sync with it:
--   AI-research done -> Researched
--   AI-design done   -> AI-designed
--   AI-QA done       -> QA'd
-- `no-research` and `no-design` are Dave's own labels and are read from here
-- too. /api/agent/stage-done appends to this column as well as applying the
-- label in Linear, so a finished stage moves its card immediately rather than
-- waiting for the Wednesday read.
ALTER TABLE agent_sessions ADD COLUMN labels TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_requested ON agent_sessions(requested_stage);
