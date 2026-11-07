-- min_compatible_reader: 1
-- Component B: the iPhone app shows who and where in a room push (docs/DECISIONS.md "아이폰 알림의 이름").
--   push_subscriptions.label_hash: sha256 hex of the device's label key. The iPhone app (push-label-v1) makes the key and
--   keeps it in the keychain for its notification service extension; the page sends only the hash with the registration
--   (POST /api/push/devices labelHash). The extension sends the key with a notice id to POST /api/push/devices/:id/label
--   and gets the notice's title (who and where, never the text). Separate from remove_hash: a label key cannot remove
--   the device. NULL = no labels (Web Push rows, Android, older apps, devices registered before this migration until
--   they register again).
-- Additive only: an older build ignores the column.
ALTER TABLE push_subscriptions ADD COLUMN label_hash TEXT;
