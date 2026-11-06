-- min_compatible_reader: 1
-- Component C: connection templates, where an admin registers a service once for the team and each member connects it
-- with their own key or sign-in (server/src/integrations/connections/templates.ts, docs/INTEGRATIONS.md "Templates").
--   integration_templates: what the admin filled in (kind, name, address, how it signs in, the key's header, usage notes
--     for an API), never a key. Who it is for: integration_template_access (everyone / groups / people, like a team
--     connection's rule).
--   integrations.template_id: a member's own (personal) connection made from a template. It keeps the template's
--     address, sign-in method and header; the member may only change their key, sign-in and write rule. A new address,
--     sign-in method or header on the template, or deleting the template, deletes these connections (and so the keys),
--     and a member the template no longer covers cannot use theirs. One per member and template.
--   No foreign key on template_id: the template code removes the connections itself (revoking OAuth tokens first).
-- Additive only (reader 1): an older build does not know the tables, and reads such a connection as a plain personal one.
CREATE TABLE integration_templates (
  id TEXT PRIMARY KEY,
  created_by TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('mcp','http')),
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  auth TEXT NOT NULL CHECK(auth IN ('bearer','header','oauth')),
  auth_header TEXT,
  notes TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE integration_template_access (
  template_id TEXT NOT NULL REFERENCES integration_templates(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('everyone','group','user')),
  subject_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (template_id, subject_type, subject_id)
);
ALTER TABLE integrations ADD COLUMN template_id TEXT;
CREATE UNIQUE INDEX integrations_template_owner ON integrations(template_id, owner_user_id) WHERE template_id IS NOT NULL;
