-- min_compatible_reader: 1
-- Component C: Settings › Notifications "File sharing" (default on; docs/decisions/20261116-file-share-push-gaps.md,
-- server/src/files/share-push.ts). Off: no phone or browser push for a file shared with the person by name, nor for
-- someone asking to open a file the person answers for; the Activity rows stay. One switch for both.
-- Additive only (reader 1): an older build ignores the column.
ALTER TABLE notification_preferences ADD COLUMN file_shares INTEGER NOT NULL DEFAULT 1;
