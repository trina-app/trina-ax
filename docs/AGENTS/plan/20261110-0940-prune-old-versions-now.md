# The version prune removes old versions without a day's wait

- Date (UTC): 2026-11-10 09:40
- Branch: `fix/prune-old-versions-now`
- Status: in progress
- Where: trina-ax core, `server/src/system/prune.ts` and its tests. Why: the server's own updates are core
  (docs/REPOSITORY-RULES.md).
- Version impact: patch. A server that updates often keeps fewer old version folders; no API, data or text change.

## Goal

The dev test server updates about 40 times a day. The prune keeps every version folder changed in the last 24 hours,
so about 40 folders of about 550 MB stay (22 GB). After this change only the folders that roll-back, the bootstrap or
an update in progress can use stay: about 2 to 4 folders.

## Scope

In:
- A version folder NEWER than app/current keeps the 24-hour guard (`mycel-ctl update` and a scheduled update can wait
  for the update window between the copy and the switch; `stage-update`; the installer).
- A version folder OLDER than (or the same as) app/current gets a 1-hour guard instead of 24 hours. It protects the only
  ways to go to an older version: `admin.js switch <older>` / Admin's Roll back (they touch the folder first, then switch
  within seconds) and `mycel-ctl update --version <older>` (it copies or touches the folder, then waits at most
  `--max-wait`, 10 minutes, for running turns before the switch).
- The comparison uses the re-read app/current at the check right before removal too. The other safety checks stay: the
  ctime re-check, owner, mount point, the `.prune-<hex>` rename.
- Comments in prune.ts, update.ts and mycel-ctl, docs (DECISIONS.md, INSTALL-LINUX.en.md), the unit tests and the
  Linux Docker test.

Out: `.staging-*`, `*.partial`, `.prune-*` and engine folders keep their one-day rule.

## Steps

1. prune.ts: a grace per version folder (24 hours when newer than current, 1 hour otherwise); the reason strings.
2. Unit tests: an older version changed 2 hours ago goes; a newer one changed 2 hours ago stays; an older one changed
   just now stays; dev-style names (`x.y.z-beta.1.dev.<UTC time>`).
3. Linux Docker test: the real-clock run right after staging keeps only the newest-and-previous plus the folders of the
   last hour.
4. Docs and a CHANGELOG bullet.

## Risks

An older kit that the installer only stages (not switched to) now goes at the first prune an hour later. To go back to
it, run `mycel-ctl update --version <v>` or the installer again. No migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun test tests/unit/g-prune.test.ts`, `bun tests/linux/prune-versions.ts`
where Docker is available.

## Result

Filled in at the end.
