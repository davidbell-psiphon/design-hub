-- Run this BEFORE migration-001-gates.sql
--
-- Lists the current columns on agent_sessions. If you see any of:
--   options, response_option_id, response_note, gate_round,
--   mockups_url, mockups_at, handoff_at
-- then part of the migration has already been applied — delete those
-- ALTER lines from migration-001 before running it, or SQLite will error
-- and stop partway through.

SELECT name, type FROM pragma_table_info('agent_sessions');
