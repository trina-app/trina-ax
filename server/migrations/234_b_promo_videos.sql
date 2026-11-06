-- Onboarding V: the company's promo video (docs/DECISIONS.md "V — The first result is the company's promo video"). One
-- table, written only by the server:
--
-- promo_videos: one row per artifact version the `promo_video` tool made: the checked slots the composition is built
-- from (`spec`, JSON: style, texts, team paths of the pictures, colours), so the MP4 is made from what the server
-- checked and never from the artifact's HTML (an `artifact update` could change that). `mp4_*`: the last MP4 render of
-- this row (state, how long it took, its size); the file sits in <data>/promo-videos/<artifact id>.mp4. Only the chat's
-- owner reads it.
--
-- Additive only (reader 1): an older build never reads or writes this table.
CREATE TABLE promo_videos (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  spec TEXT NOT NULL,
  mp4_state TEXT NOT NULL DEFAULT 'none' CHECK (mp4_state IN ('none', 'rendering', 'done', 'failed')),
  mp4_ms INTEGER,
  mp4_bytes INTEGER,
  mp4_error TEXT,
  rendered_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX promo_videos_chat ON promo_videos (chat_id);
