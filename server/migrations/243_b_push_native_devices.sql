-- Component B: the phone app's push (docs/DECISIONS.md "모바일 앱 출시와 네이티브 푸시").
--   A native device is a push_subscriptions row with kind 'native': its secret_enc holds the encrypted APNs/FCM device
--   token (vault kind 'native-push'), endpoint_hash a hash of it, config_key the push gateway address. So every event
--   the push service delivers reaches phones through the same deliveries, session binding (ON DELETE CASCADE),
--   opt-out, cancellation, retry and expiry as Web Push, without a second queue.
-- Additive only (reader 1): an older build ignores the column; it cannot decrypt a native row as Web Push (other
--   vault kind), so such a delivery fails and is retried at most three times, sending nothing.
ALTER TABLE push_subscriptions ADD COLUMN kind TEXT NOT NULL DEFAULT 'web' CHECK(kind IN ('web','native'));
