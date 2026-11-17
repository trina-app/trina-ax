# The disk is filling: a notice kept in the Inbox, and a refused upload that says who can help

- Date (UTC): 2026-11-16 21:05
- Branch: `feat/storage-full-notices` (on top of `feat/room-files-storage-line`, PR #1156: the notice names the
  "Files in conversations" number)
- Status: done
- Where: Team AX core (`server/src/system/storage.ts`, `server/src/system/ops.ts`, `server/src/notifications/`,
  `server/migrations/`, `server/src/uploads/sessions.ts`, `shared/src/api/notifications.ts`,
  `web/src/components/settings/Notifications.tsx`, `web/src/components/rooms/RoomComposer.tsx`, `web/src/i18n/*`).
  Why: storage, notifications and conversations are core (docs/REPOSITORY-RULES.md).
- Version impact: minor. Migration 702 (one new notice table, additive, reader 1).
- Parent plan: "Files sent in conversations, like Slack" (reviewed 2026-11-16), phase P2.

## Goal

Today, from 80 % full, owners and admins who are online get a toast once a day, and nothing is kept: an admin who was
away never hears of it. And when the disk is full, everyone who sends a file in a conversation reads "The storage is
full. Empty the trash or clean up files.", though a member can do neither.

After this: owners and admins find a notice in their Inbox at 80 % and again at 95 %, which opens the storage card. A
refused file in a conversation says plainly who can help: a member or guest is told to ask an admin; an owner or admin
gets a link to what takes the space.

## Scope

In:
1. **Table** `storage_notices` (migration `702_g_storage_notices.sql`, component G = storage), the standard notice
   columns plus `percent INTEGER`, `rooms_bytes INTEGER`, `by_user TEXT` (all nullable). Its `event_type` CHECK lists
   `'storage.filling'` and `'storage.cleanup'` (the second is for phase P3, "Ask people to clean up", so P3 needs no
   new table; tables are never rebuilt, so the CHECK is set once). This PR sends only `storage.filling`.
