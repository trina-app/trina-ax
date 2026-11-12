# Only the lowercase projects/ folder is members-only on case-sensitive disks

- Date (UTC): 2026-11-12 07:08
- Branch: `fix/projects-lowercase-only`
- Status: done
- Where: trina-ax core (`server/src/policy/`, `server/src/files/service.ts`, `server/src/chat/members-only-once.ts`,
  `server/src/admin/folders.ts`, `server/src/admin/audit.ts`). Why: folder permissions and projects are core (see
  docs/REPOSITORY-RULES.md)
- Version impact: patch: on case-sensitive disks a 0.4.0 team folder named `Projects/` (or any other case) gets its
  normal folder rules back; nothing changes on case-insensitive disks

## Goal

QA TC-360, open point (2): the members-only rule compares `projects` after lower-casing, so on a case-sensitive Linux
disk an ordinary 0.4.0 folder such as `Projects/ClientA`, which everyone could read, became members-only. The owner and
admins lost it while members kept it, until someone adopted it on the Projects page. The owner decided: only the
lowercase `projects/` folder (exactly, after Unicode NFC) is the projects root on a case-sensitive disk. On a
case-insensitive disk (macOS APFS default) both names are one folder, so nothing changes there.

## Scope

In: one check "is this segment the projects root" that follows the team folder's disk (folds case only where the disk
does), set from `detectCaseInsensitive` when the files service starts; every place that decides "under the projects
root" uses it: `policy/access.ts` (`inProjectZone`, `isProjectsTop`), `policy/zone.ts` (`projectZoneFolders`, `inZone`,
`insideProject`, `cutInsideProject`), `admin/folders.ts` `isProjectsFolder`, `admin/audit.ts` `pathHidden`,
`members-only-once.ts` (the shared-answers step's SQL `LIKE`, which ignores ASCII case, and the adopt step's used-folder
set, now by `volumeKey`). `projects.ts projectOnFolder` and `schedules.ts templateProjectGone` already compare by
`volumeKey` and use `inZone`, so they follow.
Out: other case handling (skill folders, `groups/`, personal `users/<id>/projects`, the activity log's text regex,
which errs on hiding), a notice at the upgrade.

## Steps

1. `policy/access.ts`: `isProjectsName(seg)` (NFC equal to `projects`, or lower-cased equal while the disk folds case)
   and `setProjectsCaseInsensitive(ci)`; default folds (fails closed where no files service runs).
2. `files/service.ts` sets it from `detectCaseInsensitive(teamRoot)`.
3. Use `isProjectsName` in every place listed above.
4. Tests: a case-sensitive team (`Projects/ClientA` by the normal rules for owner, admin and member; `projects/ClientA`
   members-only) and the case-insensitive path as before; update the unit tests that asserted folding without saying
   which disk.
5. DECISIONS line, `changes/projects-lowercase-only.md`.

## Risks

A process-wide setting: one team folder per server process, so it is one disk. Tests that build a case-sensitive team
on a case-insensitive disk set it and restore it. No migration, no API change, no new text in the five languages.

## Result

Built as planned. `isProjectsName` in `policy/access.ts`, set by `files/service.ts`; used by the zone helpers,
`isProjectsFolder`, the activity log's path check and `members-only-once.ts`. Not changed: the web app's
`isProjectsTop` (it does not know the disk; noted in DECISIONS). Tests: `tests/unit/b-projects-lowercase-only.test.ts`;
tests that used `Projects/` or `PROJECTS/` as the zone now do so only where the disk ignores case.
