-- min_compatible_reader: 1
-- Component B: sites a person allows for the dev environment on srt (docs/DECISIONS.md "Dev environment: sites a
-- person allows"). The person decides, not an admin: when a command needs a site that is not allowed, the chat asks
-- the person who owns the turn (allow once, always allow, don't allow).
--   dev_env_site_grants: the sites this person allowed "always". They go into the network list of this person's runs
--     only, never into another person's runs. host: an exact host name or *.domain, checked by the server.
--   dev_env_user_net: the person's Full internet switch (every host, except the team server, the private, link-local
--     and metadata addresses). full_warning: the version of the warning the person accepted when turning it on.
--   dev_env_runs.once_domains: the sites allowed once for this job or dev server (comma list), kept with the row, because
--     a waiting job builds its settings later, outside the turn.
--   dev_env_runs.net: the person's sites and Full switch when the run started (JSON); the tracker stops the run when one
--     of them goes away (the person removed a site or turned Full internet off). '' on rows from older builds: no check.
-- Additive only (reader 1): an older build does not read the new tables, and it does not name the new columns.
CREATE TABLE dev_env_site_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, host)
);
CREATE TABLE dev_env_user_net (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_internet INTEGER NOT NULL DEFAULT 0,
  full_warning INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE dev_env_runs ADD COLUMN once_domains TEXT NOT NULL DEFAULT '';
ALTER TABLE dev_env_runs ADD COLUMN net TEXT NOT NULL DEFAULT '';
