-- min_compatible_reader: 1
-- Component C: Slack through the hosting service's official app (docs/SLACK.md "The official app",
-- server/src/integrations/slack/broker.ts, contract shared/src/cloud-protocol/slack-broker.ts).
--   slack_config.mode: 'own' (the team's own Slack app, its tokens pasted in Admin › Slack, as before) or 'official'
--     (the hosting service's app, added with "Add to Slack"; only the workspace's bot token is sealed here, in the same
--     key directory, and the envelopes come from the hosting service's long poll). install_id: the hosting service's
--     id of this install.
--   slack_signin_flows.via: 'own' (this server exchanges Slack's code with its own client secret) or 'broker' (the
--     hosting service does, and answers only who signed in; nonce_hash is then '' : the hosting service keeps the
--     nonce); verifier_enc: the flow's PKCE verifier toward the hosting service, sealed.
--   slack_install_flows: "Add to Slack" started by the owner: state stored hashed, the verifier sealed, bound to that
--     person (any of their sessions), 10 minutes, used once. link_origin: the team's address the page was open at
--     (where links in Slack will open).
ALTER TABLE slack_config ADD COLUMN mode TEXT NOT NULL DEFAULT 'own' CHECK (mode IN ('own', 'official'));
ALTER TABLE slack_config ADD COLUMN install_id TEXT;
ALTER TABLE slack_signin_flows ADD COLUMN via TEXT NOT NULL DEFAULT 'own' CHECK (via IN ('own', 'broker'));
ALTER TABLE slack_signin_flows ADD COLUMN verifier_enc TEXT;
ALTER TABLE slack_signin_flows ADD COLUMN verifier_key_version INTEGER;
CREATE TABLE slack_install_flows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  verifier_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  link_origin TEXT,
  client TEXT NOT NULL DEFAULT 'web',
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX slack_install_flows_user ON slack_install_flows(user_id, created_at);
