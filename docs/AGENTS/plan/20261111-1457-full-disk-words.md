# A low or full disk is said plainly and the same way everywhere

- Date (UTC): 2026-11-11 14:57
- Branch: `fix/full-disk-words`
- Status: done
- Where: `server/` (system storage and backups, the API error handler, chat turns), `shared/src/api/errors.ts`, `web/`
  (the storage card and the chat error words). Why: storage, backups and errors are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch — clearer words and status codes for an existing state; no new feature or setting

## Goal

QA TC-209 (on a 600 MB data volume):

1. Admin › 시스템 showed the storage bar `592 MB 남음` with a green `여유 있음` while the disk check right below failed
   ("space is almost gone"): the card uses the percent levels, the check (Mac / dev) an absolute floor of
   max(10 GB, 5%).
2. The backup line read `마지막 백업이 실패했어요: not enough free disk space for a backup (592 MB free, 2 GB needed)`:
   English inside Korean.
3. With the disk full, a question ended with the engine-crash words ("AI 엔진이 예기치 않게 멈췄어요", the real cause was
   ENOSPC), sending failed with "서버 오류가 발생했어요" and sign-in answered 500.

After this change the card and the check agree, the backup line is in the person's language, and a full disk is named
as such: "the server's storage is full; an admin has to free space".

## Scope

In:
- `StorageMonitor.status()`: where the Mac rule decides the disk check (not a Linux production install), a disk under
  its floor (max(10 GB, 5%)) is level `full`, as the check fails. One function for that floor, used by both.
- Backup health line: a backup refused for space (`disk_space`, `plan_space`) says so in the person's language, with
  what to do (the same words as the "지금 백업" job already uses).
- API errors: an error from a full disk (ENOSPC / EDQUOT, SQLite "database or disk is full") anywhere in a request
  becomes 507 `storage_full` with "서버 저장 공간이 가득 찼어요. 관리자가 공간을 비울 때까지 저장하거나 보낼 수 없어요." (five
  languages) instead of 500 "서버 오류". Sign-in, sending a message and every other write get it.
- Chat: a new answer error `storage_full` when the turn failed on a full disk (the error says so, the engine's stderr
  says "no space left on device", or the server's disk has almost nothing left when the engine crashed). The owner reads
  where to look (Admin › 시스템), everyone else that an admin has to free space.

Out:
- Freeing space automatically, or new limits.
- The Linux production rule (already percent levels in both places).

## Steps

1. `server/src/system/storage.ts`: `absoluteFloor()`, `isDiskFullError()`, `diskAlmostFull()`; the monitor's level.
2. `server/src/system/ops.ts`: the Mac check uses the floor; the backup line by reason.
3. `server/src/app.ts` onError: disk-full errors → 507 `storage_full` with the server-full words.
4. `shared/src/api/errors.ts`: chat reason `storage_full`, the server-full words; `server/src/chat/turn.ts` picks it.
5. `web/`: chat error keys (five locales), the owner's variant.
6. Tests: storage level with the floor, backup line words, onError with ENOSPC / SQLITE_FULL, the turn's reason.

## Risks

- A Mac with a big disk but under 10 GB free now shows a red card (it is at ≥ 95% anyway for any disk over 200 GB).
- Words in five languages; no developer words on member screens.
- No migration.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the system / storage / chat unit tests,
`bun run test:web`.

## Result

Built as planned. The owner's and admins' chat words point at Admin › System (admins see the storage card too), not
the owner-only health section. Tests: `tests/unit/full-disk-words.test.ts` (what counts as a full disk, the card's
level with and without the absolute rule, the backup line in ko/en, 507 for ENOSPC and SQLite full and 500 for other
errors), `tests/unit/b-full-disk.test.ts` (an engine that stops with "no space left on device" ends with
`storage_full`; fails without the change), `web/test/unit/chat-error-words.test.ts` (the admin path). On a local dev
server with its data on a 400 MB disk image: the card said `full` with the disk check failing; "지금 백업" left
"마지막 백업이 실패했어요: 디스크 공간이 부족해요(2GB 필요)…"; with the disk filled two questions ended with "서버 저장 공간이 가득 차서
답하지 못했어요. 관리자가 공간을 비워야 해요." (one from a thrown ENOSPC, one from the launcher's "no space left on device") and
saving a file answered 507 with "서버 저장 공간이 가득 차서 지금은 할 수 없어요…". Sign-in still worked on that disk (SQLite had
room in its pages), so its 507 is covered by the unit test only.
