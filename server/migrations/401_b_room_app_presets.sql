-- min_compatible_reader: 1
-- Component B: apps in rooms, part 2 phase 1 (docs/DECISIONS.md "Apps in rooms: presets and JANDI", plan
-- docs/AGENTS/plan/20261114-1522-room-apps-presets-email.md, QA TC-1634).
--   preset: a named service set up through "Other" (notion, typeform, tally, jotform, stripe, shopify, zendesk;
--   shared/src/api/room-apps.ts RoomAppPreset). room_apps.kind CHECK is fixed and tables are never rebuilt, so kind
--   stays 'other' for every preset: an older build (and an older phone app parsing RoomAppKind strictly) still reads the
--   row and its messages as an Other app. The preset names which reader, switches, signature scheme and logo the newer
--   build uses; it is fixed when the app is added. No CHECK: the list grows in code. A row whose preset a build does not
--   know is refused at /in/ (401 with a secret, 400 without), never read as plain Other.
-- Additive only (reader 1). Rolling back past this build: see DECISIONS ("Rollback").
ALTER TABLE room_apps ADD COLUMN preset TEXT;
--   preset_pin: the service account the app first posted from (a Zendesk subdomain, a Shopify store handle), pinned
--   on first sight; a later body naming another gets no link (its card can't point at another tenant). NULL: none yet.
ALTER TABLE room_apps ADD COLUMN preset_pin TEXT;
--   events_seen: the app's switch keys an event has arrived for at least once (JSON array of keys, never any content):
--   the settings say "Not set up in <service>" under a switch whose event never came.
ALTER TABLE room_apps ADD COLUMN events_seen TEXT NOT NULL DEFAULT '[]';
