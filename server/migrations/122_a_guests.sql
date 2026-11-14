-- min_compatible_reader: 8
-- Component A: guests (docs/DECISIONS.md "Guests: only what they were invited to"). An outside person invited into
-- exactly one place: one group chat or one project (owner, 2026-11-14). users.role keeps its CHECK (owner/admin/member) because the table is never rebuilt:
-- a guest is stored as role 'member' with users.guest = 1 and read back as role 'guest' everywhere
-- (server/src/auth/guests.ts roleSql, auth/users.ts USER_COLS, policy/access.ts loadPrincipal). Reader level 8: an
-- older build would read a guest as a full member, so it must not open this database.
--   users.guest: 1 = guest. Set once, when the invite is accepted; cleared only by "convert to member".
--   guests: the per-guest settings. place_kind / place_id: the guest's one place ('room' = a group chat id, 'project' =
--     a project id); an admin may move it, a second place is refused (guest_one_place). ai: how the guest's AI runs ('none' default, 'team' = connections assigned to them
--     personally under a 'block' budget of their own, 'own' = their own Claude/Codex sign-in). invited_by: who invited.
--   invites.guest_place_kind / guest_place_id: the one place a guest invite opens;
--     invites.guest_ai: JSON {"mode":"none"|"team"|"own","credentialId"?,"limitUsd"?} (null on member invites).
ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0 CHECK (guest IN (0, 1));
CREATE TABLE guests (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  place_kind TEXT NOT NULL CHECK (place_kind IN ('room', 'project')),
  place_id TEXT NOT NULL,
  ai TEXT NOT NULL DEFAULT 'none' CHECK (ai IN ('none', 'team', 'own')),
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE invites ADD COLUMN guest_place_kind TEXT CHECK (guest_place_kind IS NULL OR guest_place_kind IN ('room', 'project'));
ALTER TABLE invites ADD COLUMN guest_place_id TEXT;
ALTER TABLE invites ADD COLUMN guest_ai TEXT;
