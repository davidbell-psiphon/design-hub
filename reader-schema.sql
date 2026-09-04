-- Additions to agent_sessions for the Linear Reader
ALTER TABLE agent_sessions ADD COLUMN linear_id TEXT;
ALTER TABLE agent_sessions ADD COLUMN team TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_linear ON agent_sessions(linear_id);
