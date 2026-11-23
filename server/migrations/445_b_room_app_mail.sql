-- min_compatible_reader: 1
-- Component B: email into rooms (plan docs/AGENTS/plan/20261123-0421-room-email.md). An Email app is a room app with
--   kind 'other' and preset 'email' (an older build reads it as an Other app whose Webhook URL never matches: its token
--   is not a Webhook URL token). token_hash / token_enc hold the email address's random part.
--   mail_confirmation: the last forwarding confirmation a mail provider sent to the address (JSON: provider, from, code,
--   at), shown only to the people who manage the app, cleared after 7 days or by a new address.
--   mail_synced_hash: the token_hash the mail service last confirmed it takes mail for ('ready' when equal).
-- Additive only (reader 1): an older build ignores both columns.
ALTER TABLE room_apps ADD COLUMN mail_confirmation TEXT;
ALTER TABLE room_apps ADD COLUMN mail_synced_hash TEXT;
