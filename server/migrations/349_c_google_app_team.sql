-- min_compatible_reader: 1
-- Component C: Gmail, Google Calendar, Google Docs and Google Sheets connected once for the team by an owner or admin
-- (QA TC-198, docs/DECISIONS.md "A shared Google account for the team", docs/GOOGLE-APPS.md "Shared with the team").
--   The shared connection is an ordinary team row of integrations (scope 'team', owner_user_id NULL, google_app set):
--     who may use it is its integration_access rule, as for every team connection. At most one per app: the index
--     below. A person's own connection to the app (scope 'personal', 341) is a different row and is never touched.
--   google_app_flows.scope: 'team' for a sign-in an owner or admin started for the shared connection. Only the team
--     completion accepts such a flow, and only the person's own completion a 'personal' one (every flow before this).
-- Additive only (reader 1): an older build ignores the column and the index; it offers a google_app row only to its
-- owner (scope 'personal'), so a shared one is used by nobody there, and its generic connection APIs hide it.
ALTER TABLE google_app_flows ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal' CHECK(scope IN ('personal','team'));
CREATE UNIQUE INDEX integrations_google_app_team ON integrations(google_app) WHERE google_app IS NOT NULL AND scope = 'team';
