-- Design Hub — agent session integration
-- Run with: npx wrangler d1 execute design-hub --file=./agent-schema.sql --remote

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,              -- e.g. "conduit/wallet-flow/design"
  system TEXT NOT NULL,             -- "design-ai", "social-ai", etc. Keeps the Hub generic.
  project TEXT,                     -- brand or project key, e.g. "conduit"
  phase TEXT,                       -- "research" | "design" | "qa" | free text
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','waiting','done','error')),
  prompt TEXT,                      -- the question shown to the human when waiting
  detail TEXT,                      -- longer context for the decision
  url TEXT,                         -- link out to Figma / Linear / wherever
  response TEXT,                    -- the human's answer, null until answered
  responded_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_status  ON agent_sessions(status);
CREATE INDEX IF NOT EXISTS idx_agent_system  ON agent_sessions(system);
CREATE INDEX IF NOT EXISTS idx_agent_project ON agent_sessions(project);
