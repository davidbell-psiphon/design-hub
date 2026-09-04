-- Adds track (app/website) to agent_sessions.
-- `project` already existed for the brand key (see agent-schema.sql comment);
-- the Linear Reader previously wrote "app"/"website" into it by mistake —
-- that's what `track` is for. Going forward `project` holds the brand slug
-- (conduit/ryve/psiphon/forge) and `track` holds app/website.
-- Run with: npx wrangler d1 execute design-hub --file=./track-schema.sql --remote
ALTER TABLE agent_sessions ADD COLUMN track TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_track ON agent_sessions(track);
