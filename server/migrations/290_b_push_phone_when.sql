-- min_compatible_reader: 1
-- Component B: phone notifications only when I'm away from Trina (docs/DECISIONS.md "Phone notifications when I'm away";
-- server/src/notifications/away.ts). Additive only: an older build ignores the column and pushes as before.
--   notification_preferences.phone_when: 'away' (default) holds a push to the phone app while one of the person's Trina
--     windows is in use; 'always' sends it at once, as before. The table is from 207.
ALTER TABLE notification_preferences ADD COLUMN phone_when TEXT NOT NULL DEFAULT 'away' CHECK(phone_when IN ('away','always'));
