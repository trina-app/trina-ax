-- min_compatible_reader: 1
-- Component C: reading MCP connections' saved tool lists (server/src/integrations/connections/store.ts savedTools,
-- mcp.ts listTools).
--   integrations.tools_rev: moves on whenever tools_json changes (the trigger below, so every writer is covered). The
--     server keeps the parsed lists in memory by (id, tools_rev), so a turn reads and parses tools_json (up to
--     4,000,000 characters a connection) only for a connection whose list changed. version does not move when a
--     check saves a new list, and tools_updated_at is a clock reading, so neither tells a changed list for certain.
--   integrations.tools_total_more: 1 when a check stopped reading the server's tools/list before its last page (the
--     1,000-tool or 4,000,000-character ceiling was reached, or 20 pages or 16 MiB were read): the service offers more
--     than tools_total, how many more is not known. Settings and the AI's instructions say "1,000 of more than 1,000".
-- Additive only (reader 1): an older build ignores both columns (it parses every list each turn and says "N of M"
-- with the count it has); the trigger touches only tools_rev.
ALTER TABLE integrations ADD COLUMN tools_rev INTEGER NOT NULL DEFAULT 0;
ALTER TABLE integrations ADD COLUMN tools_total_more INTEGER NOT NULL DEFAULT 0 CHECK (tools_total_more IN (0, 1));
CREATE TRIGGER integrations_tools_rev AFTER UPDATE OF tools_json ON integrations
WHEN OLD.tools_json IS NOT NEW.tools_json
BEGIN UPDATE integrations SET tools_rev = tools_rev + 1 WHERE id = NEW.id; END;
