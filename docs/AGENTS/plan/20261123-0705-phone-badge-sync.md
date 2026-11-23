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

In (changed after the independent plan review, see "Review" below):
1. Server: every phone push that went (or whose answer never came) is written to a ledger per phone
   (`push_phone_ledger`). A "read sync" step after each dispatch (at most every 5 s) finds the ledger's notices of the
   push day that are now read on any device, no longer told (suppressed) or deleted, using each source's own "still to
   tell" rule (so the owner's locked password check never counts as read). Each phone gets at most one silent sync
   push: the **whole** set of such ids, newest first (at most 40, fitting the gateway body), so a sync lost while the
   phone was offline costs nothing; an iPhone also gets its icon number now (`pushBadge`). It is sent only when the set
   (Android) or the number (iPhone) changed since the last sync; at most one per phone per 30 s, 100 a day, 10 a round,
   after the due pushes. An iPhone last sent a number above 0 is also checked every 15 s (a room read without a pushed
   notice). Ids and a number only, unique notification id, 24 h TTL.
   Android syncs go only to an app that registered with `sync: true` (new capability push-sync-v1, sent by the page with
   the token): an older Android app would list an empty notification for a sync while it is open.
   Migration `446_b_push_phone_sync.sql`: `push_subscriptions.sync_ok`, `push_phone_ledger`, `push_phone_sync`.
2. Gateway contract: optional `sync: true` with `clear` (ids) and the code `phone.sync`. `phone.sync` without `sync`, `clear`
   without `sync`, and `sync` with `path`, `label` or an Android `badge` are refused, so a sync can never become a visible
   notification. A gateway from before it refuses the key; the team server then sends no sync there for an hour and
   never resends it without `sync`.
3. Gateway: APNs `aps: { badge?, content-available: 1 }` (no alert, no sound), push type alert with a badge, background
   without, priority 5, collapse id `phone.sync`. FCM data-only, NORMAL priority, no title or line. Syncs have their own
   (key, token) bucket. Every FCM message now also has `data.tag` = the notice id, so a notification expo-notifications
   showed while the app was open has the notice id as its tag too.
4. Android app (`modules/push-label`): `LabelMessagingDelegate.onMessageReceived` handles `phone.sync` before
   expo-notifications: cancels the tray entries whose tag is a listed id and the group summaries left empty; shows
   nothing.
5. Both apps, foreground: the page's count 0 (sent on every return to the foreground) removes the delivered notifications
   of the kinds that count covers (room notices, AI answers, chat messages, thread replies; on Android also the ones the
   system drew without their data). File shares, access requests, schedule and owner notices stay. A sync arriving while
   the iPhone app is open is never listed.

Out (later):
- iPhone: removing delivered notifications while the app is closed (needs the remote-notification background mode and
  a headless task; iOS wakes the app only when it chooses). The sync already carries `content-available` and the ids,
  so a later app build can do it without a gateway or server change. Until then the iPhone's number is right at once
  and its list is cleaned when the app is opened.
- Per-room removal on open while some things are still unread.

## Review

Independent plan review (fresh agent, 2026-11-23): MUST items taken: an Android capability flag (old apps in the
foreground would list an empty notification), whole-set syncs instead of "each id once" (APNs/FCM keep only the last
collapsed push), unique notification ids per sync, a ledger (delivery rows are deleted with their notice), the "still
to tell" rule instead of `read_at`. SHOULD items taken: `data.tag` per notice on FCM, limit the iPhone count checks,
clear only counted kinds on open, cap syncs per round after the pushes, a separate transport path, no empty sync.

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
