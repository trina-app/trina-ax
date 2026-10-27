-- min_compatible_reader: 1
-- AI 연결(자격 증명) 풀 (docs/DECISIONS.md "AI 연결"). 비밀값은 secret_enc(AES-256-GCM, 열쇠는 <secrets>/credentials.key)에만,
-- 평문 열은 없다. 추가만: 새 표, NULL 가능한 새 열, 인덱스. turns·proxy_tokens·users·budgets는 001 표다.
CREATE TABLE engine_credentials (
  id TEXT PRIMARY KEY,                                   -- UUIDv7
  kind TEXT NOT NULL CHECK (kind IN ('anthropic-oauth','anthropic-api-key','chatgpt','openai-api-key')),
  label TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE, -- NULL = team connection, else that member's own
  priority INTEGER NOT NULL DEFAULT 100,
  disabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','invalid','needs_reconnect')),
  status_code TEXT,                                      -- last failure (machine): upstream_401, invalid_grant, decrypt_failed, ...
  secret_enc TEXT NOT NULL,                              -- base64(nonce12 | ciphertext | tag16)
  key_version INTEGER NOT NULL DEFAULT 1,
  fingerprint TEXT NOT NULL,                             -- sha256(main secret)[:16]: the same token pasted again
  hint TEXT,                                             -- API keys: last 4 characters; subscriptions / ChatGPT: NULL
  meta TEXT NOT NULL DEFAULT '{}',                       -- not secret: {issuedAt, planType, accountRef, emailMasked, accessExpiresAt, lastRefreshAt}
  expires_at TEXT,                                       -- anthropic-oauth: made + 1 year
  limited_until TEXT,                                    -- long 429 (subscription limit) ends
  spend_limit_usd REAL,                                  -- monthly (server time zone), NULL = none
  spend_limit_tokens INTEGER,
  spend_limit_action TEXT NOT NULL DEFAULT 'block' CHECK (spend_limit_action IN ('warn','block')),
  last_used_at TEXT,
  checked_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX engine_credentials_kind ON engine_credentials(kind, priority);
CREATE INDEX engine_credentials_owner ON engine_credentials(owner_user_id);

-- group / person assignments: a connection with any assignment is used only by the people it names (not team-wide)
CREATE TABLE engine_credential_assignments (
  credential_id TEXT NOT NULL REFERENCES engine_credentials(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('group','user')),
  subject_id TEXT NOT NULL,
  PRIMARY KEY (credential_id, subject_type, subject_id)
);
CREATE INDEX engine_credential_assignments_subject ON engine_credential_assignments(subject_type, subject_id);

-- use per connection and day (server time zone); exact when a turn switches connections
CREATE TABLE credential_usage_daily (
  credential_id TEXT NOT NULL REFERENCES engine_credentials(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                                     -- YYYY-MM-DD
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,               -- cache reads and writes included (same rule as turns)
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_id, day)
);

-- budget / connection limit notices: once per period and level
CREATE TABLE budget_notices (
  budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('near','reached')),
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (budget_id, period_start, level)
);
CREATE TABLE credential_notices (
  credential_id TEXT NOT NULL REFERENCES engine_credentials(id) ON DELETE CASCADE,
  period_start TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('near','reached')),
  PRIMARY KEY (credential_id, period_start, level)
);

ALTER TABLE turns ADD COLUMN credential_id TEXT;          -- no FK: usage history stays when the connection is removed
CREATE INDEX turns_credential_started ON turns(credential_id, started_at);
ALTER TABLE proxy_tokens ADD COLUMN credential_id TEXT;   -- the connection this token (one attempt of a turn) is bound to
ALTER TABLE proxy_tokens ADD COLUMN family TEXT;          -- 'anthropic' | 'openai' | NULL (login tokens and the like)
