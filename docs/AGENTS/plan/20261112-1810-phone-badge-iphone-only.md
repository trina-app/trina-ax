# The phone app sets the icon number on the iPhone only

- Date (UTC): 2026-11-12 18:10
- Branch: `fix/phone-badge-iphone-only`
- Status: done
- Where: Team AX core (`mobile/src/`). Why: the phone app is core (docs/REPOSITORY-RULES.md).
- Version impact: patch. Android stops setting a number; iOS unchanged.

## Goal

QA TC-408 on a Galaxy Note10 (One UI 4, Android build 10): the app's number (#620) showed only while a notification was
in the tray, and expo-notifications' `setBadgeCount(0)` on Android cancels every notification of the app and never
clears Samsung's number, so the number stuck after reading and sign-out, and a 0 wiped the tray.

## Scope

In: the app sets the icon number on the iPhone only (`setsIconNumber`); Android never calls `setBadgeCountAsync`,
also not the 0 at sign-out or team change, and keeps the launcher's own count of the tray. badge-v1 stays offered; on
Android the message is taken and does nothing. Tests, DECISIONS, mobile README, changelog.
Out: server and gateway (Android pushes already carry no number).

## Steps

1. `mobile/src/badge.ts` `setsIconNumber`, used by `appBadge` in `mobile/src/push.ts`.
2. `tests/unit/mobile-badge.test.ts`; docs.

## Risks

None beyond Android: ships with Android build 11; iPhone builds behave as before.

## Result

As planned.
