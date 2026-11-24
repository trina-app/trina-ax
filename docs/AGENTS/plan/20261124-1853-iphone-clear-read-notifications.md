# iPhone: notifications read on another device leave the phone's list

- Date (UTC): 2026-11-24 18:53
- Branch: `feat/iphone-clear-read-notifications`
- Status: in progress
- Where: `server/src/notifications/`, `shared/src/cloud-protocol/push-gateway.ts`, `shared/src/api/push.ts`,
  `push-gateway/`, `web/src/lib/mobile.ts`, `mobile/`. Why: the phone push path is core (docs/REPOSITORY-RULES.md).
- Version impact: patch. A bug fix: a notification already read elsewhere leaves the iPhone's list as it does on
  Android; no new screen, nothing removed, old apps and old gateways keep working as today.

## Goal

QA TC-8979: a person reads a chat on the desktop. Android already takes that chat's delivered notifications off the
tray (the sync push carries the notice ids, plan 20261123-0705-phone-badge-sync). The iPhone only gets
`aps {badge, content-available:1}` with no ids, and the app has no background notification mode, so the read
notifications stay in the iPhone's list while other chats are unread. With the app open even `badge:0` leaves the list
as it is. Like Slack, reading on any device should take those notifications off the iPhone too (closed app and open
app), and the icon number keeps following as today.

## Scope

In:
1. Contract (`shared/src/cloud-protocol/push-gateway.ts`): `clear` is allowed for `platform: 'ios'` too (still only
   with `sync: true`). APNs payload of a sync: `body.clear` = the ids joined by `,` (as FCM `data.clear`), next to the
   optional `aps.badge` and `content-available: 1`. Push type stays alert with a badge, background without; priority 5;
   expiry 0; collapse id `phone.sync`. Still no alert, no sound, no path, no label. The 4096-byte provider check stays.
2. Gateway (`push-gateway/src/apns.ts`): put `clear` in the sync's `body`. Nothing else changes. Needs a redeploy
   (owner's OK) before any iPhone gets ids; until then the team server falls back (step 4).
3. Registration: a new app capability `push-clear-v1` (the app has the native handler below). The team's page then
   registers the device with `clear: true` (`PushDeviceInput`, optional; only a page of the same server sends it). The
   server stores `push_subscriptions.sync_ok = 2` (no migration: the column is an integer; 0 none, 1 takes syncs, 2 an
   iPhone that also takes notices off its list).
4. Server (`push-service.ts` `syncPhones`, `push-native.ts`):
   - An iPhone with `sync_ok = 2`: a sync goes when the set of its read notices changed (as Android, whole set, newest
     first, as many as fit) or its number went down (as today). It carries the ids and, only when lower than the number
     last sent, `badge`. TTL stays 0 (now or never: Apple keeps one notification per app for an offline phone and a
     sync must never take a real alert's place). A sync lost while offline is made good by the next read (whole set).
   - Any other iPhone (`sync_ok` 0/1, apps up to 1.0.13): exactly as today (number only, only when it went down).
   - Transport: an iPhone sync with ids that an older gateway refuses (400 `invalid_body`) goes again at once without
     `clear` (the number alone, as today) and that gateway gets no iPhone ids for an hour (like `badge`/`label`). If
     there is no number to send, nothing goes and the transport answers 204 (the server remembers the set so it does
     not try again every 30 s and use up the day's 100). Android is unchanged.
5. iPhone app:
   - `UIBackgroundModes: remote-notification` (expo-notifications `enableBackgroundRemoteNotifications`), so iOS wakes
     the closed (not force-quit) app for a `content-available` push.
   - A native handler (new Expo module `mobile/modules/push-sync`, iOS only, an `ExpoAppDelegateSubscriber` for
     `didReceiveRemoteNotification`): for `body.code == "phone.sync"` it reads `body.clear`, asks
     `UNUserNotificationCenter` for the delivered notifications and removes those whose request identifier (the
     `apns-collapse-id` = the notice id) or `userInfo.body.notificationId` is listed. Never shows anything, never touches
     the badge (iOS applies `aps.badge` itself), calls the completion handler at once. No JS start-up in the background.
     It runs the same way while the app is open (iOS calls the same delegate in the foreground), which fixes the
     "open app keeps the list" case.
   - The app offers `push-clear-v1` only on iOS when that module is in the build.
6. Docs and notes: contract comments, `push-gateway/README.md`, `changes/iphone-clear-read-notifications.md`, QA rows.

Out:
- `thread-id` per room / removing by `threadIdentifier`: the ledger already lists every notice pushed to the phone, so
  ids cover it; grouping by room is a separate change.
- A force-quit app: iOS never wakes it for a background push; the number still follows (alert-type push with a badge)
  and the list clears on the next sync after the person opens the app again. Opening the app does not clear by itself
  (dropped in the earlier review: stale counts).
- A store build and the gateway redeploy (release steps below).

## Steps

1. Plan (this file) as the first commit; independent plan review.
2. QA rows (TC sheet).
3. Contract + gateway + tests (`tests/unit/push-gateway.test.ts`).
4. API field, page registration, server sync and transport + tests (`tests/unit/push-read-sync.test.ts`,
   `web/test/unit/mobile.test.ts`).
5. iPhone module, background mode, capability + tests (`tests/unit/mobile-*.test.ts`).
6. Simulator: build the app, replay the captured payloads (local server, fake team, local gateway copy recording
   instead of sending to Apple, `sound` stripped) with `xcrun simctl push`: closed app and open app.
7. `changes/`, typecheck, unit tests, `check:prepush`, PR into dev.

## Release steps (after merge)

- Server: any team server release with this PR. Alone it changes nothing for iPhones until both below happen.
- Gateway: push.trina.app redeploy (owner's OK). Old team servers keep working (they never send iPhone `clear`).
- iPhone app: a store build (1.0.14) with the module and the background mode; App Store review sees a new
  `remote-notification` background mode (reason: removing notifications read on another device).
- Order does not matter: a new server with an old gateway sends the number alone; an old app ignores `body.clear`.

## Decisions

None new; extends plan 20261123-0705-phone-badge-sync ("Out (later)": iPhone removal) and docs/DECISIONS.md
"휴대폰 앱 아이콘의 숫자".

## Risks

- Background pushes are throttled by iOS (Low Power Mode, many pushes): best effort, as Android's NORMAL priority.
  At most one sync per phone per 30 s and 100 a day (unchanged).
- Privacy: ids only, as every push already carries a notice id. No text.
- Battery: the handler does no network and no JS; it finishes in milliseconds.
- App Review: the background mode is used for its purpose (silent pushes).
- No migration (`sync_ok = 2`).

## Tests

`bun run typecheck`; unit: push-gateway, push-read-sync, push-native, mobile-badge, mobile tests for the new module and
config; `web/test/unit/mobile.test.ts`; `bun run check:prepush`; simulator replay with `xcrun simctl push`.

## Result

(filled in at the end)
