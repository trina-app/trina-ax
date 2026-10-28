-- min_compatible_reader: 1
-- External-service connections (docs/INTEGRATIONS.md): MCP servers and HTTP APIs the AI uses with a member's own
-- (personal) or the team's (team) credentials. Keys and tokens are only stored encrypted, with their own key directory.
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('personal','team')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('mcp','http')),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  url TEXT NOT NULL,
  auth TEXT NOT NULL CHECK(auth IN ('none','bearer','header','oauth')),
  auth_header TEXT,
  secret_enc TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  account TEXT,
  notes TEXT,
  write_policy TEXT NOT NULL DEFAULT 'ask' CHECK(write_policy IN ('ask','allow','deny')),
  status TEXT NOT NULL CHECK(status IN ('connected','needs_auth','error')),
  last_error TEXT,
  tools_json TEXT NOT NULL DEFAULT '[]',
  tools_updated_at TEXT,
  last_used_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'personal') = (owner_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX integrations_slug ON integrations(scope, COALESCE(owner_user_id, ''), slug);
CREATE INDEX integrations_owner ON integrations(owner_user_id);
-- who may use a team connection in their chats (admins are not implied)
CREATE TABLE integration_access (
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('everyone','group','user')),
  subject_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (integration_id, subject_type, subject_id)
);
-- signing in at an MCP server: bound to the person and session that started it, state stored hashed, verifier and
-- client details encrypted, 10 minutes
CREATE TABLE integration_oauth_flows (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  integration_version INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','exchanging','completed','failed','expired')),
  secret_enc TEXT,
  key_version INTEGER NOT NULL,
  reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX integration_flows_user ON integration_oauth_flows(user_id, created_at);
