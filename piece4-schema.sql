-- Piece 4: brand-bucket view support (trigger/reassign endpoints, card fields)
-- Run with: npx wrangler d1 execute design-hub --file=./piece4-schema.sql --remote

ALTER TABLE agent_sessions ADD COLUMN linear_uuid TEXT;   -- Linear's internal issue id, needed for label mutations
ALTER TABLE agent_sessions ADD COLUMN linear_state TEXT;  -- 'backlog' | 'unstarted' at read time -> Queued vs Backlog bucket
ALTER TABLE agent_sessions ADD COLUMN triggered_at TEXT;  -- set when design-ai:go is applied; null = not yet triggered
ALTER TABLE agent_sessions ADD COLUMN figma_url TEXT;     -- link to the Figma section, separate from the Linear url
ALTER TABLE agent_sessions ADD COLUMN title TEXT;         -- issue title, kept separate from the description in `detail`

CREATE INDEX IF NOT EXISTS idx_agent_triggered ON agent_sessions(triggered_at);

-- Brand colours per the Hub spec — the card itself carries this colour,
-- not a small chip, so these must match exactly.
UPDATE projects SET color = '#7E67A4' WHERE id = 'conduit';
UPDATE projects SET color = '#D54028' WHERE id = 'psiphon';
UPDATE projects SET color = '#206CCC' WHERE id = 'ryve';
UPDATE projects SET color = '#BE5135' WHERE id = 'forge';
