# iPhone notifications say who and where (never the text); the gateway never sees names

- Date (UTC): 2026-11-07 08:08
- Branch: `feat/ios-notification-labels`
- Status: done
- Where: this repo: `push-gateway/`, `shared/src/cloud-protocol/push-gateway.ts` (comments only), `server/src/notifications/`,
  `shared/src/api/push.ts`, `web/src/lib/mobile*.ts`, `mobile/`. Why: phone push is core (docs/REPOSITORY-RULES.md:
  휴대폰), and the gateway, the team server, the page and the app each own one step.
- Version impact: server **minor** (a new public endpoint, new optional fields, an additive migration); phone app
  **1.0.1** (patch: a new store build, nothing removed).

## Goal

A room push on an iPhone says "Trina AX / 새 메시지가 있어요" today, because the gateway gets ids and a code only. Web Push
already shows "민준 · #마케팅 › 스레드" by fetching the notice signed in. The iPhone should show the same title, never the
message text, and the push gateway must still never see a name.

## Scope

In:

1. Gateway: APNs payload of a room code (`room.*`) adds `mutable-content: 1`; the generic `aps.alert` stays as the
   fallback (the 1.0.0 app has no extension and shows it). No new request field; older team servers keep working.
2. Server: `POST /api/push/devices/:id/label { key, notificationId }` (no session) answers `{ title, body?, roomId?,
   threadId? }` or, for every failure, the same `{}`. A per-device label key, separate from the removal key, made by the
   iPhone app (only an app offering `push-label-v1`); the page registers only its sha256 with the token (`labelHash`,
   kept as `push_subscriptions.label_hash`, migration 263), so it never crosses the bridge and never rotates per page
   load (changed after the design review; the first draft had the server mint it). Checks: key (constant time), the device row (native, current
   gateway, session alive, user active, push on), a room notice of that user that was queued for this device, unread,
   not quiet, `noticeWanted`, and the Inbox's visibility (`roomNoticeOut`: left or hidden room, deleted message,
   private preview give nothing). Rate limited per device; nothing logged. Title = Web Push's title (`roomNoticeOut`
   `label`, `plainLabel`ed, person's language); body = Web Push's body (`TEXT[code][locale]`).
3. iOS Notification Service Extension `app.trina.ax.NotificationService` from a config plugin
   (`mobile/plugins/notification-service.js`, Swift source next to it), no new dependency. It acts on room codes only,
   only when the payload's `device` equals the stored device id, calls only the stored team origin (https, no
   redirects, no cookies, 5 s), and on any failure shows what Apple delivered. Sets `threadIdentifier` to the room id.
   Shared keychain group `<team>.app.trina.ax.notifications` (both targets; the app lists its own group first so its
   other keychain items stay where they are), `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`; the app writes `{origin, deviceId,
   key}` (the key at the token request, the device id at `push-registered`; expo-secure-store 58.0.2 `accessGroup`) and
   deletes it on a team change, a sign-out, a reinstall and at a launch that finds it stale.
4. Sign-out clears delivered notifications: the page's `session-reset` says `signedOut: true` when the status is
   signed out (also an expired session and a cold start on the sign-in page) or another person's session replaced one
   (an older app ignores the field).
5. Android unchanged (no `push-label-v1`, no label key).
6. App version 1.0.1. `scripts/ios-release.sh` checks the extension's bundle id, profile and entitlements.

Out: Android labels; a label for non-room events; building or submitting the store app; deploying the gateway.

## Steps

1. This plan; a security review of the design by a separate reviewer; fixes.
2. Gateway `mutable-content` + tests.
3. Migration 263, registration with a label key's hash, the label endpoint, contract, docs page, tests.
4. Web: `labelHash` from the token reply of apps with `push-label-v1`; `signedOut` on session reset; tests.
5. App: protocol, label store, App wiring, plugin + Swift, version, release script; tests; simulator build.
6. Second independent code review; fixes; CHANGELOG, DECISIONS (native push section), README/STORE-SUBMISSION.

## Risks

- Migration number: 262 is the highest on `dev`; 263 checked again before the PR.
- Security: a public endpoint that returns names. Mitigations above; the extension reads one keychain item while the
  phone is locked (after first unlock).
- Another branch changes room visibility (`rooms/store.ts`): the endpoint calls `roomNoticeOut` (the helper a Web Push
  uses), not its own SQL.
- The extension's App ID and profile are made by automatic signing at the store build (API key, Admin).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, new `tests/unit/push-label.test.ts`,
`tests/unit/*push*` and `*notif*`, `tests/unit/push-gateway*.test.ts`, mobile typecheck and `tests/unit/mobile-*.test.ts`,
`web/test/unit/mobile*.test.ts`, the security route matrix, and an iOS simulator build of the extension.

## Result

Built as planned, with the design review's change: the label key is made on the phone and only its hash is registered
(the server does not mint it). Also from the reviews: one `{}` exit for every failure, the app's own keychain group
first and checked by the release script, the sign-out signal for an expired session, a cold start and a change of
person (told only once answered), the label item tidied at launch, deliveries tried at least once, a late registration
not handed to the app. Extra: the Android bundle file is named by the app's version. Not done: a test on a real phone
(release check), the room id from the payload for stacking when the request fails (a failure shows what Apple sent).
Checks: typecheck, i18n, docs, the push/notification/mobile/gateway/security tests, web mobile tests, mobile typecheck,
and a clean prebuild + simulator build of the app with the extension. Decision: docs/DECISIONS.md "아이폰 알림의 이름".
