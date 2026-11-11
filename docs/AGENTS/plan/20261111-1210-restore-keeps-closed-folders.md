# A database-only restore keeps the folder permissions as they are now

- Date (UTC): 2026-11-11 12:10
- Branch: `fix/restore-keeps-closed-folders`
- Status: done
- Where: `server/src/system/backup.ts` (core). Why: the in-app restore is core backup code (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a security fix to the existing restore, no new feature or API

## Goal

QA TC-195 (P1, security). Admin › System › Backups › Restore (and `admin.js stage-restore`) puts an older database back
but leaves the team folder as it is now. Folder permissions live in the database (`folders`, `folder_rules`, keyed by
path). So after a restore, a folder made and closed after the backup (shared/HR, everyone: none) has no rules and
inherits shared/ again: every member lists it and reads the salary file saved in it. A folder that was open at the
backup and closed after it opens again the same way. The files are today's; the permissions were yesterday's.

After this change, a database-only restore never opens a team folder to more people than just before the restore.

## Options (owner decision)

1. **Keep the folder permissions as they are now (chosen, most conservative for folders).** The restored database gets
   the current `folders` rows and their rules, so every path has exactly the rules it had just before the restore.
   The files stay as they are now, so their permissions do too. Cost: a restore no longer undoes folder rule changes
   (an admin changes them back in Admin › Folder permissions). A group deleted after the backup comes back without its
   folder rule (its folder stays closed to the owner and admins until someone adds it).
2. Keep the backup's rules, but close (everyone: none) every folder whose rules differ from today's, and tell the owner
   to review them. Covers the same cases, but closes folders that were open before the restore too, and needs a review
   screen.
3. Keep the backup's rules and close only folders on disk with no rules in the restored database (the QA case). Does
   not cover a folder that was open at the backup and closed after it.

People: the restore also brings back group memberships, roles and accounts as they were at the backup (a person taken
out of a group after the backup is in it again, a person switched off after it can sign in again). The dialog says
account changes are lost. This branch does not change that; options for a follow-up: (a) keep it, (b) a person
switched off or removed since the backup stays off, a group membership removed since stays removed, an admin made a
member since stays a member (never the owner). Needs the owner's decision.

## Scope

In: `keepFolderAccess(live, staged)` in `applyPendingRestore` (every DB-only restore path: Admin and
`admin.js stage-restore`), the restore result says whether it ran, System's checks warn when it could not, the restore
dialog's text in five languages, docs/BACKUP-RESTORE.md, docs/DECISIONS.md.
Out: restores that bring back the team folder too (archive, office swap, off-site restore): their files and rules come
from the same moment. People and groups (above).

## Steps

1. `keepFolderAccess`: read the current database's `folders` and `folder_rules`; in the staged copy, delete all rules,
   keep the backup's folders rows only where today has no row with that id or path (a row parked in the trash keeps
   its backup rules: they only decide who sees that trash item and its versions, as at the backup; any other such row
   keeps no rules, as today), insert today's rows and rules. A group whose folder row is gone gets no folder.
2. If today's database cannot be read (missing or broken: the restore is the way back), the restore goes on with the
   backup's rules, `restore-result.json` says `folderRules: "backup"` and System's checks warn to review folder
   permissions. Any other failure stops the restore (the current database stays).
3. Texts, docs, DECISIONS.

## Risks

No migration. Security: who sees folders after a restore (owner OK). Schema: `folders`/`folder_rules` columns unchanged
since 001, so a backup from an older version works (columns named explicitly). Five languages for the dialog.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/g-backup.test.ts` + a new test
(a folder closed after the backup stays closed for a member after the restore; a folder opened after it stays open; a
new rule folder; a parked row; unreadable live DB), and the QA steps on a local dev server.

## Result

Built as planned: `keepFolderAccess` in `server/src/system/backup.ts`, called by `applyPendingRestore` before the swap;
`restore-result.json` has `folderRules: "kept" | "backup"`; System's checks warn for 7 days after a restore that kept the
backup's rules; the restore dialog says files and folder permissions stay as they are now (five languages);
docs/BACKUP-RESTORE.md and DECISIONS updated. Tests: `tests/unit/g-restore-folder-rules.test.ts` (7 cases),
`tests/unit/g-linux-diag.test.ts` (the warning). On a local dev server: backup, then shared/HR made with everyone: none
+ owner write and a salary file, and shared/Plans (everyone: read at the backup) closed; restore and restart: both
members get 404 for HR and Plans, find "급여" returns nothing, the owner still reads the file, Admin › Folder
permissions lists both folders with today's rules. The people side (group memberships, switched-off people, roles)
is left for the owner's decision (Options above).

Review (2026-11-12, independent): the folder logic holds, no blockers. Still open, as above: the people side. Someone
taken out of a group after the backup is back in it after the restore (group memberships, roles and switched-off
accounts come back as at the backup); that needs the owner's decision and a follow-up. Rebased onto dev after #464
(TC-208): `applyPendingRestore` keeps dev's outcome and adds `folderRules`.
