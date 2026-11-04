-- Onboarding: the pages a company profile draft opened or refused (docs/DECISIONS.md "R — What the AI reads for the
-- company profile, line by line"). One row per address an answer of a draft chat asked web_fetch for, written by the
-- server where it checks and opens the page (server/src/onboarding/draft.ts DraftPages), so the profile screen shows
-- what really happened, not what the AI meant to do. Addresses, the page's title and the outcome only: no page text.
-- Only the person whose draft chat it is reads them (GET /api/onboarding/profile/draft/:chatId).
-- Additive only (reader 1): an older build never writes or reads the table.
CREATE TABLE onboarding_draft_pages (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  url TEXT NOT NULL,
  final_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'refused', 'failed')),
  reason TEXT CHECK (reason IN ('off_site', 'limit', 'not_linked', 'unreachable', 'empty')),
  title TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (message_id, seq)
);
