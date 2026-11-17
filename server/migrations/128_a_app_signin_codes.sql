-- min_compatible_reader: 1
-- Component A: one-time codes that sign the desktop app in as the person who pressed "Continue in the Mac app" in
-- their browser (auth/app-signin.ts; docs/decisions/20261116-desktop-first-onboarding.md). Only the SHA-256 of the code
-- is kept. A code lives 3 minutes, is spent once (used_at), and a person has one live code at a time. It belongs to the
-- browser sign-in that made it (session_id): that sign-in ending (signed out, signed out from another device, expired)
-- takes the code with it. Additive only (reader 1): an older build never reads the table.
CREATE TABLE app_signin_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX app_signin_codes_user ON app_signin_codes(user_id);
CREATE INDEX app_signin_codes_session ON app_signin_codes(session_id);
CREATE INDEX app_signin_codes_expires ON app_signin_codes(expires_at);
