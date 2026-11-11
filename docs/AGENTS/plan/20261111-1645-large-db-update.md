# A large database can finish an update (QA TC-278)

- Date (UTC): 2026-11-11 16:45
- Branch: `fix/large-db-update`
- Status: done
- Where: server/src (db.ts, main.ts, a start-up migrator), native/cmd/mycel-bootstrap, native/cmd/mycel-ctl. Why: the
  update path and its watchdog live there (docs/REPOSITORY-RULES.md).
- Version impact: patch: a bug fix in the update path, no API or data format change.

## Goal

On a multi-GB database the copy made before migrating (VACUUM INTO) plus the migrations take longer than the
bootstrap's health timeout (120 s). The server only listens after both, so the bootstrap kills the new version and rolls
back, every time, and each try leaves another full-size copy (pre-migrate-*.db, or a half-written one in
.pending-migration-*/ when it was killed). An update must be able to finish on a large database.

## Scope

In:
- Server: when the database has data and migrations are pending, listen first with a stand-in that answers
  /api/health 503 `{ok:false, status:"migrating", version, migrating:{since, copiedBytes, dbBytes}}` (everything else
  503), run the copy and the migrations in a child process (bun:sqlite is synchronous: in-process it would block the
  event loop), then start as before. A child that fails: exit 75 stays exit 75, other errors fail the start.
- Bootstrap: a pending or forwarded version that reports `migrating` with its own version gets its deadline moved to
  now + --health-timeout on every such answer, never past start + --migrate-timeout (new flag, 60 min). Progress in the
  log every minute. --max-attempts, the roll-back and the stop (PR #401) are unchanged.
- mycel-ctl update: its own wait for /api/health is extended the same way (bounded by the same 60 min).
- Copies: a new pre-migrate copy replaces older ones of the same schema (same applied migrations: a failed try of the
  same update); staging folders of processes that are gone are removed. Other copies keep the 14-day retention.

Out: the office Mac updater (server/src/office/update.ts waits 150 s too): follow-up.

## Steps

1. db.ts: `pendingSlowMigration(file)`, copy pruning, stale staging removal.
2. system/migrate-start.ts: stand-in listener + child migrator; main.ts uses it before openDb.
3. Bootstrap: health states, --migrate-timeout, progress log. mycel-ctl: same in update wait.
4. Tests: Go (bootstrap + ctl), bun unit (db, migrate start).

## Risks

No migration added. The stand-in answers on the main listener only (TLS comes up with the real server). A signed-out
request through the office internet address gets no version (same rule as /api/health).

## Tests

bun run typecheck, check:i18n, check:docs; go test ./cmd/mycel-bootstrap ./cmd/mycel-ctl; unit tests for db / migrate /
update.

## Result

Built as planned. After the independent review: SIGHUP during the migration is ignored and SIGTERM/SIGINT stop the
migrator (main.ts sets its handlers only after start()); a staging folder with this process's own pid counts as stale
(pids repeat in a container); same-schema copies made before the last restore are kept; the deadline while migrating is
now + --health-timeout until start + --migrate-timeout, so a start right after a long migration gets the usual time
(bound: --migrate-timeout + --health-timeout). Checked on a 1.5 GB database (dev server): /api/health 503 migrating with
copy progress, then 200; killed twice mid-copy, the next start left one copy. Follow-ups: the office Mac updater
(server/src/office/update.ts, 150 s) and the Docker HEALTHCHECK (unhealthy while migrating).
