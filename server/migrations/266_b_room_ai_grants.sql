-- min_compatible_reader: 1
-- Component B: "이 방에서는 항상 허용" on a room's change card (server/src/rooms/ai-grants.ts, docs/DECISIONS.md "대화방에서
-- 새 파일은 미리 허용"). The person who asked lets @트리나 make new team files in one folder (and its subfolders) when
-- they call it in one room, without the card, for 30 days. Every condition is checked again when it is used (the room,
-- its members, the folder's readers and writers, the person's access, the team's switch); a lapsed grant is deleted
-- then, and leaving the room deletes the person's grants there. Edits of files that existed before the answer, moves,
-- copies, renames, downloads and anything else still ask every time.
--   folder: the folder as the file layer resolved it (its actual names on disk, '/'-joined); never '' or a top folder
--   audience: sha256 of who may read and who may write the folder when it was granted (every active person's access)
--   turn_id: the answer whose card it was (audit)
-- Additive only. An older build ignores the table (its rooms ask every time, as before).
-- Numbered 266: 265 (shared project chats) is the highest on dev.
CREATE TABLE room_ai_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'new_files' CHECK (scope IN ('new_files')),
  audience TEXT NOT NULL,
  turn_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (user_id, room_id, folder, scope)
);
CREATE INDEX room_ai_grants_room ON room_ai_grants(room_id, user_id);
