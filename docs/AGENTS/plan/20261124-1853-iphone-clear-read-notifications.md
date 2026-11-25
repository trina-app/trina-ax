# iPhone: notifications read on another device leave the phone's list

- Date (UTC): 2026-11-24 18:53
- Branch: `feat/iphone-clear-read-notifications`
- Status: done
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
   - `sync_ok = 2` only for `platform: 'ios'` with `clear: true`; Android's check becomes `sync_ok < 1`. When a
     device's `sync_ok` changes at registration its recorded set (`digest`) is cleared, so an iPhone that updates the
     app gets the notices already read on its next sync.
   - An iPhone with `sync_ok = 2`: a sync goes when the set of its read notices changed (as Android: whole set, newest
     first, as many as fit next to the token: `(3000 - token length) / 103`, at most 40) or its number went down (as
     today). It carries the ids and `badge` only when the number is lower than the one last recorded; the number is
     written back only when it was sent. The race guard (a real push since the round began) stays for every iPhone sync.
     TTL stays 0 (now or never: Apple keeps one notification per app for an offline phone and a sync must never take a
     real alert's place).
   - Any other iPhone (`sync_ok` 0/1, apps up to 1.0.13): exactly as today (number only, only when it went down).
   - Transport: an iPhone sync with ids that an older gateway refuses (400 `invalid_body`) goes again at once without
     `clear` (the number alone, as today) and that gateway gets no iPhone ids for an hour (`noIosClear`, per address;
     it never turns Android syncs off). Only when the retry without `clear` is refused too does the gateway get no
     syncs for an hour (as today). With no number to send, nothing goes: the transport answers `SYNC_UNSUPPORTED` and
     `syncPhones` records the set and the read mark without counting it in the day's 100 or starting the 30 s gap.
5. iPhone app:
   - `UIBackgroundModes: remote-notification` (expo-notifications `enableBackgroundRemoteNotifications`), so iOS wakes
     the closed (not force-quit) app for a `content-available` push.
   - A native handler (new Expo module `mobile/modules/push-sync`, iOS only, an `ExpoAppDelegateSubscriber` for
     `didReceiveRemoteNotification`): for `body.code == "phone.sync"` it reads `body.clear`, asks
     `UNUserNotificationCenter` for the delivered notifications and removes those whose `userInfo.body.notificationId`
     is listed (main match; the request identifier, which iOS sets from `apns-collapse-id` for ids up to 64 characters,
     as a fallback). It calls the completion handler only after the removal (inside the callback), never shows
     anything, never touches the badge (iOS applies `aps.badge` itself while closed; in the foreground the page sets
     its own count, `shouldSetBadge: false` as today). No JS start-up and no network in the background. It runs the
     same way while the app is open (iOS calls the same delegate in the foreground), which fixes the "open app keeps
     the list" case.
   - Open app, second path (added after the simulator run): iOS may hand the open app a sync that has a number as a
     notification to present (`willPresent`, expo-notifications' handler in `src/push.ts quietForeground`) instead of,
     or next to, the delegate call. That handler, which already keeps a sync out of the list, now also calls the
     module's `clear(list)` (the same native removal). Removing the same ids twice changes nothing.
   - The app offers `push-clear-v1` only on iOS when that module is in the build.
6. Docs and notes: contract comments, `push-gateway/README.md`, `changes/iphone-clear-read-notifications.md`, QA rows.

Out:
- `thread-id` per room / removing by `threadIdentifier`: the ledger already lists every notice pushed to the phone, so
  ids cover it; grouping by room is a separate change.
- A force-quit app: iOS never wakes it for a background push; the number still follows (alert-type push with a badge)
  and the list clears on the next sync after the person opens the app again. Opening the app does not clear by itself
  (dropped in the earlier review: stale counts).
- A store build and the gateway redeploy (release steps below).

## Review

Independent plan review (fresh agent, 2026-11-24), all MUST items taken: an old gateway's refusal of iPhone ids no
longer stops Android syncs (`noIosClear` per address, `noSync` only when the retry is refused too); an iPhone sync that
only clears ids goes even when the number did not drop, and the number is recorded only when sent; the iOS completion
handler is called after the removal; "nothing to send" is `SYNC_UNSUPPORTED` and costs no budget; the iPhone id cap is
the Android one. SHOULD items taken: match on `body.notificationId` first, reset the set when `sync_ok` changes,
`sync_ok = 2` only for iOS, the throttling risk, the doc places (contract "Sync", `apns.ts`, `push-native.ts`,
`syncPhones`, `push-gateway/README.md`, `PushDeviceInput`), the extra tests. NIT not taken: checking `body.device`
against the registered device in the native handler (the id lives in the JS side's store; notice ids are unique, so a
sync of a previous team removes nothing of this one).

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

- Background pushes are throttled by iOS (a few wakes an hour, fewer in Low Power Mode) while APNs still answers 200:
  best effort. A dropped or throttled sync is made good only by the next change to the set (the whole set goes again),
  not by any later read. At most one sync per phone per 30 s and 100 a day (unchanged).
- Privacy: ids only, as every push already carries a notice id. No text.
- Battery: the handler does no network and no JS; it finishes in milliseconds.
- App Review: the background mode is used for its purpose (silent pushes).
- No migration (`sync_ok = 2`).

## Tests

`bun run typecheck`; unit: push-gateway, push-read-sync, push-native, mobile-badge, mobile tests for the new module and
config; `web/test/unit/mobile.test.ts`; `bun run check:prepush`; simulator replay with `xcrun simctl push`.

## Result

Built as in Scope after the review. Commits: plan, server/gateway/contract/page, iPhone app, open-app path.

Simulator run (2026-11-25, iPhone 17 Pro simulator iOS 26.5, Release simulator build of this branch, signed in to a
local dev server with a fake team, its gateway a local copy of this branch's gateway code that records the APNs request
instead of sending it; every recorded body replayed with `xcrun simctl push`, `sound` removed):
- The app registered with `clear: true` (`sync_ok = 2`).
- 3 DMs (Alice 2, Carol 1) delivered. Bob read Alice's DM through the API: the server sent one sync, recorded as
  `aps {badge:1, content-available:1}`, `body.clear` = Alice's 2 notice ids, push type alert, priority 5, expiry 0,
  collapse id `phone.sync`. Replayed with the app open: Alice's 2 notifications left Notification Center, Carol's
  stayed, no banner.
- A new DM from Alice, then Bob read Carol's DM: the sync listed the whole read set (Carol's id and Alice's 2 older
  ids, not the new one) with badge 1. Icon number 1 on the home screen. Replayed with the app open: Carol's left, the
  new one from Alice stayed.
- Not provable on the simulator: removal while the app is in the background. `simctl push` does not hand a
  `content-available` push to the app's delegate; it asks SpringBoard for a background-fetch launch (refused without
  the `fetch` mode, a no-op with it, checked with a simulator-only copy). The background path is iOS's documented
  remote-notification delivery and the same `PushSync.remove` the open-app run used; it needs a real iPhone (TestFlight
  1.0.14 with the redeployed gateway).

Differences from the plan: the open-app `willPresent` path above (found on the simulator: iOS presented the sync to the
open app's notification handler).
