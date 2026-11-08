# What a deleted member or group leaves behind

- Date (UTC): 2026-11-08 09:30
- Branch: `fix/removal-leftovers`
- Status: in progress
- Where: trina-ax core (`server/src/admin/groups.ts`, `server/src/admin/users.ts`, `server/src/credentials/`,
  `server/src/team-files/service.ts`, a component A migration, the group and member delete dialogs in
  `web/src/pages/admin/`, `docs/PERMISSIONS.md`, `docs/security-and-permissions*.md`). Why: members, groups, AI
  connections and files are core (see docs/REPOSITORY-RULES.md).
- Version impact: patch. Fixes what deletes leave behind; one additive data migration, no API change.

## Goal

A design audit of dev found four leftovers of deleting a member or a group.

1. AI connection assignments outlive the group or person. A team connection assigned only to a deleted group serves
   nobody, and every later save of that connection fails (`unknownAssignee`): the dialog sends the dead id back and has
   no checkbox to untick it.
2. Deleted accounts keep their photo, title and status (`user_profiles`): users are soft-deleted, so the cascade the
   migration counts on never fires. App Store account-deletion rules need them gone.
3. "Transfer" of a deleted member's personal folder is a raw rename: version history, projects and the text cache stay
   at the old path.
4. Docs say only owners remove members, and that the owner never sees a personal folder; neither is true.

## Scope

In:
- Group and member delete remove the dead `engine_credential_assignments` rows. A team connection left with no
  assignment is switched off (`disabled`), never team-wide; the delete confirmation names those connections in one line.
- Saving a connection drops ids that no longer exist; when that leaves none of the ones sent, the connection is switched
  off in the same write instead of becoming team-wide.
- A migration does the same for rows left by earlier deletes, and deletes the profiles of people already deleted.
- `deleteUser` deletes the profile in its transaction.
- The personal-folder transfer runs through the same bookkeeping as a move on the Files screen.
- Docs: who removes members, what transfer does with the personal folder, a table of who reviews each kind of skill
  proposal (documentation only).

Out: changing the default of `personalFolder`; changing who reviews skill proposals; other settings that name groups
(engine choice, dev environment scope).

## Steps

1. A helper in `server/src/credentials/` that removes a subject's assignments and switches off the connections left with
   none; called inside both delete transactions; audited and told to the owner like any switch-off.
2. `updateCredential`: drop dead ids; switch off when none of the sent ones is left.
3. Migration `117_a_removal_leftovers.sql`: profiles of deleted people; dead assignments (switch off first, audited).
4. `deleteUser`: `DELETE FROM user_profiles` in the transaction.
5. `TeamFiles`: the move's database and disk part becomes one private step, used by `move` and by a new
   `archiveFolder` that the transfer calls.
6. Web: the group and member delete confirmations name the connections that will be switched off (5 languages).
7. Docs, DECISIONS entry, CHANGELOG line.

## Risks

Access: never widen. A connection that served named people must not become team-wide by any of these paths. Migration
number: highest component A migration on dev is 116. Five languages for the confirmation line. Phone width for the
dialogs.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, every unit test file matching the touched areas, new
unit tests for each fix, `bun run test:web`, `bun run build:web` and the admin e2e specs.

## Result

Filled in at the end.
