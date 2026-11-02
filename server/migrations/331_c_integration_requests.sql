-- min_compatible_reader: 1
-- Component C: an admin asks a member to connect a service as the member's own (personal) connection
-- (server/src/integrations/connections/requests.ts, docs/INTEGRATIONS.md "Asking a member to connect").
--   integration_requests: what the admin filled in for one member (kind, name, address, how it signs in, the key's
--     header, usage notes for an API), never a key. The member adds their own key or signs in through the same path
--     as a connection they add themselves; the admin never sees the key.
--   state: pending | completed | declined | withdrawn. A pending request past expires_at counts as expired (read so;
--     nothing rewrites it). integration_id: the member's connection made from it (with an MCP sign-in it is made
--     before the sign-in finishes, and the request completes when it does). No foreign key on it or on created_by:
--     the record outlives a connection its member deletes, and the admin's account.
-- Additive only (reader 1): an older build does not know the table.
CREATE TABLE integration_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('mcp','http')),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  auth TEXT NOT NULL CHECK(auth IN ('bearer','header','oauth')),
  auth_header TEXT,
  notes TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','completed','declined','withdrawn')),
  integration_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX integration_requests_user ON integration_requests(user_id, state);
CREATE INDEX integration_requests_created ON integration_requests(created_at);
CREATE INDEX integration_requests_integration ON integration_requests(integration_id) WHERE integration_id IS NOT NULL;
