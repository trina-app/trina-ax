# The team is told when the hosting service copies its data, or when the team address moves away

- Date (UTC): 2026-11-12 10:00
- Branch: `fix/hosting-copy-audit`
- Status: done (PR open)
- Where: trina-ax core (`server/src/system/cli.ts`, `server/src/relay-client/`, `server/src/notifications/`,
  `shared/src/api/notifications.ts`, `web/src/i18n/`, migration `120_a_hosting_notices.sql`). Why: the activity log,
  the Inbox and the relay client are core features (docs/REPOSITORY-RULES.md)
- Version impact: minor — three new notice kinds and their table (migration 120, additive)

## Goal

QA TC-348: when the hosting service copies the team's AI connections' key (`admin.js credentials-escrow-out`), takes a
full export (`admin.js archive --upload`) or an offsite backup (`admin.js cloud-backup upload`), the team's activity log
gets nothing and the owner is not told. `reset-link` already does both (an audit line and an Inbox notice).

QA TC-350: when the relay stops taking this server's key because the address was moved to another key (an operator key
rotation, or a recovery code used on another server), the server only records offline / auth_failed and retries. The
owners and admins are not told.

## How

- Activity log (audit, actor = none = the hosting service): `hosting.key_escrow` (key version), `hosting.export`
  (size, sha256), `hosting.offsite_backup` (the backup id and how many files went up; one line per upload run).
- Inbox notice, always shown, to the owners: `hosting.key_copied` and `hosting.exported` (source: the audit row). No
  notice for the offsite backup: it runs every day and would bury the Inbox; the activity log line is enough.
- Inbox notice, always shown, to the owners and admins: `relay.address_moved`, when the relay refuses this server's key
  (`key rotated` / `signature does not match the registered key`). Once per change: a relay event `key_moved` is
  recorded, and no new one (and no notice) while the newest of `key_moved` / `connected` is `key_moved` — retries and
  restarts do not repeat it; a connection in between arms it again. The source is that event's id.
- One table `hosting_notices` for the three (notification_inbox has a fixed event_type list).
- Words in five languages, English first.

Out: relay ops-API rules (whether an operator may move a key without the team) are the owner's decision; phone push.

## Tests

`tests/unit/g-hosting-copy-notices.test.ts` (the CLI commands: audit lines, owner notices, none for the backup),
`tests/unit/f-relay-key-moved.test.ts` (in-process relay: rotation → one notice per owner/admin across retries, none for
members). `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the touched unit tests.
