-- min_compatible_reader: 1
-- Component A: google_signin_flows.ip_hash, the hash of the address that started a sign-in flow (Sign in with Google;
-- docs/decisions/20261124-google-signin-security.md). Open sign-in flows are counted per address, so a few addresses
-- cannot fill the server-wide cap and lock out people who sign in only with Google. A hash, never the address; the row
-- goes when the flow expires (10 minutes). NULL for flows of a signed-in person and rows made before this migration.
-- Additive only (reader 1): an older build ignores it.
ALTER TABLE google_signin_flows ADD COLUMN ip_hash TEXT;
CREATE INDEX google_signin_flows_ip ON google_signin_flows(ip_hash, status);
