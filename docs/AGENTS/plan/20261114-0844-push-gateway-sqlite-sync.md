# Push gateway: SQLite without a disk flush on every write

- Date (UTC): 2026-11-14 08:44
- Branch: `fix/push-gateway-sqlite-sync`
- Status: in progress
- Where: push-gateway/src. Why: the gateway's state store lives there (docs/REPOSITORY-RULES.md)
- Version impact: none: the push gateway is deployed on its own; team servers and apps do not change

## Goal

A load test of the gateway on its production-size server (2 vCPU, gp3 disk, fake Apple and Google endpoints) stopped
at about 75 sends a second with the CPU mostly idle: each send makes 4 to 5 small SQLite writes, and with SQLite's
default `synchronous = FULL` each one waits for the disk while the only JavaScript thread is blocked. With
`synchronous = NORMAL` the same server sent 200 a second (p99 130 ms) and 400 a second (p99 279 ms). The gateway
must keep up when many teams send at the same moment.

## Scope

In: `openSqlite` sets `PRAGMA synchronous = NORMAL` after `journal_mode = WAL`; a test that checks both; a README
line; a changes/ fragment.
Out: grouping a send's writes in one transaction; more processes.

## Steps

1. Set the pragma in `openSqlite` (push-gateway/src/bun.ts).
2. Test: a file database opened by `openSqlite` reports WAL and NORMAL.
3. README note; changes/ fragment.

## Risks

In WAL mode NORMAL keeps the database consistent; a power loss or a crash of the whole server can lose the last
commits. Those are rate-limit counters, dedupe entries and first-seen records, which expire within minutes to a day.
Losing them can at worst let a retry send once more. A crash of the gateway process alone loses nothing.

## Tests

`bun test tests/unit/push-gateway*.test.ts`, `bunx tsc -p push-gateway/tsconfig.json --noEmit`, `bun run typecheck`,
`bun run check:docs`.

## Result

Filled in at the end.
