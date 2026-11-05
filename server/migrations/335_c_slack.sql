-- min_compatible_reader: 1
-- Component C: the Slack connector (server/src/integrations/slack/, docs/SLACK.md, docs/DECISIONS.md "Slack 커넥터").
--   slack_config: the one workspace of this team server. Off by default; the owner saves the two tokens and the app's
--     client secret (sealed with the key directory <secrets>/integrations/slack, never in plain text here; the client id
--     is not a secret) and turns it on.
--   slack_links: one Slack account per person and one person per Slack account, keyed by what Slack's own event
--     envelope says (enterprise, workspace, user), never by message text.
--   slack_link_tokens: the one-time links an unlinked Slack user gets (stored hashed; 10 minutes; used once).
--   slack_threads: the chat that continues a Slack thread (or DM thread) for one person.
--   slack_requests: a question asked in Slack whose answer is still to be delivered, or was delivered and may still be
--     posted to the channel once.
--   slack_events: event ids and message ids already handled (Slack sends an event again when it was not acknowledged).
--   slack_signin_flows: "Sign in with Slack" (OpenID Connect) started by a signed-in person to link the Slack account
--     they sign in to: state and nonce stored hashed, bound to that person and that session, 10 minutes, used once.
--   slack_email_changes: when each account's e-mail was last set (triggers below). Who set it is in the audit log for
--     admins (user.create, user.update); a change with no admin entry is the person's own. The e-mail proof of a link
--     is not trusted for 7 days after someone else set it.
CREATE TABLE slack_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  team_id TEXT,
  team_name TEXT,
  team_url TEXT,
  enterprise_id TEXT,
  bot_user_id TEXT,
  bot_name TEXT,
  app_id TEXT,
  client_id TEXT,
  secret_enc TEXT,
  key_version INTEGER,
  link_origin TEXT,
  last_error TEXT,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT
);
CREATE TABLE slack_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  enterprise_id TEXT NOT NULL DEFAULT '',
  slack_user_id TEXT NOT NULL,
  slack_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (enterprise_id, team_id, slack_user_id)
);
CREATE TABLE slack_link_tokens (
  token_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  enterprise_id TEXT NOT NULL DEFAULT '',
  slack_user_id TEXT NOT NULL,
  slack_name TEXT,
  slack_real_name TEXT,
  slack_handle TEXT,
  channel_id TEXT,
  thread_ts TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX slack_link_tokens_user ON slack_link_tokens(team_id, slack_user_id, created_at);
CREATE TABLE slack_threads (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id, thread_ts, user_id)
);
CREATE TABLE slack_requests (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  enterprise_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL,
  channel_kind TEXT NOT NULL CHECK (channel_kind IN ('im', 'channel')),
  thread_ts TEXT NOT NULL,
  in_thread INTEGER NOT NULL DEFAULT 0,
  ext_shared INTEGER NOT NULL DEFAULT 0,
  slack_user_id TEXT NOT NULL,
  progress_ts TEXT,
  asked_notice INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before TEXT,
  state TEXT NOT NULL CHECK (state IN ('waiting', 'delivered', 'failed', 'posted')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  posted_at TEXT
);
CREATE INDEX slack_requests_state ON slack_requests(state, created_at);
CREATE TABLE slack_signin_flows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  nonce_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  reason TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX slack_signin_flows_user ON slack_signin_flows(user_id, created_at);
CREATE TABLE slack_email_changes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  changed_at TEXT NOT NULL
);
-- e-mails an admin set before this migration (a new member, a change): their time, so the 7 days count from it. An
-- e-mail the person changed back themselves before this migration counts as the admin's too, until they set it again.
INSERT OR REPLACE INTO slack_email_changes (user_id, changed_at)
  SELECT a.target, max(a.at) FROM audit_log a JOIN users u ON u.id = a.target
  WHERE u.email IS NOT NULL AND a.actor_id IS NOT NULL AND a.actor_id != a.target
    AND (a.action = 'user.create' OR (a.action = 'user.update' AND json_type(a.detail, '$.email') IS NOT NULL))
  GROUP BY a.target;
CREATE TRIGGER slack_email_set AFTER INSERT ON users WHEN NEW.email IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO slack_email_changes (user_id, changed_at) VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER slack_email_changed AFTER UPDATE OF email ON users WHEN NEW.email IS NOT OLD.email
BEGIN
  INSERT OR REPLACE INTO slack_email_changes (user_id, changed_at) VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TABLE slack_events (
  key TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
CREATE INDEX slack_events_seen ON slack_events(seen_at);
-- a disabled or deleted account is unlinked at once (Slack can no longer ask as it), whoever changed the account
CREATE TRIGGER slack_unlink_inactive AFTER UPDATE OF status, deleted_at ON users
WHEN NEW.status <> 'active' OR NEW.deleted_at IS NOT NULL
BEGIN
  INSERT INTO audit_log (actor_id, action, target, detail, at)
    SELECT NULL, 'slack.unlinked', NEW.id, '{"reason":"account_disabled"}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE EXISTS (SELECT 1 FROM slack_links WHERE user_id = NEW.id);
  DELETE FROM slack_links WHERE user_id = NEW.id;
  DELETE FROM slack_threads WHERE user_id = NEW.id;
  DELETE FROM slack_signin_flows WHERE user_id = NEW.id;
END;
