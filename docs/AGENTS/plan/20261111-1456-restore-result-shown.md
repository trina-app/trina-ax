# After a restore, Admin shows which backup was restored, when and by whom

- Date (UTC): 2026-11-11 14:56
- Branch: `fix/restore-result-shown`
- Status: done
- Where: `server/src/system`, `server/src/main.ts`, `web/src/pages/admin/System.tsx` (core). Why: the in-app restore is core backup code (see docs/REPOSITORY-RULES.md)
- Version impact: patch: an additive field on an owner endpoint and a log row; no behaviour change of the restore

## Goal

QA TC-208 (P3). After Admin › System › Backups › 복원 and the restart, nothing shows that a restore happened: only
the toast before the restart. Admin home, System and the activity log are silent; `data/restore-result.json` is read
only for a failure (System's checks). The owner cannot tell which backup is now in use, when it was put back, or by
whom.

## Scope

In:
- At the start that applies (or fails to apply) a staged restore, an activity log row `backup.restore` ("백업 복원"):
  the person who asked, the backup id, the backup's time, when it was asked, success or the failure.
- `GET /api/admin/backups` gets an optional `lastRestore` (from that row): backup id and time, when, by whom, ok.
- Admin › System › Backups shows it as one line: "{backup time} 백업으로 되돌렸어요 · {when} · {who}" (or that it failed
  and the data was kept). Five languages.
Out: Admin home attention items (a failed restore is already a System check that fails); restores through the CLI
`restore-archive` (they do not go through this start).

## Steps

1. `applyPendingRestore` returns who asked and when; `backupCreatedAt(dataDir, id)` reads the backup's time from its
   metadata. main.ts writes the audit row once the database is open (the restored one, or the kept one on failure).
2. `lastRestore(db)` for the list endpoint; the shared schema field (optional, additive); mock server.
3. System.tsx line; audit label `audit.act.backup.restore`; tests (server unit for the row and the field, web e2e on
   the mock).

## Risks

No migration (audit_log takes any action). The row goes into the restored database, so it is there after the restore.
PR #409 changes the same function (`applyPendingRestore`, other lines): whichever merges second rebases.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/g-backup.test.ts` (+ new),
`bun run test:web`, system-console e2e.

## Result

As planned. `stageDbRestore` writes `backupCreatedAt` into `restore-pending.json` (optional field);
`applyPendingRestore` returns who asked and when; main.ts calls `recordRestore` once the database is open (activity
log `backup.restore`, by the person who asked; no actor when the restored database does not know them);
`lastRestore(db)` feeds `GET /api/admin/backups` `lastRestore`; Admin › System › Backups shows one line ("{when}에
{name}님이 {backup time}에 만든 백업으로 되돌렸어요", or that it failed and the data was kept); activity label "백업
복원" in five languages; docs/site/reference/http-api.md regenerated. Local dev server: backup, restore, restart:
the API answers lastRestore with the backup id, its time, the owner and ok; the activity log lists "이도윤 백업 복원 ·
<backup id>"; System shows the line.
