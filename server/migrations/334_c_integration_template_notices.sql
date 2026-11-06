-- min_compatible_reader: 1
-- Component C: what connection templates tell people, and scheduled runs that need a member's own key
-- (server/src/integrations/connections/templates.ts, server/src/notifications/service.ts, server/src/chat/schedules.ts,
-- docs/INTEGRATIONS.md "Templates").
--   integration_template_notices: inbox rows. 'integration.template': a template is there for the person to connect
--     with their own key (the source is the template's id); 'integration.template_reconnect': the template's address,
--     sign-in method or header changed, so their key was dropped (the source is the template's id and its new
--     version). notification_inbox has a fixed event_type CHECK list and tables are never rebuilt, so these notices
--     get their own table, as integration_request_notices do. Metadata only: never a name, an address or a key.
--   integration_template_offers: that a person was told about a template once. Notices are kept 30 days; this keeps a
--     second notice for the same template from coming after that. Goes with the template or the person.
--   schedule_template_needs: a scheduled task whose run used a member's connection made from a template. Its next runs
--     need the owner's own key for it: without one (or with one that stopped working) the run does not start and says
--     why, instead of running without the service.
--   schedule_template_skips: a scheduled occurrence that did not start for that reason, with the template's name as it
--     was then (the run's result and the owner's inbox name it). schedule_outcomes has a fixed code CHECK list.
-- Additive only (reader 1): an older build does not know the tables.
CREATE TABLE integration_template_notices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('integration.template','integration.template_reconnect')),
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT,
  suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN (0,1)),
  UNIQUE(user_id,event_type,source_id)
);
CREATE INDEX integration_template_notices_user_page ON integration_template_notices(user_id,suppressed,created_at DESC,id DESC);
CREATE INDEX integration_template_notices_retention ON integration_template_notices(created_at);
CREATE TABLE integration_template_offers (
  template_id TEXT NOT NULL REFERENCES integration_templates(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (template_id, user_id)
);
CREATE TABLE schedule_template_needs (
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES integration_templates(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (schedule_id, template_id)
);
CREATE TABLE schedule_template_skips (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(schedule_id, scheduled_for)
);
CREATE INDEX schedule_template_skips_recent ON schedule_template_skips(created_at);
