-- min_compatible_reader: 1
-- Component B: "항상 허용" on a connector tool's read card is the person's own choice for good, in every chat
-- (docs/decisions/20261122-connector-always-allow.md; server/src/integrations/connections/tools.ts unsureGate). One row
-- per person, connection and tool that this person answered with "Always allow": from then on that tool's read card
-- (a tool the service marks read-only whose name holds a change word as a noun, read-mark.ts 'unsure') is not raised
-- for them, until they delete the row in Settings › Allowed for Trina or an admin turns the team's "Always allow"
-- switch off (rows are then ignored, not deleted). The row holds the connection's address when it was chosen: it
-- counts only while the address is the same. 441: 440 is the highest on dev, and no open PR adds a migration.
-- Additive only (reader 1): an older build ignores the table and asks as before.
CREATE TABLE connector_tool_allow (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, integration_id, tool)
);
CREATE INDEX connector_tool_allow_integration ON connector_tool_allow(integration_id);
