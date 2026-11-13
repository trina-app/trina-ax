-- min_compatible_reader: 1
-- Component B: phone notifications only when I'm away from Trina (docs/DECISIONS.md "Phone notifications when I'm away";
-- server/src/notifications/away.ts). Additive only: an older build ignores the column and pushes as before.
--   notification_preferences.phone_when: 'away' (default) cancels a push to the phone app when, at the moment it would
--     go, one of the person's Trina windows is in use (the computer showed it; it is not sent later); 'always' sends it
--     as before. The table is from 207.
ALTER TABLE notification_preferences ADD COLUMN phone_when TEXT NOT NULL DEFAULT 'away' CHECK(phone_when IN ('away','always'));
