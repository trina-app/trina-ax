# Files and setup: a version under the right hash; the spent setup code goes

- Date (UTC): 2026-11-11 17:40
- Branch: `fix/audit-small-server-2`
- Status: in progress
- Where: `server/src/team-files/service.ts`, `scripts/install-linux.sh`. Why: team files and the Linux installer are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch, two bug fixes with no new behaviour or setting

## Goal

11-11 code audit, two rows:

- Row 33. Replacing a file (upload with "replace", a move onto a file, a version restore) hashes the current file,
  waits for the hash, then copies whatever is on disk by then into History under that hash. Two replaces of one file at
  once: the second one's copy holds the first one's bytes under the old file's hash, and restoring that version later
  does nothing ("already this content").
- Row 120. `setup/code` (root's copy of the first-run code) stays after the owner is made; the server deletes only
  `data/setup-token`. It also survives an uninstall without `--purge`.

## Scope

In: a `shaNow` helper in TeamFiles that hashes again when the file changed (inode, size, mtime) while it was read; the
three places that hash and then snapshot use it, with no await between the hash and the copy. In the installer, a
`drop_spent_setup_code` step (database there, no `data/setup-token`: the team is set up) after step 11 and in an
uninstall that keeps the data.

Out: the macOS installer (docs/INSTALL.md says its `setup/code` stays, harmless); the other rows of this batch (PR 1 and
the PR body).

## Steps

1. Plan (this commit).
2. `tests/unit/c-files-replace-race.test.ts`: two replace uploads at once; every version's blob hashes to its sha256,
   restoring the middle one brings it back. Fails before the fix.
3. `shaNow` in service.ts; used in placeUpload, the move onto a file and restoreVersion.
4. `drop_spent_setup_code` in install-linux.sh; a test in `tests/unit/g-scripts.test.ts` runs the function on three
   folder states and checks where it is called. Fails before the fix.
5. docs/INSTALL-LINUX(.en).md: one sentence that the code is spent and when it goes.

## Risks

No migration. A file someone outside keeps writing may now get a conflict after five reads instead of a wrong version.
The installer only removes `setup/code` when the database exists and the server's token is gone.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the new tests, `c-files*`, `c-uploads`, `g-scripts`.

## Result

Filled in at the end.
