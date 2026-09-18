-- Piece 10: brand identity gets a home that says what it is.
-- Run with: npx wrangler d1 execute design-hub --file=./piece10-schema.sql --remote
--
-- The board's brand list was read out of `projects` with a
-- `section_id = 'brands'` filter. `projects` is the sidebar hierarchy of the
-- retired chat organiser (§13), so the board's only structural read was
-- pointed at a table that is otherwise dead, found by a magic string that
-- only makes sense if you know the history.
--
-- Same four rows, same three columns the board actually reads, in a table
-- named after what it holds. Additive: `projects` is not touched and not
-- dropped, so this is reversible by reverting the Worker alone.

CREATE TABLE IF NOT EXISTS brands (
  id         TEXT PRIMARY KEY,   -- 'conduit' — matches agent_sessions.project
  name       TEXT NOT NULL,      -- 'Conduit'
  color      TEXT,               -- the card's own colour, not a chip
  sort_order INTEGER DEFAULT 0
);

-- Seeded from wherever the live values currently are, rather than retyped.
-- The colours in piece4-schema.sql were applied to `projects` and this carries
-- exactly what is there, so a colour someone changed by hand since then comes
-- across with the rest.
INSERT OR IGNORE INTO brands (id, name, color, sort_order)
  SELECT id, name, color, sort_order FROM projects WHERE section_id = 'brands';

CREATE INDEX IF NOT EXISTS idx_brands_sort ON brands(sort_order);
