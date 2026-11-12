# The phone app's icon badge: the one count n on the app icon

- Date (UTC): 2026-11-12 13:52
- Branch: `feat/phone-app-badge`
- Status: in progress
- Where: trina-ax `mobile/` (bridge `badge-v1`, permission), `web/src/store/sessionMarkers.ts` (sender), `server/src/notifications/` (count in the native push), `shared/src/cloud-protocol/push-gateway.ts` + `push-gateway/` (optional `badge`). Why: the phone app never set a badge; the count, the bridge, the server push and the gateway are all common code of this repo (no edition part).
- Version impact: minor, a new optional bridge capability, an optional gateway field and a new app behaviour (iOS build 10); older apps, pages, servers and gateways keep working.

## Goal

The owner (2026-11-12): "ios 에서 누가 dm이 오거나 알림이 울려나 뱃지가 뜨지 않던데 왜그런거지?? notif권한은 줬었는데". The phone app
asks iOS without badge permission (`allowBadge: false`), the foreground handler never sets one, and the server's native
push carries no count. The app icon should show the same n as the tab title, the Dock and the installed web app
(`store/sessionMarkers.ts` `currentCount`: chats and rooms that want me, each once, never a hidden room).

## Scope

In:
1. App: iOS permission asks for badges too (`allowBadge: true`), and once, silently, for people who granted before
   (no prompt; iOS decides). Optional capability `badge-v1`: the page sends `{type:'badge', count}` (integer 0–9999,
   validated on both sides); the app calls `setBadgeCountAsync(count)` (errors caught) and answers whether iOS shows
   badges (`badgeOff`). 0 on sign-out and team change. Foreground pushes keep `shouldSetBadge: false`.
2. Web: where the PWA badge is set, also send n to the app when `badge-v1` is there: when n changes (WEB_BADGE_MS),
   at start, when the app comes to the foreground, after a bridge/session reset, and 0 on sign-out. Settings › 알림 shows
   the existing badge line on the phone app when iOS says badges are off.
3. Server: `notifications/badge.ts` `badgeCount(db, userId)`: the rooms that want the person (the web's roomWantsMe
   rule from the server's own unread, mention, followed-thread and level data; never hidden, never off, never archived)
   plus the AI chats that need them (an unseen answer of their own listed chats not running, or a card waiting on them:
   the chat runtime's word through a hook). Sent as an optional `badge` in the native payload, computed at send time.
4. Gateway: optional `badge` (integer 0–9999) in the contract; APNs `aps.badge`; FCM `android.notification.notification_count`.
   Older servers that omit it keep working; ids and counts only.

Out: a silent push to lower the badge after reading elsewhere (v1: none; the app sets the exact n on open and
foreground; reasons in the PR). Android launcher numbers beyond what the system does with notification_count.

## Steps

1. Plan (this file).
2. Protocol + gateway: `badge` in `PushGatewaySend` (parse, keys), APNs and FCM payloads, gateway tests.
3. Server: `badge.ts`, chat-runtime hook, push-service/push-native carry `badge`; unit tests.
4. App: `BADGE_CAPABILITY`, `parseMessage` case, receiver, `push.ts` permission + `setBadge`, App.tsx wiring, 0 on
   sign-out/team change; bridge tests.
5. Web: `setAppBadgeCount` in `lib/mobile.ts` (small, at the end, like `setAppNav`), sender in `sessionMarkers.ts`,
   Settings line; unit tests; i18n in 5 locales if a new line is needed.
6. Docs: `mobile/README.md`, `push-gateway/README.md`, `changes/phone-app-badge.md`. Decision text in the PR body.
7. Checks, draft PR, ready.

## Risks

- iOS: people who granted alert+sound without badge are not prompted again; the silent re-request may leave badges
  off. The Settings line tells them where to turn on 배지.
- An older app (before build 10) gets `aps.badge` from a new gateway: without badge permission iOS ignores it; with it
  (none asked so far) it would show the server's n, never reset by that app. Checked and noted in the PR.
- Performance: the count runs a few queries per room and per recent chat for each native push (at most 10 a tick).
- Collisions: `web/src/lib/mobile.ts` (photo-picker follow-up), `appNav.ts`/`SettingsDialog` (TC-404),
  `PushNotifications.tsx` (settings wave): small separate hunks only.
- No migration.

## Tests

`bun run typecheck`, `cd mobile && npx tsc --noEmit`, `bun test tests/unit/mobile-*.test.ts web/test/unit/mobile.test.ts`,
`bun test tests/unit/push-gateway*.test.ts tests/unit/push-native.test.ts`, the new server count test, the web sender
test, `bun run test:web`, `bun run check:i18n`, `bun run check:docs`, `bun run build:web`.

## Result

Filled in at the end.
