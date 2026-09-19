-- piece13 — Figma destinations, and where they are decided.
--
-- Additive only, and safe to fail: re-running this errors on a duplicate
-- column rather than dropping anything. Never run schema.sql.
--
-- WHY THIS MOVED
--
-- Which Figma file a piece of work lands in used to live in the Design AI's
-- `.design-ai/config/routing.json`, a checked-in file with a (team, brand) map.
-- That was fine while the only way to change it was to edit the repo. It is
-- not fine now that it is edited from the board: a browser cannot commit to a
-- git repository, and a setting you can only change by opening an editor on
-- the right machine is a setting that goes stale.
--
-- So the Hub owns it. routing.json stays as the bootstrap — it is what these
-- rows were seeded from below, and it is what the runner falls back to when
-- the Hub cannot be reached — but the Hub is authoritative whenever it has a
-- row for the pair being asked about.
--
-- WHY THIS IS NOT A DESIGN-AI CONCEPT LEAKING INTO THE HUB
--
-- CLAUDE.md says the Hub stays generic: it knows sessions, brands, states and
-- prompts, and does not know what a gate or a QA agent is. A Figma destination
-- is on the right side of that line. It is not a stage, a gate or an agent
-- role — it is "where does this team's work live", which is the same kind of
-- fact as `cards.figma_url`, a column the Hub has had all along. Another agent
-- system plugged into the Hub would want the same answer.

-- ---------------------------------------------------------------------------
-- The defaults: one row per (team, brand).
--
-- Keyed on the pair because that is the question the runner asks — a team can
-- carry several brands (Websites holds four) and a brand can appear under
-- several teams (forge is under both Forge and Websites, and they are
-- different files). Either half alone would answer the wrong question.
CREATE TABLE IF NOT EXISTS figma_paths (
  team        TEXT NOT NULL,          -- the Linear team NAME, as Linear spells it
  brand       TEXT NOT NULL,          -- as derive.mjs derives it: conduit, ryve, psiphon, forge
  file        TEXT,                   -- human name, for reading — never used to resolve
  file_key    TEXT,                   -- the Figma file key, which is what actually resolves
  page        TEXT,                   -- a page name, or a convention: YYYY-MM, release-version
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (team, brand)
);

-- ---------------------------------------------------------------------------
-- The per-card override.
--
-- Separate columns from `figma_url`, deliberately, and worth explaining because
-- piece11 labels that column "your destination override" — which is what it was
-- meant to be and not what it became. In practice `figma_url` is written by the
-- agent through the session post when a design run has drawn something, so it
-- holds where the work ENDED UP.
--
-- These two are where the next run SHOULD GO. Folding them into `figma_url`
-- would mean a completed design silently redirecting the next one, which is the
-- class of bug the cards/sessions split was made to stop.
--
-- Both sit in the half of `cards` that you own, so the reader must never
-- mention them. See "Which half a column is in" in CLAUDE.md.
ALTER TABLE cards ADD COLUMN figma_file_key TEXT;
ALTER TABLE cards ADD COLUMN figma_page TEXT;

-- Reading the override list means finding the few cards that have one, out of
-- everything the board holds.
CREATE INDEX IF NOT EXISTS idx_cards_figma_override
  ON cards (figma_file_key) WHERE figma_file_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Seed, from .design-ai/config/routing.json as it stood on 19 September 2026.
--
-- DO NOTHING rather than UPDATE: if a row is already here, it was set from the
-- board and is newer than this file. A re-run must not quietly undo an edit.
INSERT INTO figma_paths (team, brand, file, file_key, page) VALUES
  ('Conduit App', 'conduit', 'Conduit UI Design',      'ctJps4o4QD6yDObweDA0VA', 'release-version'),
  ('Ryve App',    'ryve',    'Ryve — Designs & Assets', '9bTw6FPyDTr8iboxocKDfp', 'release-version'),
  ('Forge',       'forge',   'Forge App',              'yAeyC9MEWstRdafKqHRwjA', 'YYYY-MM'),
  ('Websites',    'conduit', 'Conduit Website',        'PP2wiQBR6Kqi4DCzguwCRg', 'YYYY-MM'),
  ('Websites',    'psiphon', 'Psiphon Website',        '5SabGxhHh1bFfm0nNYF8jf', 'YYYY-MM'),
  ('Websites',    'forge',   'Forge Website',          'KwMzY41E4JaqCkaX5aFA3o', 'YYYY-MM'),
  ('Websites',    'ryve',    'Ryve Website',           'lpqO3yaMimYACTFbWnsBu6', 'YYYY-MM')
ON CONFLICT(team, brand) DO NOTHING;
