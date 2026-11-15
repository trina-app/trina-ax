-- min_compatible_reader: 1
-- Component B: apps in rooms, what the status line says after Regenerate and after a cap (QA TC-2086, TC-2067).
--   rotated_at: when the Webhook URL was last regenerated (NULL: never). Until a message arrives after it, the app's
--   status says it waits for the service to use the new Webhook URL (a service still sending to the old one gets 404,
--   and "Last message today …" would hide that).
ALTER TABLE room_apps ADD COLUMN rotated_at TEXT;
--   paused_by: why the app paused that day: 'app' (its own daily cap; "Resume now" once a day) or 'team' (all the
--   team's apps together reached the team's cap; nothing to resume until the team's midnight). NULL: not paused that day.
ALTER TABLE room_app_days ADD COLUMN paused_by TEXT;
-- Additive only (reader 1).
