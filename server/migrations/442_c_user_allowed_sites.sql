-- min_compatible_reader: 1
-- Component C: "이 사이트 항상 허용" (always allow this site) on the address card is the person's own choice for good
-- (docs/decisions/20261122-always-allow-holds-everywhere.md B3; server/src/tools/url-gate.ts). The owner, 2026-11-22:
-- "이렇게 또 권한을 매번 대화마다 다 해줘야하는 미친 상황 더 없겠지?" One row per person and site: later plain addresses
-- on that site (registrable domain, eTLD+1 by the Public Suffix List with its private section) open without a card in
-- every chat that person asks in and in their scheduled runs, until they delete the row in Settings › Allowed for Trina
-- (GET /api/ai-allowances) or an admin turns the team's "Always allow" switch off (rows are then ignored, not deleted).
-- The address limits of chat_allowed_sites (324) stay: long random-looking parts, a long name before the site, a user
-- name or password, an echo, a confidential chat, office-network answers after the lookup.
--   site: the registrable domain in ASCII (punycode) form; chat_id: the chat whose card it was (audit only)
-- 442: 441 (connector_tool_allow, fix/connector-always-allow) is the highest on dev and the open branches.
-- Additive only (reader 1): an older build ignores the table and asks as before.
CREATE TABLE user_allowed_sites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  chat_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, site)
);
