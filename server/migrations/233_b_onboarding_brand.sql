-- Onboarding N: the company card news as the first result (docs/DECISIONS.md "N — The first result is the company's
-- card news"). One table, written only by the server:
--
-- onboarding_brand_assets: what a company profile draft collected from the pages the server opened for it (the page's
-- text, cut; the logo and pictures the page itself shows, kept aside in <data>/onboarding-assets/<chat>/ until the first
-- result places them into the team's brand folder; the brand colours found with a weight). `placed_path`: where the
-- picture went in the team folder. Only the person whose draft chat it is sees anything of it (its counts and colours).
--
-- Additive only (reader 1): an older build never reads or writes this table.
CREATE TABLE onboarding_brand_assets (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'image', 'page', 'color')),
  url TEXT NOT NULL,
  page_url TEXT,
  title TEXT,
  file TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  sha256 TEXT,
  text TEXT,
  weight REAL NOT NULL DEFAULT 0,
  placed_path TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, seq)
);
