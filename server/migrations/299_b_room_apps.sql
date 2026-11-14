-- min_compatible_reader: 1
-- Component B: apps that post into a room (docs/DECISIONS.md "Apps posting in rooms", plan
-- docs/AGENTS/plan/20261114-0900-room-apps.md, QA TC-1410/1411/1412). Sentry, GitHub, Google Forms or any other service
-- posts to POST /in/<token>; the server turns each event into a card from that app in the room. Additive only: an older
-- build ignores the tables and the columns (it shows an app's messages as messages of an account that is gone, with
-- their plain text: everyone in the room sees them anyway).
-- Numbered 299: 297 is the highest of component B on dev and 298 is taken by an open branch (b_chat_audience).
--
--   room_apps: an app set up in a room (any kind of room: a team room, the everyone room, a 1:1 or a group chat).
--     token_hash: sha256 of the address token (the lookup). token_enc / secret_enc: the token and the app's secret
--     (one generated for GitHub or Sentry's pasted Client Secret, both optional; NULL: none) encrypted with the
--     credentials vault (credentials/vault.ts, kinds 'room_app_token' / 'room_app_secret', the app id in the AAD) under
--     key_version; credentials/rekey.ts encrypts them again with every other secret. events: JSON {switch: bool};
--     alert_seen: Sentry's "Alert fired" switch was turned on by itself once. quiet: short lines, no unread, no alerts.
--     paused_until: the team-local midnight a cap pause ends (NULL: running); resumed_on: the team-local day of the last
--     "Resume now". first_ok_at / last_ok_at / last_refusal_at / last_refusal: the status line (a refusal is written at
--     most once a minute).
--   room_app_threads: one thread per thing (a Sentry issue, a pull request, an edited form response): key_hash =
--     sha256 of the app's key; state: the root card's status now.
--   room_app_deliveries: deliveries posted (a vendor's retry posts once), written in the posting transaction; 7 days.
--   room_app_days: per app and team-local day: requests received, shown, skipped (a switch off or a repeat), dropped
--     (limits); 30 days.
--   room_app_notices: the "paused" notice to the people who manage the app (notification_inbox has a fixed
--     event_type CHECK list and tables are never rebuilt); source_id "<app id>.<day>": one per app, person and day.
--   room_messages.app_id / app_card / app_quiet: a message an app posted. author_kind stays 'user' (240's CHECK allows
--     only 'user' and 'ai'), author_id NULL; app_card: the card's fields as JSON (with the app's name and kind, so a
--     removed app's messages still render); app_quiet: posted while quiet (no unread, not the rooms list's line, no
--     activity bump, no notice). app_id has no foreign key: removing an app keeps its messages.
CREATE TABLE room_apps (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('sentry','github','google_forms','other')),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_enc TEXT NOT NULL,
  secret_enc TEXT,
  key_version INTEGER NOT NULL,
  events TEXT NOT NULL DEFAULT '{}',
  alert_seen INTEGER NOT NULL DEFAULT 0 CHECK(alert_seen IN (0,1)),
  quiet INTEGER NOT NULL DEFAULT 0 CHECK(quiet IN (0,1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paused_until TEXT,
  resumed_on TEXT,
  first_ok_at TEXT,
  last_ok_at TEXT,
  last_refusal_at TEXT,
  last_refusal TEXT
);
CREATE INDEX room_apps_room ON room_apps(room_id);

CREATE TABLE room_app_threads (
  app_id TEXT NOT NULL REFERENCES room_apps(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  root_id TEXT NOT NULL REFERENCES room_messages(id) ON DELETE CASCADE,
  state TEXT,
  last_at TEXT NOT NULL,
  PRIMARY KEY (app_id, key_hash)
);
CREATE INDEX room_app_threads_last ON room_app_threads(last_at);

CREATE TABLE room_app_deliveries (
  app_id TEXT NOT NULL REFERENCES room_apps(id) ON DELETE CASCADE,
  delivery_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (app_id, delivery_hash)
);
CREATE INDEX room_app_deliveries_at ON room_app_deliveries(at);

CREATE TABLE room_app_days (
  app_id TEXT NOT NULL REFERENCES room_apps(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  shown INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  dropped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day)
);
CREATE INDEX room_app_days_day ON room_app_days(day);

CREATE TABLE room_app_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('room_app.paused')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX room_app_notices_user_page ON room_app_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX room_app_notices_retention ON room_app_notices(created_at);

ALTER TABLE room_messages ADD COLUMN app_id TEXT;
ALTER TABLE room_messages ADD COLUMN app_card TEXT;
ALTER TABLE room_messages ADD COLUMN app_quiet INTEGER NOT NULL DEFAULT 0 CHECK(app_quiet IN (0,1));
CREATE INDEX room_messages_app ON room_messages(app_id, created_at) WHERE app_id IS NOT NULL;
