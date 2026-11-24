-- min_compatible_reader: 1
-- Component A: Sign in with Google (auth/google-login.ts; docs/AGENTS/plan/20261122-0454-google-login.md).
-- login_identities: a Google account a person connected in Settings › Security (with their current password). An
-- account is found by (provider, subject) only, Google's `sub`, never by e-mail: e-mails here are free text, not unique
-- and the person can edit their own (docs/decisions/20261122-google-login-identity.md). `email` and `hd` are as of the
-- last sign-in, shown, never used to match. One Google account per person, and per team.
-- google_signin_flows: a Google sign-in, connect or re-check on its way (10 minutes; a confirmed re-check 5 minutes
-- from its confirmation). Only the state's and the browser binding's
-- SHA-256 are kept; the PKCE verifier and the nonce are sealed (the Drive store's vault, context 'google-login').
-- A connected Google account is a sign-in credential like users.password_hash: adding or removing one advances the
-- safe operations policy generation (319_c_policy_epoch.sql does it for the password). The triggers name
-- safe_ops_policy, which 315 creates: SQLite resolves a trigger's tables when it fires, and every migration has run
-- before anything writes here. Additive only (reader 1): an older build never reads these tables.
CREATE TABLE login_identities (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google')),
  subject TEXT NOT NULL,
  email TEXT,
  hd TEXT,
  linked_at TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (user_id, provider),
  UNIQUE (provider, subject)
);
CREATE TRIGGER login_identities_policy_insert AFTER INSERT ON login_identities
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER login_identities_policy_delete AFTER DELETE ON login_identities
BEGIN UPDATE safe_ops_policy SET generation=generation+1 WHERE id=1; END;
CREATE TABLE google_signin_flows (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  binding_hash TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('signin', 'connect', 'setup', 'join', 'reauth')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  config_key TEXT NOT NULL,
  next TEXT,
  secret_enc TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  -- 'confirmed': a reauth flow Google answered for the person's connected account (auth/reauth.ts); the request that
  -- needed the check spends it once (then 'used'), within 5 minutes of confirmed_at, for the Google account in subject
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'confirmed')),
  confirmed_at TEXT,
  subject TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  -- signin, setup (the first owner, with the setup token) and join (an invite or team link) have nobody signed in yet;
  -- connect and reauth belong to the session that started them
  CHECK ((intent IN ('signin', 'setup', 'join') AND user_id IS NULL AND session_id IS NULL) OR (intent IN ('connect', 'reauth') AND user_id IS NOT NULL AND session_id IS NOT NULL))
);
CREATE INDEX google_signin_flows_expires ON google_signin_flows(expires_at);
CREATE INDEX google_signin_flows_user ON google_signin_flows(user_id);
