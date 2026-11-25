-- min_compatible_reader: 1
-- Component C: integrations.instructions, the connection's own guide for its tools: an MCP server's `instructions` from
-- its initialize answer (server/src/integrations/connections/mcp.ts instructionsOf, cut and with secrets hidden), or for
-- a listed app on the computer the guide its own command prints (desktop/src/common/local-apps.ts). The AI gets it under
-- "Connected services" like Claude Code's MCP server instructions (docs/decisions/20261125-connector-guide-and-account-choice.md).
-- NULL: never read yet; '': the server gave none.
-- Additive only (reader 1): an older build ignores the column.
ALTER TABLE integrations ADD COLUMN instructions TEXT;
