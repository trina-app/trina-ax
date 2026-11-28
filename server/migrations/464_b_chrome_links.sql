-- min_compatible_reader: 1
-- Component B: the AI's browser in the person's own Chrome (docs/decisions/20261128-trina-in-chrome.md,
-- server/src/chrome/store.ts). chrome_links: one row per Chrome a person linked; token_hash is the sha256 of the link
-- token the extension keeps (the token itself is never stored). chrome_pair_codes: one-time codes, each bound to the
-- extension's challenge (sha256 of its secret verifier, PKCE); only hashes are kept (wrong guesses count per address).
-- A person links many browser profiles (one per extension install), each with its own name and site rules:
-- chrome_link_sites holds the sites the AI may use in that profile without asking (its Always answers and the sites the
-- person added); only_listed = 1 limits the profile to them.
-- user_browser_target: where a desktop-app turn's browser runs ('app' or 'chrome'; no row: 'app').
-- 464: 463 is the highest b on dev. Additive only (reader 1): an older build ignores the tables.
CREATE TABLE chrome_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  version TEXT,
  only_listed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX chrome_links_user ON chrome_links(user_id, created_at);
CREATE TABLE chrome_link_sites (
  link_id TEXT NOT NULL REFERENCES chrome_links(id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (link_id, site)
);
CREATE TABLE chrome_pair_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX chrome_pair_codes_user ON chrome_pair_codes(user_id);
CREATE TABLE user_browser_target (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK(target IN ('app','chrome')),
  updated_at TEXT NOT NULL
);
