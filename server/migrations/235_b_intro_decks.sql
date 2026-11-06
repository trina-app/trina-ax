-- Onboarding D2: the company's intro deck (docs/DECISIONS.md "D2 — The first result is the company's intro deck"). One
-- table, written only by the server:
--
-- intro_decks: one row per artifact version the `intro_deck` tool made: the checked document the slides are laid out
-- from (`spec`, JSON: the theme, the slots, the team paths and sizes of the pictures, the notes), so the PowerPoint file
-- and the PDF are built from what the server checked and never from the artifact's HTML (an `artifact update` could
-- change that). `pptx_sha256` / `pdf_sha256`: the files given out for this row (they sit in
-- <data>/intro-decks/<artifact id>.pptx|.pdf), so a deck put back into the team folder is never read as a source of
-- the next one. Only the chat's owner reads it.
--
-- Additive only (reader 1): an older build never reads or writes this table.
CREATE TABLE intro_decks (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  spec TEXT NOT NULL,
  pptx_sha256 TEXT,
  pdf_sha256 TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX intro_decks_chat ON intro_decks (chat_id);
CREATE INDEX intro_decks_pptx ON intro_decks (pptx_sha256);
CREATE INDEX intro_decks_pdf ON intro_decks (pdf_sha256);
