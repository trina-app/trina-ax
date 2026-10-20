-- min_compatible_reader: 1
-- Component F (relay client). The team's registration at a relay, and a short log of relay connection events for
-- the diagnostics screen ("최근 끊김") and owner notices. The private key itself is a 0600 file, never in the DB.

CREATE TABLE relay_registrations (
  -- registry API base of the relay, e.g. https://relay.treesoop.com (self-hosted relays have their own)
  relay_api TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  -- base64 SPKI of the key registered there (if the key file changes, the registration no longer applies)
  public_key TEXT NOT NULL,
  address TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_heartbeat_at TEXT
);

CREATE TABLE relay_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  -- connected, disconnected, offline, replaced, took_over, key_rejected, registered, auth_failed
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX relay_events_at ON relay_events(at);
