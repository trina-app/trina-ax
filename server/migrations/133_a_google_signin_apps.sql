-- min_compatible_reader: 1
-- Component A: Sign in with Google from the desktop and phone apps (auth/google-login.ts;
-- docs/AGENTS/plan/20261122-0620-google-login-apps.md, docs/decisions/20261122-google-login-apps.md).
--   google_signin_flows.client: who started the flow. 'web' (every row before this migration): binding_hash is the
--     hash of the browser's binding cookie, as in 131. 'desktop' or 'mobile': binding_hash is the SHA-256 of a secret
--     the app's sign-in page keeps (it sends only the hash at the start); the system browser that does the Google step
--     has none of the app's cookies, and it is never signed in.
--   google_signin_codes: the one-time code Google's return makes for an app flow, redeemed by the app with its secret
--     (POST /api/auth/google/redeem). Only the code's SHA-256 is kept, with the Google account's `sub` (the account is
--     looked up again at the redeem, so a Google account disconnected meanwhile signs nobody in), the client kind and
--     the secret's hash. 5 minutes, one use; the sweeper removes spent and late rows. No person's id: nothing to
--     remove with an account (its login_identities row goes, and the code then finds nobody).
-- Additive only (reader 1): an older build never reads the column or the table.
ALTER TABLE google_signin_flows ADD COLUMN client TEXT NOT NULL DEFAULT 'web' CHECK (client IN ('web', 'desktop', 'mobile'));
CREATE TABLE google_signin_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('desktop', 'mobile')),
  secret_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX google_signin_codes_expires ON google_signin_codes(expires_at);
CREATE INDEX google_signin_codes_subject ON google_signin_codes(subject);
