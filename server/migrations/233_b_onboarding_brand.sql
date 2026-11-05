-- Onboarding N: the company card news as the first result (docs/DECISIONS.md "N — The first result is the company's
-- card news"). Three tables, all written only by the server:
--
-- onboarding_brand_assets: what a company profile draft collected from the pages the server opened for it (the page's
-- text, cut; the logo and pictures the page itself shows, kept aside in <data>/onboarding-assets/<chat>/ until the first
-- result places them into the team's brand folder; the brand colours found with a weight). `placed_path`: where the
-- picture went in the team folder. Only the person whose draft chat it is sees anything of it (its counts and colours).
--
-- onboarding_result_chats: the chats the welcome steps' first result started (one per start). Only in a chat listed
-- here is the brand photo tool offered (onboarding/brand-image.ts), and only while the team's photos are not used up.
--
-- onboarding_images: the brand photos made with the hosting service's image key, per team (the cap counts the rows that
-- are not 'failed'; a row is written before the request goes out, so two calls at once cannot both take the last one).
-- 'failed' only when the service refused the request or said the job failed (not charged); a job it took that never
-- became a saved file (stopped, timed out, the download or the save failed) is 'lost' and still counts.
-- No prompt text is kept beyond a short cut for the operator's view of what was made.
-- Additive only (reader 1): an older build never reads or writes these tables.
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
CREATE TABLE onboarding_result_chats (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_path TEXT NOT NULL,
  images_folder TEXT NOT NULL,
  intro_path TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE onboarding_images (
  id TEXT PRIMARY KEY,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'lost')),
  model TEXT NOT NULL,
  credits REAL,
  path TEXT,
  prompt TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
