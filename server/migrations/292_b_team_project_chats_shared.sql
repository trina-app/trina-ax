-- min_compatible_reader: 1
-- Component B: a chat started in a team project is shared with its members by default (docs/DECISIONS.md "Team
-- project chats shared by default", 2026-11-13, product owner). projects.share_chats (migration 265) stays the stored
-- truth: this sets it for every team project (a folder outside users/), so a rollback build shares new chats there
-- too. Chats that exist are not touched: a private chat stays its person's until they share it (POST
-- /api/chats/:id/share). One audit row per project it changes (actor: the system), written before the change.
-- Data only, no schema change: an older build reads the same columns.
-- Numbered 292: 291 (b_card_always_allow) is the highest component B migration on dev.
INSERT INTO audit_log (actor_id, action, target, detail, at)
  SELECT NULL, 'project.share_chats', id, '{"on":true,"reason":"default"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM projects WHERE share_chats = 0 AND folder_path <> 'users' AND substr(folder_path, 1, 6) <> 'users/';
UPDATE projects SET share_chats = 1 WHERE share_chats = 0 AND folder_path <> 'users' AND substr(folder_path, 1, 6) <> 'users/';
