-- min_compatible_reader: 1
-- Component B: the welcome card for invited people (docs/DECISIONS.md "A welcome for invited people").
--   member_welcome: one row per person who joined with a team link, a single-use invite or an admin's "Add directly"
--     (never the team's creator, never people who joined before this release). invited_by: the link's or invite's
--     maker (NULL for "Add directly" and when that account is gone); via: how they joined; hidden_at: the card's Hide;
--     asked_at: they asked Trina what they can do here; done_at: every row was done (the card says "You're all set"
--     once, then is gone); apps_seen_at: they opened Connected apps (connection template notices wait for it, or for 14
--     days after joined_at); added_by: for "Add directly", the admin who added them (not told about their own action);
--     announced_at: for "Add directly", when the everyone room's joined line and the owners' notice went out, at the
--     person's first sign-in (NULL: not signed in yet, nothing said).
-- Additive only (reader 1): an older build ignores the table (no card, template notices as before).
CREATE TABLE member_welcome (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  via TEXT NOT NULL CHECK(via IN ('team_link','invite','admin')),
  joined_at TEXT NOT NULL,
  hidden_at TEXT,
  asked_at TEXT,
  done_at TEXT,
  apps_seen_at TEXT,
  added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  announced_at TEXT
);
