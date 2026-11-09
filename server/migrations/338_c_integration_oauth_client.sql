-- min_compatible_reader: 1
-- Component C: sign-in through your own app at the service (docs/INTEGRATIONS.md "Your own app"), for services that do
-- not let apps register themselves (Google's MCP servers, NAVER WORKS ...).
--   oauth_client: what is not secret about the app, as JSON {clientId, authorizationUrl, tokenUrl, scope}; NULL: the
--     service registers the app itself (dynamic client registration), as before.
--   oauth_client_enc / oauth_client_key_version: the app's client secret, sealed like keys in the connections key
--     directory with its own AAD ("<connection AAD>:client", "template:<id>:client"); NULL: none (a public app).
-- On integrations: a personal or team connection's own app (a member's connection made from a template has none: it
-- signs in through the template's). On integration_templates: the team's app each member signs in through.
-- The server changes these columns only together with `version`, which the safe-operations policy triggers already
-- watch (336_c_integration_template_policy.sql), so the triggers stay as they are.
-- Additive only (reader 1): an older build does not read the columns; it would try to register an app at sign-in.
ALTER TABLE integrations ADD COLUMN oauth_client TEXT;
ALTER TABLE integrations ADD COLUMN oauth_client_enc TEXT;
ALTER TABLE integrations ADD COLUMN oauth_client_key_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE integration_templates ADD COLUMN oauth_client TEXT;
ALTER TABLE integration_templates ADD COLUMN oauth_client_enc TEXT;
ALTER TABLE integration_templates ADD COLUMN oauth_client_key_version INTEGER NOT NULL DEFAULT 1;
