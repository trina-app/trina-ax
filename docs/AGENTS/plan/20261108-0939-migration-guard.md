# Migrations that would be skipped say so

- Date (UTC): 2026-11-08 09:39
- Branch: `chore/migration-guard`
- Status: done
- Where: trina-ax `server/src/db.ts`, `tests/unit/`. Why: the migration runner is core server code (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a server log line and a test; no API, setting or data change

## Goal

The runner applies only `NNN_<lower-case>.sql` files and knows applied migrations by number only, while the builds ship
every `.sql` file. A misnamed file is skipped without a word, and a migration renumbered after a database ran it
leaves that database skipping the new file at the old number (214, 222 and 326 were on dev under another name). Make
both visible, for developers in CI and for whoever runs a server in its log.

## Scope

In: a unit test that fails on a file the runner skips, a `.sql` file `readMigrations` misses, or two files with one
number; at start-up one warning per recorded migration whose file was renamed since, naming both.
Out: refusing to start on a mismatch (dev and customer databases already hold renamed entries), renumbering files,
changing the number ranges (B's next range is a proposal in the PR for the owner).

## Steps

1. Export the runner's file pattern from `db.ts` and use it in `readMigrations`.
2. `renamedMigrations(db, files)`: recorded rows whose name is not the file of that number, or whose name is now under
   another number. `migrate` logs one warning each through an optional `log`, before pending migrations run.
3. The server's `start()` passes its log to `openDb`.
4. Test: the folder checks, the runner's skips and duplicate refusal, the warning cases, no warning after a downgrade
   or on a matching database.

## Risks

Migrations: none added (highest on dev: 272). A warning on a downgrade would be noise: a recorded number with no file
and no file of the same name gets none. Other `openDb` callers (CLIs, tests) pass no log and stay quiet.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the unit tests that read migrations or
`schema_migrations`, and the tests that start the server.

## Result

Built as planned. The warning also covers a migration moved away with no file left at its old number (the 326
case), and says whether the moved file still runs on that database (review). The test is
`tests/unit/p1-migration-files.test.ts` (foundation tests use `p1-`). Nothing renumbered; B's next range is a proposal
in the PR.
