-- Onboarding D2, round 2: an intro deck built slide by slide (docs/DECISIONS.md "D2", round 2). One table, written only
-- by the server:
--
-- intro_deck_builds: one row per deck being built in a chat turn (the `intro_deck` tool's outline, then one call per
-- slide, then the finish). `plan`: the checked outline (title, theme, the pictures and their notes, the planned slides
-- with their sections and figures, the seed of the drawn grounds); `state`: the slides made so far (checked slots, the
-- sanitized accents, the review's mechanical fixes, tries per slide, the speaker notes). `status` building → review →
-- done (the artifact made: `artifact_id`) or failed. The step times give the progress block its clock: `started_at` is
-- the turn's start (the click). Pictures of the finished slides sit in <data>/intro-decks/builds/<id>/ and go with the
-- chat (chat/forget.ts → forgetIntroDecks). Only the chat's owner reads it.
--
-- Additive only (reader 1): an older build never reads or writes this table.
CREATE TABLE intro_deck_builds (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  turn_id TEXT,
  message_id TEXT,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  outline_at TEXT,
  slides_at TEXT,
  finished_at TEXT,
  artifact_id TEXT
);
CREATE INDEX intro_deck_builds_chat ON intro_deck_builds (chat_id, started_at);
CREATE INDEX intro_deck_builds_turn ON intro_deck_builds (turn_id);
