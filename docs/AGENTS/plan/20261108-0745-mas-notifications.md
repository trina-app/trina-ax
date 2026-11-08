# Desktop app (macOS): ask about notifications while the window is in front

- Date (UTC): 2026-11-08 07:45
- Branch: `feat/mas-notifications`
- Status: in progress
- Where: trina-ax `desktop/` (main process, `common/notify.ts`). Why: the Mac App Store app showed no notifications,
  because macOS asked its one question at a moment nobody saw it (see docs/REPOSITORY-RULES.md)
- Version impact: patch (the desktop app asks earlier and the macOS test answer is worded truthfully; no API change)

## Goal

The Mac App Store app (bundle `app.trina.ax`, a fresh notification permission on every Mac) showed no notifications.
Checked on macOS 26.6 with Electron 44.7.2's Mac App Store runtime, sandboxed and signed, from an Applications folder:

- Electron asks macOS for notification permission the first time the app touches notifications
  (`NotificationPresenterMac` asks when it is created: the first `new Notification()` or `Notification.isSupported()`).
  In this app that is the first notification, and notifications are only made while the window is NOT in front
  (`common/notify.ts` `notify`). So the question comes while the person is in another app.
- macOS asks once. The question stays only while the app runs: an app that quits before the person answers is left with
  "Allow notifications" off (System Settings › Notifications › Trina AX), and macOS never asks again.
- While the question waits, notifications go to Notification Center quietly (no banner).
- With notifications off, Electron still reports `show` (the system takes the request without an error). So the app,
  and Settings › Notifications › "테스트 알림", say a notification was shown when nothing was.

The sandbox and the entitlements are not the cause: local notifications need no entitlement, and a sandboxed MAS
build shows them once allowed. The Dock badge shows with notifications off too.

What changes for the person: the system's question appears right after a team page opens in the app (the window in
front), where they see it. The test notification on a Mac says "sent; if you do not see it, turn it on in System
Settings › Notifications › Trina AX" instead of claiming it was shown.

## Scope

In:
- `makeNotifier().ask()`: touches the system's notifications once per app run, only while the window is focused.
  `AppWindow` calls it when a team page has loaded and when the window gets focus with a team open. macOS only
  (`Notification.isSupported()` creates Electron's presenter, which asks); elsewhere it does nothing.
- macOS: the test notification answers `unknown` (the existing words "테스트 알림을 보냈어요. 보이지 않으면 …에서 켜
  주세요.") when the system took it, because taking it does not mean it shows. `failed` stays `off`. Windows keeps
  `shown`.
- Unit tests in `tests/unit/e-notify.test.ts`; the Mac App Store README gets one line on where a person turns
  notifications on; DECISIONS "Session markers" gets a bullet.

Out:
- Reading the permission state: Electron 44 has no API for it. `Notification.getHistory()` would show whether the test
  was delivered, but its restored objects share identifiers with live notifications, and Electron hands a click to the
  first match, so a real notification's click could stop opening its room. Not used.
- People whose permission is already off (every 0.2.14 store install that missed the question): macOS does not ask
  again; they turn it on in System Settings. The test notification's line tells them where.

## Steps

1. `common/notify.ts`: `NotifierDeps.ask?()`, `NotifierDeps.showIsSeen?` (default true), `Notifier.ask()`; the test
   maps `show` to `unknown` when `showIsSeen` is false.
2. `main/app-window.ts`: pass `ask` (darwin: `Notification.isSupported()`) and `showIsSeen: process.platform !== 'darwin'`;
   call `this.notifier.ask()` after the team page loads and on focus while a team is open.
3. Tests, README line, DECISIONS bullet.

## Risks

- The question appears at the team's sign-in page on a first run, before sign-in. That is what a desktop chat app
  does; it works with every team server version (older pages never call the newer bridge parts).
- Asking once per run is harmless: once answered, macOS shows nothing.
- No migration, no server or web change, no new UI words.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun test tests/unit/e-notify.test.ts` and the
other desktop unit tests (`tests/unit/e-*.test.ts`). A local sandboxed Mac App Store development build against a local
server with fake data: the question at the team page, a room notification while the window is in the back, a click
opens the room, the Dock badge.

## Result

(to fill in)
