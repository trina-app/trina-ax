# Phone notifications and icon number follow reads made on another device

- Date (UTC): 2026-11-23 07:05
- Branch: `fix/phone-badge-sync`
- Status: in progress
- Where: `server/src/notifications/`, `shared/src/cloud-protocol/push-gateway.ts`, `push-gateway/`, `mobile/`. Why: the
  phone push path is core (docs/REPOSITORY-RULES.md: phone work goes to the core first).
- Version impact: patch. A bug fix: notifications already read elsewhere leave the phone; one new table, nothing removed.

## Goal

A person reads everything on the desktop app, but their phone still shows the notifications in its list and a number
on the app icon (owner report: "8", and the app shows nothing new when opened). Like Slack, reading on any device should
remove the phone's delivered notifications for what was read and set the icon's number to the true count.

## Cause (what the code does today)

- A phone push is only ever sent for something new. Nothing is sent when a notice is read: no server code, no gateway
  message type, no app code removes a delivered notification after a read elsewhere.
- iPhone: the icon number is `aps.badge` of the last push (server `push-badge.ts`). After a read on the desktop it stays
  until the next push, or until the app is opened and the page sends `badge` (badge-v1).
- Android: there is no number of our own (`setsIconNumber` is iPhone only, QA TC-408). Samsung's launcher counts the
  notifications in the tray. The app never removes tray entries except at sign-out or team change
  (`forgetDelivered`), so the count stays even after the app was opened. This is the "opened it, nothing there, still
  8" part of the report.
- Ids the phone has today: every push carries the team's notice id (`notificationId`). Android: the tray entry's tag is
  that id (gateway `android.notification.tag`, or expo-notifications' identifier = `data.tag` / the label module's
  notice id). iPhone: `apns-collapse-id` = that id and `body.notificationId`. No push carries a room/thread id for
  grouping, except the Android label module's group (room id).

## Scope

In:
1. Server: a "read sync" step in the push dispatcher (`push-service.ts`). Every 5 s it finds notices that were pushed
   to a phone (a delivery with `attempts > 0`, within the push day) and are now read or gone (`read_at` set,
   suppressed, or the notice deleted), across all push sources (rooms, AI answers, shared chats, threads, chat
   messages, files, access requests, Inbox). For each phone it sends at most one silent "sync" push: the ids to
   remove (at most 40 a push, the rest next time) and, for an iPhone, the icon number now (`pushBadge`). An iPhone is
   also synced when its count went down without a pushed notice being read (the last number sent to it is kept).
   Coalesced: at most one sync per phone per 30 s and 100 a day; a burst of reads becomes one sync. Ids already sent
   in a sync are recorded and never sent again. No text, no names, no path: ids and a number only.
   One migration (`446_b_push_phone_sync.sql`): the last number and sync time per phone, and the ids cleared.
2. Gateway contract (`shared/src/cloud-protocol/push-gateway.ts`): optional `sync: true` with `clear` (ids) and the
   code `phone.sync`. `phone.sync` without `sync`, or `sync` with `path`/`label`, is refused, so a sync can never
   become a visible notification. A gateway from before it refuses the key (invalid_body); the team server then sends
   no sync to that gateway for an hour and never resends it without `sync` (that would show the fallback line).
3. Gateway (`push-gateway/`): sync messages
   - APNs: `aps: { badge, content-available: 1 }`, no alert, no sound, `apns-push-type: alert` when a badge is in it
     (Apple: alert type is for alerts, sounds or badges), `background` without one, priority 5, collapse id
     `phone.sync`, `body: { notificationId, code, device, clear }`.
   - FCM: data-only `{ notificationId, code, device, clear: "id,id" }`, priority NORMAL, no `notification` block, no
     title/message (expo-notifications never shows a data-only message without a title or text, so an app from before
     this change ignores it).
   - Rate limit: syncs count in their own (key, token) bucket, so they never use up the real pushes' 20/min, 200/day.
4. Android app: `LabelMessagingService` handles `phone.sync` natively before expo-notifications (runs while the app is
   closed): cancels the tray entries whose tag is a listed id and the group summaries left empty. Never shows anything.
5. Both apps, foreground: when the page sends its count `badge` 0 (everything read; it sends it on every return to the
   foreground), the app removes every delivered notification. A sync arriving while the app is open is never listed.

Out (later):
- iPhone: removing delivered notifications while the app is closed. That needs the remote-notification background mode
  and a headless task (expo-task-manager), and iOS wakes the app only when it chooses. The sync already carries
  `content-available` and the ids, so a later app build can do it without a gateway or server change. Until then the
  iPhone's number is right at once, and its list is cleaned when the app is opened.
- Per-room removal on open while some things are still unread (needs a bridge message and a page change).

## Steps

1. Plan (this file), independent review.
2. QA rows.
3. Contract + gateway + tests (`tests/unit/push-gateway.test.ts`).
4. Migration, server sync step, transport (`push-native.ts`), tests (new `tests/unit/push-read-sync.test.ts`).
5. Android native handler, app foreground clear, mobile tests (`tests/unit/mobile-badge.test.ts`,
   `mobile-push-label-android.test.ts`).
6. `changes/phone-badge-sync.md`, typecheck, unit tests, `tests/security`, `check:prepush`, PR into dev.

## Decisions

None new beyond this plan; extends docs/DECISIONS.md "휴대폰 앱 아이콘의 숫자" (the number) and
docs/decisions/20261121-android-push-who-where.md (the Android messaging service).

## Risks

- Deploy order: the server sends syncs only to a gateway that accepts them; before the gateway is redeployed nothing
  changes. **Needs a push-gateway redeploy** for anything to happen, and **new app builds** for Android tray removal
  (both platforms for the clear-on-open). The iPhone number fix works with today's iPhone app once server and gateway
  are updated.
- Privacy: a sync carries notice ids and a number only, as every push already does.
- Battery / provider rules: no alert, priority 5 (APNs) / NORMAL (FCM), at most one per 30 s per phone.
- Gateway budget: syncs have their own per-phone bucket.
- Migration number: 446 (highest on dev: 445).

## Tests

`bun run typecheck`, unit: push-read-sync (new), push-gateway, push-badge, push-native, mobile-badge,
mobile-push-label-android; `tests/security`; `bun run check:prepush`. Real phone: an Android build on the test phone
if one can be built here.

## Result

(filled in at the end)
