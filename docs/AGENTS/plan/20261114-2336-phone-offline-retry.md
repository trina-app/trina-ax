# Phone app: the "offline / could not reach your team" screen reopens the page by itself

- Date (UTC): 2026-11-14 23:36
- Branch: `fix/qa-1115-phone-offline-retry`
- Status: in progress
- Where: mobile/ (Team AX core). Why: the phone app's own native failure screen (see docs/REPOSITORY-RULES.md: 휴대폰 → core)
- Version impact: patch, a fix in the phone app (needs a new store build: the app has no over-the-air updates)

## Goal

QA TC-2265: a push tapped with Wi-Fi off opens "Could not reach your team" / "You are offline". When the network is back
the screen stays until the person taps Try again. The exit must continue by itself: the app tries again and opens the
page they were opening (the push's chat), Try again stays for the impatient.

## Scope

In: `mobile/src/reconnect.ts` (pure: backoff 2 s, 4 s, 8 s, then every 15 s; one probe at a time; paused in the
background; at once when the app comes back to the foreground), wired into the failure screen in `mobile/App.tsx`; the
probe is the app's existing `GET /api/health` (`checkTeam`); hints say the page opens by itself (en first, ko, zh); unit
tests with fake timers and a fake probe.
Out: an OS network-change listener. The app has none in its dependencies (no netinfo, no expo-network); adding a native
module is a bigger change. The 15 s cap keeps the wait short without one.

## Steps

1. reconnect.ts + tests.
2. App.tsx: start on failure, stop when the page is back, reset the backoff on a page that loaded, wake on foreground.
3. Strings en → ko, zh; changelog fragment; typecheck, i18n, mobile tests.

## Risks

A server that answers health but fails the page (500, render process gone) would loop: the backoff is kept across
failures and only reset after a page loads. No migrations, no server change.
