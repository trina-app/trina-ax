-- min_compatible_reader: 1
-- Component C: "allow this site in this conversation", a choice on the address card (server/src/tools/url-gate.ts,
-- docs/DECISIONS.md "Allow a site for one conversation"). Like Claude Code's "don't ask again for this domain", but for
-- one chat and one person: after the person picks it, later addresses on the same site (registrable domain, eTLD+1 by
-- the Public Suffix List with its private section) open without a card in that chat only, for that person only, and
-- outside the link budget. It never covers an address with a long query or a long random-looking part, any address
-- while the office's exit address is unknown, or a confidential chat; the name is still looked up only after this
-- check and an office-network answer is still refused.
--   site: the registrable domain in the address's ASCII (punycode) form, e.g. example.co.kr, alice.github.io
--   user_id: the person who picked it; turn_id: the answer whose card it was (audit)
-- Additive only.
CREATE TABLE chat_allowed_sites (
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site TEXT NOT NULL,
  turn_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (chat_id, user_id, site)
) WITHOUT ROWID;
