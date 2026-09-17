-- Piece 8: two filters the board could not offer, and a third drawer.
-- Run with: npx wrangler d1 execute design-hub --file=./piece8-schema.sql --remote
--
-- Both columns exist because the reader stopped filtering by team (8f44ef8).
-- Every issue assigned to Dave now reaches the board, which is what was asked
-- for — and it means 57 open cards where there were a dozen, most of them
-- Marketing work the Design AI has no way to place. A board that shows
-- everything needs a way to narrow it, and a way to put a card aside.

-- "This is design work, but not for the agents."
--
-- Deliberately NOT the same thing as `dismissed_at`, whatever the names
-- suggest. `dismissed_at` is the `no-design` label: a statement about the
-- issue, written into Linear, meaning it is not design work at all.
-- `set_aside_at` is a statement about this Hub's agents — the research and
-- design agents should not run on this card — and it is nobody else's
-- business, so it is never written to Linear and no label carries it.
--
-- The consequence of staying Hub-only: it does not survive losing this
-- database, where a `no-design` dismissal rebuilds itself from a single read.
-- That is the trade for keeping control labels out of Dave's Linear workflow,
-- which is the thing piece 7 existed to undo.
ALTER TABLE agent_sessions ADD COLUMN set_aside_at TEXT;

-- The Linear project's name — "Forge Self-Serve", "BCC" — refreshed on every
-- reader pass, like every other Linear-owned field.
--
-- Note what this is NOT: the column called `project` holds the *brand* id
-- (`conduit`, `ryve`), because brands are rows in the `projects` table and
-- predate the reader by a layer. That collision is why this one carries the
-- `linear_` prefix rather than the obvious name.
--
-- The sidebar groups by team and falls back to this where a row has no team,
-- so a session with no Linear issue behind it can still be found. It is also
-- what a card shows when its brand grouping is not self-evident.
ALTER TABLE agent_sessions ADD COLUMN linear_project TEXT;

-- The queue read filters on this now, alongside dismissed_at.
CREATE INDEX IF NOT EXISTS idx_agent_set_aside ON agent_sessions(set_aside_at);

-- The sidebar counts per team on every render.
CREATE INDEX IF NOT EXISTS idx_agent_team ON agent_sessions(team);
