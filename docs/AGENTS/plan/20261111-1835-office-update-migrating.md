# The office Mac's update waits for a large database too (follow-ups of #443, QA TC-278)

- Date (UTC): 2026-11-11 18:35
- Branch: `fix/office-update-migrating`
- Status: in progress
- Where: server/src/office (update.ts, cli.ts, a small health.ts), native/cmd/mycel-ctl, native/cmd/mycel-bootstrap,
  a tiny shared Go package in native/internal, docs/OFFICE.md. Why: the update paths live there (docs/REPOSITORY-RULES.md).
- Version impact: patch: a bug fix in the update path, no API or data format change.

## Goal

#443 made a new version answer /api/health 503 `status: "migrating"` while it copies and migrates a large database, and
taught mycel-bootstrap and `mycel-ctl update` to wait for it. Left over from its review:

1. The office Mac's updater (server/src/office/update.ts, 150 s health wait) and `office.js install` (90 s, run by
   `office-install.sh --update`) do not know "migrating": a large migration still fails and rolls back on a Mac.
2. `mycel-ctl update` waits a hard-coded 60 minutes instead of the bootstrap's `--migrate-timeout`; they can disagree.
3. docs/OFFICE.md does not say what desks see meanwhile.

## Scope

In:
- office/health.ts: one /api/health probe that tells "answers as X", "migrating as X (progress)" and "no answer";
  MIGRATE_WAIT_MS = 60 min (the bootstrap's default).
- update.ts waitVersion: while the version it waits for says migrating, the deadline moves to now + the health wait;
  no more time once that has lasted MIGRATE_WAIT_MS from the switch (the same rule as the bootstrap's extendDeadline);
  progress in the update log once a minute; failure messages say "still updating its database".
- cli.ts `install`: under the updater (TEAMAX_UPDATE_RUN=1) a "migrating" answer counts as started (the updater waits,
  its 10-minute installer timeout would kill a longer wait); a hand-run install keeps waiting while it migrates, bounded
  the same way. `teamax status` says "updating its database".
- Go: native/internal/bootflags holds the --migrate-timeout default and reads it from a bootstrap command line; the
  bootstrap's flag default uses it; `mycel-ctl update` reads the bootstrap's ExecStart in <id>-server.service (and its
  drop-ins) and uses that value, the default when it is not set.
- docs/OFFICE.md: desks on the LAN TLS port get "connection refused" while it migrates (only 127.0.0.1:<app port>
  listens), roughly how long.

Out: a "migrating" page for the desks on the LAN port (the stand-in serves only the main address).

## Steps

1. health.ts + update.ts + cli.ts, unit tests for waitVersion (fake clock) and healthAnswer.
2. bootflags package + bootstrap + mycel-ctl, Go tests.
3. OFFICE.md, changes/ fragment.

## Risks

No migration. Office: the wait is still bounded (MIGRATE_WAIT_MS + health wait). A unit with an unparseable
--migrate-timeout: the bootstrap itself would refuse to start, mycel-ctl uses the default.
