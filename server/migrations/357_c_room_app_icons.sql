-- min_compatible_reader: 1
-- Component C (numbered in C's range as asked; 356 is taken by file_share_batches, PR #1038): an Other app's own icon in conversations
-- (QA TC-3544 / TC-3545, docs/decisions/20261116-other-app-icon.md, server/src/rooms/apps/icon.ts).
--   room_app_icons: at most one row per app. Either an image (`image` and `image_type`: a square PNG, JPEG or WebP of
--     64-512 px, at most 256 KiB, its metadata cut out, as a profile photo) or one emoji (`emoji`), never both. `version`
--     only grows (a millisecond clock, as user_profiles.avatar_version), so an address with ?v= never shows another
--     picture and can be cached for good. No row: the app shows its name's first letter. Removing the app (or its room)
--     removes the row (ON DELETE CASCADE). No user column: who changed it is in the audit log.
-- Additive only (reader 1): an older build ignores the table and shows the plain tile it showed before.
CREATE TABLE room_app_icons (
  app_id TEXT PRIMARY KEY REFERENCES room_apps(id) ON DELETE CASCADE,
  image BLOB,
  image_type TEXT,
  emoji TEXT,
  version INTEGER NOT NULL,
  CHECK ((image IS NOT NULL AND image_type IS NOT NULL AND emoji IS NULL) OR (image IS NULL AND image_type IS NULL AND emoji IS NOT NULL))
);
