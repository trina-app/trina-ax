-- Component B: the phone app removes its device from a team it leaves (docs/DECISIONS.md "모바일 앱 출시와 네이티브 푸시").
--   remove_hash: sha256 hex of the device's removal key, returned once at registration (POST /api/push/devices). The app
--   keeps the key, so on a team switch it can remove its device from the old team without that team's session
--   (POST /api/push/devices/:id/remove), also later when the old server was unreachable at the switch. NULL for Web
--   Push rows and for native rows registered before this migration (they cannot be removed this way).
-- Additive only (reader 1): an older build ignores the column.
ALTER TABLE push_subscriptions ADD COLUMN remove_hash TEXT;
