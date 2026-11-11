-- min_compatible_reader: 1
-- Component C: "Allow all websites" for the AI's web reads (server/src/tools/web-allow-all.ts, url-gate.ts rule ①d;
-- docs/DECISIONS.md "Allow all websites covers the AI's web reads"). Works only while the team allows it (team settings
-- browserAllowAll and webAllowAll, both on by default), always for the person whose turn it is (also in rooms and shared
-- chats), only in a turn the person watches.
--   user_web_access: one row per person who ever changed it.
--     allow_all: the person's switch; warning: the version of the risk sentence they accepted
--     (WEB_ALLOW_ALL_WARNING_VERSION in shared; an older one reads as off); epoch: the team's policy epoch when it was
--     turned on (settings 'web.allowAllEpoch': turning the team policy off raises it, so a row written under the old
--     policy never counts, race-free); via: 'settings' or 'card'; turn_id: the answer whose address card turned it on.
-- Additive only (reader 1): an older build does not read the new table.
CREATE TABLE user_web_access (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  allow_all INTEGER NOT NULL DEFAULT 0,
  warning INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL DEFAULT '',
  turn_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
