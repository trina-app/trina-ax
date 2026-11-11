# Backups and updates survive a crash or power loss

- Date (UTC): 2026-11-11 19:28
- Branch: `fix/update-backup-durability`
- Status: in progress
- Where: server/src/system (backup.ts, update.ts, streams.ts, ops.ts), scripts/install-linux.sh. Why: QA side findings of TC-278/TC-279.
- Version impact: patch (bug fix, no new behaviour or setting)

## Goal

1. A backup interrupted by a crash or reboot left its partial DB copy (1.4 GB in QA) in data/backups for ever.
2. A power loss shortly after `install-linux.sh update` left a new version whose files were not on disk; the bootstrap
   rolled back to a version that cannot read the migrated DB, and the team server stayed down.
3. Look at why the old server stops answering during the pre-update backup on a slow disk; fix only a small, safe part.

## Scope

In: VACUUM INTO writes `<id>.sqlite.partial`, fsyncs and renames it; `removeUnfinished()` (after every backup and at
start) removes partial copies, meta-less copies/journals/team archives and stale metadata temp files untouched for 6 h,
never anything of an id with its `<id>.json`. install-linux.sh syncs the new version (and engine) before the rename,
syncs the folders after it, and switches app/current with a rename of a temporary link. The in-app update (update.ts)
fsyncs the staged tree before its rename and state.json / app/current after the switch. The backup's integrity check
(PRAGMA quick_check, a full read of the copy) moves to a child process.
Out: the slow-disk writeback stall itself (report only); mycel-bootstrap rolling back to a version that cannot read the DB.

## Steps

1. backup.ts: partial name + fsync + rename, removeUnfinished, quick_check in a child; ops.ts start hook.
2. streams.ts fsyncPath/fsyncTree; update.ts stage/switch sync.
3. install-linux.sh sync + atomic symlink switch (versions and engines).
4. Unit tests (g-backup, g-update), a static check in g-scripts, a Docker run of the switch.

## Risks

Sync adds a second or two to the install's downtime (the data must reach the disk anyway). Removing backups: only
ids without metadata and only after 6 h unchanged, so a backup another process is writing is safe.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, tests/unit/g-backup, g-update, g-scripts, p1-backup-dirs; Docker
(debian:trixie + systemd) for the install switch.

## Result

(filled in at the end)
