-- min_compatible_reader: 1
-- Component C: the Slack channel relay (plan docs/AGENTS/plan/20261127-0329-slack-channel-relay.md, decision
-- docs/decisions/20261127-slack-channel-relay.md, server/src/integrations/slack/relay.ts). One Slack channel and one
-- team conversation or project, both ways. The link is a room app (room_apps: kind 'other', preset 'slack', so an older
-- build reads it as an Other app and refuses it at /in/ like any preset it does not know), and its messages are that
-- app's messages (room_messages.app_id).
--   slack_relay_links: one per conversation (room_id unique) and one per Slack channel (channel_id unique).
--     state: 'active' (relaying), 'bot_removed' (the app left the channel: nothing comes in, nothing goes out),
--     'archived' (the channel was archived or deleted in Slack: the link has ended). Disconnect deletes the row and
--     its app; the relayed messages stay in the conversation (owner decision 4).
--     last_ts: the newest Slack ts relayed in (the catch-up reads from there after a gap); gap_noted_at: when the
--     "Some Slack messages may be missing" line was last written.
--   slack_relay_messages: each relayed message both ways, by its Slack (channel, ts): a repeat or a retry is posted
--     once, our own post's echo is dropped, threads find their root, edits and deletes find their message.
--     direction 'in' (Slack → Trina) or 'out' (Trina → Slack).
--   slack_relay_outbox: a Trina message of a linked conversation that has no Slack ts (yet): 'pending' (in the send
--     queue), 'failed' (Slack refused it: "Not sent to Slack" with Retry), 'not_relayed' (by rule: an AI answer, an
--     attachment only; "Not sent to Slack").
-- Additive only (reader 1).
CREATE TABLE slack_relay_links (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL UNIQUE REFERENCES room_apps(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  channel_name TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0,1)),
  ext_shared INTEGER NOT NULL DEFAULT 0 CHECK(ext_shared IN (0,1)),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','bot_removed','archived')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_ts TEXT,
  checked_at TEXT,
  gap_noted_at TEXT
);
CREATE TABLE slack_relay_messages (
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  room_message_id TEXT NOT NULL,
  thread_ts TEXT,
  direction TEXT NOT NULL CHECK(direction IN ('in','out')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, ts)
);
CREATE UNIQUE INDEX slack_relay_messages_message ON slack_relay_messages(room_message_id);
-- a Trina message whose post Slack refused (or that waits in the queue) has no Slack ts yet: one row per message
CREATE TABLE slack_relay_outbox (
  room_message_id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES slack_relay_links(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','failed','not_relayed')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
