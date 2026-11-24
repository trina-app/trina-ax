-- min_compatible_reader: 1
-- Component C: integrations.tools_dropped, how many tools the last check of an MCP connection left out because their
-- input schema was too large to keep even with its descriptions shortened (server/src/integrations/connections/mcp.ts
-- shrinkSchema, MAX_SCHEMA_CHARS). Settings says the service's tools were too large to load, instead of "The service
-- listed no tools", when the saved list is empty only because of that (API: toolsTooLarge).
-- Additive only (reader 1): an older build ignores the column.
ALTER TABLE integrations ADD COLUMN tools_dropped INTEGER NOT NULL DEFAULT 0 CHECK (tools_dropped >= 0);
