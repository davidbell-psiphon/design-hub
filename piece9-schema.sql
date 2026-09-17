-- Piece 9: where Linear issues are read from, as data rather than as code.
-- Run with: npx wrangler d1 execute design-hub --remote --file=./piece9-schema.sql
-- (or one statement at a time with --command — see DEPLOY.md.)
--
-- The reader has had a team filter, then no team filter, and each time it was
-- a constant in worker/index.js that only a deploy could change. Dropping it
-- put 57 cards on the board, 33 of them Marketing work the Design AI cannot
-- place; putting it back would mean guessing today which teams matter next
-- quarter. Neither is a decision that belongs in a deploy.
--
-- So it is a table, and the board edits it.

CREATE TABLE IF NOT EXISTS reader_teams (
  -- The Linear team's name, exactly as Linear spells it. The name and not an
  -- id, because it is what the discovery query filters on and what the board
  -- shows you; a renamed team should stop matching loudly rather than keep
  -- matching against an id nobody can read.
  name     TEXT PRIMARY KEY,
  added_at TEXT DEFAULT (datetime('now'))
);

-- Empty means every team, which is exactly what the reader does today. So
-- applying this piece changes nothing on its own: the board is what turns the
-- filter on, one team at a time, and clearing the list turns it off again.
