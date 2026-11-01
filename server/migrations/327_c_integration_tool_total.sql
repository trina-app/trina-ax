-- min_compatible_reader: 1
-- Component C: how many tools an MCP connection's server offers (server/src/integrations/connections/mcp.ts listTools).
-- The server keeps at most 100 per connection (tools_json); when it offers more, Settings > External services and the
-- AI's instructions say "100 of 150". NULL: not checked since this column exists, or the saved list is all of them.
-- Additive only.
ALTER TABLE integrations ADD COLUMN tools_total INTEGER;
