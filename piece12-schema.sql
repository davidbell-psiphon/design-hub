-- Piece 12: which machine you are actually at.
-- Run with: npx wrangler d1 execute design-hub --remote --file=./piece12-schema.sql
--
-- The Hub cannot see which machine your browser is on. It never reaches out to
-- anything: runners poll it, and a browser cannot read its own hostname. So the
-- machine has to say so itself, and there are exactly two honest ways for that
-- to happen. Both are here.
--
--   automatic  running design-local.bat means you are sitting at that machine.
--              That is what the command is FOR. It claims, and the board
--              follows. No daemon, no localhost port, no browser detection.
--   by hand    the board lists every machine that has checked in and you pick
--              one, for when you have not run anything yet or want to override.
--
-- Why it matters: local runs are scheduled on at least one machine
-- (headless-runner.md registers a Task Scheduler entry), so a laptop you are
-- nowhere near can poll the queue and take Figma or Mobbin work that only
-- works where someone has signed in. Whichever runner asks first wins, and
-- until now nothing could express a preference.
--
-- Two additive columns on a table that already exists. No new tables — the
-- last piece learned that lesson the expensive way.

-- Where this runner is, in the only sense the Hub needs: somewhere you sit, or
-- somewhere you do not. The runner knows (GITHUB_ACTIONS) and says so.
--
-- It is not a capability and not a stage. It is the difference between a
-- machine your selection should apply to and one it must never apply to,
-- because starving GitHub Actions of research is not what anybody wants when
-- they say "run this here".
--
-- NULL means a runner that has not been updated to send it. Those are treated
-- as local, which is the safe reading: a selection applies to them, so an old
-- runner cannot quietly keep taking work you have pointed somewhere else.
ALTER TABLE agent_heartbeats ADD COLUMN kind TEXT;

-- You are working from this machine. At most one row has it.
--
-- On the machine rather than in a settings table, because that is what the
-- fact is about (section 1: one fact, one home). Reading it is
-- "SELECT machine FROM agent_heartbeats WHERE selected_at IS NOT NULL", and
-- there is no second place it could disagree with.
--
-- A timestamp rather than a flag so the board can say when you chose, and so
-- two claims arriving at once resolve to the later one rather than to both.
ALTER TABLE agent_heartbeats ADD COLUMN selected_at TEXT;

CREATE INDEX IF NOT EXISTS idx_heartbeats_selected ON agent_heartbeats(selected_at);
