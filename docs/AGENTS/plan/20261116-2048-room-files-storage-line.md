# Admin storage card: a "Files in conversations" line

- Date (UTC): 2026-11-16 20:48
- Branch: `feat/room-files-storage-line`
- Status: in progress
- Where: Team AX core (`server/src/system/storage.ts`, `shared/src/api/system.ts`, `web/src/pages/admin/System.tsx`,
  `web/src/i18n/*`). Why: storage and admin are core (docs/REPOSITORY-RULES.md).
- Version impact: patch. One optional field in the storage answer, no migration, no setting.
- Parent plan: "Files sent in conversations, like Slack" (reviewed 2026-11-16), phase P1, the part not shipped in #1148.

## Goal

Owners and admins see how much of the disk the files sent in conversations take, as one line on the existing storage
card (Admin › System): "Files in conversations · 31 GB". Today those bytes are hidden inside "Team files". This is
the number the later phases (disk-nearly-full notice, "Ask people to clean up") point at.

## Scope

In:
- A new optional part `rooms` in `StorageBreakdown` (`shared/src/api/system.ts`, optional like `kept`, so an older
  server's answer still parses). Measured as the bytes under `<team>/.system/rooms` only.
- `StorageMonitor.measure` (`server/src/system/storage.ts`): `m.rooms = treeBytes(.system/rooms)`; `m.team` no longer
  includes `.system/rooms`. `known` adds `m.rooms`, so "Other" does not change. Files of AI chats
  (`.system/chat-files`) and the set-aside folders (`chat-files-orphans`, `rooms-orphans`, shown as `kept`) stay in
  "Team files" as today. The header comment says so.
- The card: `STORAGE_PARTS` gets `rooms` right after `team`; the line shows only when the server sent the field (an
  older server: no line, never "0 B" made up). Label `storage.part.rooms`: "Files in conversations" in en first, then
  ko, id, ja, es, zh, each using that language's word for a conversation (`rooms.title`).
- Mock server fixture and the existing tests.

Out: anything per person, per conversation, or a file name (hard rule: admins never see those from conversations they
are not in). No button yet (phase P3). No new card, row, menu item or setting.

Added on screen: one line in the breakdown. Removed: those bytes leave "Team files" (it drops by the same amount on
update day; the changelog says why).

## Steps

1. `shared/src/api/system.ts`: `rooms: Bytes.optional()` with a comment.
2. `storage.ts` `measure` + header comment.
3. `System.tsx`: `STORAGE_PARTS` = team, rooms, history, …; skip a part whose value is `undefined`.
4. i18n `storage.part.rooms` in six files.
5. `web/test/mock/server.ts`: `rooms` in the breakdown (and `team` lowered so the total stays).
6. Tests: `tests/unit/g-storage.test.ts`: a file in `.system/rooms` counts in `rooms`, not in `team`; "Other" does not
   grow. A web unit test (or the e2e admin spec) that the line shows with the field and is absent without it.
7. `changes/room-files-storage-line.md`, decision file `docs/decisions/20261116-room-files-storage-line.md`.

## Decisions

`docs/decisions/20261116-room-files-storage-line.md`: one number for all conversation files, never split by person or
conversation; measured hourly with the rest; AI-chat files and set-aside files stay in "Team files".

## Risks

- A team with a huge `.system/rooms` already pays for that walk today (it was inside `team`), so no extra cost.
- The number is up to an hour old and absent until the first measurement after a start, like every other line.
- In a team of three the number still shows that conversation files exist; it is the same bytes "Team files" held.

## Tests

`bun run typecheck`, `check:i18n`, `check:docs`, `tests/unit/i18n-languages.test.ts`, `tests/unit/g-storage.test.ts`
(Bun 1.3.12), the web unit suite, the admin e2e spec for the card; screenshots of the card at 1440 and 390, light and
dark, owner and admin, on the mock server.

## Result

Filled in at the end.