2. **Sending.** `StorageMonitor.checkAlert` (every 10 minutes, `system/ops.ts:935`) gets a new option
   `record(percent, threshold, roomsBytes)`. From 80 % (the plan's view, the same percent as the toast) it records one
   notice per active owner and admin (`role IN ('owner','admin')`, so never a guest or member): threshold 95 when the
   percent is 95 or more, else 80. At most once per 24 h for each threshold, kept in the settings table
   (`system.storageNoticeAt.80`, `system.storageNoticeAt.95`) across restarts, independent of the toast's key. So: 80 %
   today, 95 % an hour later is told too; 96 % tomorrow is told again. `roomsBytes` is the last measured
   `breakdown.rooms` (null before the first measurement). Nothing is recorded for a dip under 80 %. Today's toast and
   its `storage.warn` audit stay as they are.
3. **Notifications plumbing** (the pattern of `engine.start_failed`, 3fcbb4274): `NotificationEventType` +
   `'storage.filling'`; `tableOf`, `NOTICE_TABLES` (listed, counted, read/unread, 30-day retention, all from that list);
   `eventEnabled` returns true (shown always: there is no setting, like the hosting and engine notices; so the
   notification settings page gets no new row); `account-removal.ts` + `storage_notices.user_id`; a `storageNotice`
   method; `toItem` gives `link: 'admin_storage'` and `storage: { percent, roomsBytes }`. No push, no e-mail.
4. **Inbox words** (`noticeText`, `noticeLink`): "Storage is 82% full. See what takes space." or, when the number was
   measured, "Storage is 82% full. Files in conversations take 31 GB. See what takes space." The row opens
   `/admin/system/storage` (a phone's storage page; a computer lands on the card at `#system-storage`).
   `link` enum gets `'admin_storage'`.
5. **Refused file in a conversation** (`RoomComposer.tsx`, both the upload and the team-file copy paths). A refusal
   for space is 507 `storage_full`, or 413 from an upload session made on a disk without room (`uploads/sessions.ts`
   `diskFull`; this PR adds `params: { reason: 'disk_full' }` there so it is told apart from the 1 GB refusal, which
   has `reason: 'room_file_too_large'`). Its chip says, by role:
   - member or guest: "The team's storage is full, so this file can't be sent. Ask an admin to free some space."
   - owner or admin: "The team's storage is full, so this file can't be sent." and a link **See what takes space**
     (`/admin/system/storage`); a hosted team's "Choose a plan" link stays beside it.
   The shared `storage_full` sentence is unchanged for every other place (Files page, AI chat attachments).

Out: members are not told ahead (they can do nothing about it). No push. "See the files you sent" for members comes
with phase P3. No change to when a refusal comes (see Risks).

Added on screen: one Inbox notice kind (owners/admins); one link on a refused chip (owners/admins). Removed: for
members and guests in a conversation, "Empty the trash or clean up files." (they could do neither).

Plan change from the parent plan: "Ask {owner's name}" becomes "Ask an admin": the page has no owner's name for a member
or guest today, and "Ask an admin" is what the other member screens say (`integrations.discover.askAdmin`,
`connectors.step.askAdmin`).

## Steps

1. Migration 702 + comment.
2. `storage.ts`: `record` option, the two keys, the threshold rule; `ops.ts` wires it to `notifyStorageFilling(ctx, …)`
   in `notifications/service.ts`.
3. Notifications plumbing (shared enum + link + `storage` field; service; preferences; account removal).
4. Web: `noticeText` / `noticeLink`, i18n `notifications.event.storage.filling` + `…filling.rooms` in six languages;
   `rooms.storageFull.member`, `rooms.storageFull.admin`, `rooms.storageFull.see` in six languages.
5. `RoomComposer.tsx`: a `storageFull(e)` check and a `full` flag on `RoomUpload` that picks the words and the link.
6. Docs: `docs/site/*/use/admin.md` (the notice), the conversations help page in six languages (what a full disk
   says), `scripts/docs/api-reference.ts`/`docs:api` if the endpoint summary lists notice kinds, decision file,
   `changes/storage-full-notices.md`.

## Decisions

`docs/decisions/20261116-storage-full-notices.md`: stored notice at 80 % and 95 %, owners and admins only, Inbox only,
once a day per threshold; the role-aware refusal; the table holds the P3 kind.

## Risks

- Migration number: 702 (G's range 700–799; 701 is the highest on dev). `check:migrations`.
- A tab older than the server parses `/api/notifications` with the old enum and would fail on the new kind; the page
  reloads itself when the server reports a new version (`web/src/lib/chunk-reload.ts`), as for every earlier kind.
- When the refusal comes is unchanged: a large file is refused when its upload session is made; a file of up to 50 MB
  after its bytes arrive; a disk that fills while a file is on its way can still fail it midway.
- The 413 `disk_full` path exists only where the storage guard is off (a Mac without a plan); there the shared words
  were "The server is running out of disk space."
- `checkAlert` runs on every server, including a Mac; the 80 % there is the plan view or the real disk.

## Tests

- Server (Bun 1.3.12): `tests/unit/g-storage.test.ts`: 80 % records one notice per owner and admin, none for a member
  or guest; not again within 24 h; 95 % records again the same day; a notice carries the measured rooms bytes; the
  notice lists in the Inbox with `link: 'admin_storage'`; account removal clears it. `tests/unit/uploads-*` or the
  sessions test: the 413 carries `reason: 'disk_full'`.
- Web unit: `noticeText`/`noticeLink` for the kind (with and without the number, en + ko); the composer's refusal words
  by role (member, guest, admin; 507 and 413 disk_full; a 413 too-big keeps its own words).
- Checks: `bun run typecheck`, `check:i18n`, `check:docs`, `check:migrations`, `tests/unit/i18n-languages.test.ts`,
  the notifications and rooms server tests, the full web unit suite.
- Real: the mock server (a notice in the Inbox; a refused chip by role) at 1440 and 390, light and dark; a local server
  copy with a plan file whose disk makes it 80 % / 95 % full, to see the stored notice arrive.

## Result

Built, with these changes after the spec review (a fresh subagent against current code):
- `by_user` is listed in account removal's columns without a foreign key (kept, named only while active).
- The 413 `disk_full` also carries the plan's page; `storagePlansUrl` accepts it (on a small hosted disk the session's
  1 GB margin can come before the guard's reserve, so it is not only a Mac's path).
- A 95% notice holds back the 80% one; a new notice marks the older unread one read; the percent is rounded like the
  card; the monitor's clock is passed through.
- Someone no longer an admin gets the plain words only (no number, no link).
- Words: "There isn't enough space on the team's storage for this file" (the guard refuses one write, not all), and
  "See what uses the space" (the toast's and the AI error's words). The links sit in the same line of text as the
  reason, so a phone's chip wraps them (the first try put them beside it and crushed the chip at 390).
- Activity, not "Inbox", in the docs (the screen's name). No row in Settings › Notifications and not in the Requests
  filter (written in the decision).
- Corrections to this spec: the reload on a new server version is components/Layout.tsx `UpdateWatcher`; the function
  is `out`; a file from the computer goes in one request only up to 8 MB.
Real check: a copy of the QA team on port 19821 with a 5 GB plan file (the Mac's disk far over it, so writes are
refused and the disk reads 100%).
