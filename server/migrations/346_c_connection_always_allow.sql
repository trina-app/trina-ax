-- min_compatible_reader: 1
-- Component C: "Always allow" on a team connection's write card is the member's own choice (QA TC-130,
-- docs/DECISIONS.md "Connector write cards: outside content asks, Always allow for every connector").
--   integration_user_allow: one row per person and team connection whose changes that person chose to send without
--     the card. The team's own rule (integrations.write_policy, an admin's) is not touched. The row holds the
--     connection's address when it was chosen: it counts only while the address is the same (an admin who moves the
--     connection elsewhere ends it). A person's own connection keeps its choice in its write_policy instead, as Google
--     apps do (341). It never applies in a scheduled run, a room's session, after a room read or after outside
--     content in the chat (integrations/connections/tools.ts gate).
-- Inserting or removing a row moves the safe-operations policy generation, as a change of write_policy does (344).
-- Additive only (reader 1): an older build ignores the table and asks on every card, as before.
CREATE TABLE integration_user_allow (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (integration_id, user_id)
);
CREATE INDEX integration_user_allow_user ON integration_user_allow(user_id);
CREATE TRIGGER safe_ops_integration_user_allow_insert AFTER INSERT ON integration_user_allow
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER safe_ops_integration_user_allow_delete AFTER DELETE ON integration_user_allow
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
