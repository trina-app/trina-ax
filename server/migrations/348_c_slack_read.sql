-- min_compatible_reader: 1
-- Component C: the AI reads Slack as the person (docs/SLACK.md "Reading Slack", docs/DECISIONS.md "Slack: one connect
-- links and allows reading", server/src/integrations/slack/read.ts).
--   slack_user_tokens: the person's own Slack user token (xoxp), from the same "Sign in with Slack" that links the
--     account (OAuth v2 with user scopes). Sealed with the key directory <secrets>/integrations/slack (AAD bound to the
--     person), never in plain text here. `scopes`: what Slack granted. A row whose person is no longer linked (unlinked,
--     account disabled, Slack removed) is revoked at Slack and deleted by the connector.
--   slack_signin_flows.kind: 'link' (link the Slack account the person signs in to, from Settings or the link page) or
--     'read' (an already linked person allows reading, from the button in Slack: the Slack account that allows it must
--     be the linked one). method: 'oidc' (the old OpenID Connect sign-in: no token kept) or 'oauth' (OAuth v2 with
--     user scopes). question: for a 'read' flow started from a question in Slack, that question (JSON: workspace,
--     channel, message ts, thread, text), answered again once reading is allowed.
--   slack_config.read_scopes: whether the Slack app gives the user scopes: 'ok' (a person got them all), 'missing'
--     (Slack refused them, or granted fewer: Admin › Slack shows "Update Slack permissions"), NULL (not known yet).
CREATE TABLE slack_user_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE slack_signin_flows ADD COLUMN kind TEXT NOT NULL DEFAULT 'link' CHECK (kind IN ('link', 'read'));
ALTER TABLE slack_signin_flows ADD COLUMN method TEXT NOT NULL DEFAULT 'oidc' CHECK (method IN ('oidc', 'oauth'));
ALTER TABLE slack_signin_flows ADD COLUMN question TEXT;
ALTER TABLE slack_config ADD COLUMN read_scopes TEXT CHECK (read_scopes IN ('ok', 'missing'));
