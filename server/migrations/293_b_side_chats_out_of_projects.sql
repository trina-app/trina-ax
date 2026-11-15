-- min_compatible_reader: 1
-- Component B: a room's side chat (✦ beside a room) holds what the room said, so it is never in a project and never
-- shared (docs/DECISIONS.md "Team project chats shared by default", QA TC-1010). Older builds let one be moved into a
-- project (PATCH /api/chats/:id) and then shared with its members, who could read the room's words without being in
-- the room. This takes every such chat back: out of its project and no longer shared, so it is its creator's alone
-- again, beside its room. One audit row per chat it changes (actor: the system; no names, no content), written first.
-- Data only, no schema change: an older build reads the same columns (and shows the chat as its creator's).
-- Numbered 293: 292 (b_team_project_chats_shared) is on this branch; 291 is the highest component B number on dev.
INSERT INTO audit_log (actor_id, action, target, detail, at)
  SELECT NULL, 'chat.side_chat_unshared', id,
    json_object('wasShared', CASE WHEN shared_at IS NOT NULL THEN json('true') ELSE json('false') END,
                'hadProject', CASE WHEN project_id IS NOT NULL THEN json('true') ELSE json('false') END),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM chats WHERE side_room_id IS NOT NULL AND (shared_at IS NOT NULL OR project_id IS NOT NULL);
UPDATE chats SET shared_at = NULL, project_id = NULL WHERE side_room_id IS NOT NULL AND (shared_at IS NOT NULL OR project_id IS NOT NULL);
