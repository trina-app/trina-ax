# Leaving a team on the phone signs out of it

- Date (UTC): 2026-11-12 02:08
- Branch: `fix/phone-leave-signs-out`
- Status: done
- Where: `mobile/`. Why: the phone app's team switch is phone code; the server's sign-out endpoint is already there.
- Version impact: patch, a fix in the phone app (ships with the next phone build)

## Goal

QA TC-369: switching from team A to team B on the phone removed only A's push device. A's session stayed in the
WebView's cookies, so switching back opened A signed in without a password. Leaving a team now signs out of it.

## Scope

In:
- At the switch, the old team's page (still mounted under the switch box) clears its web storage and readable cookies
  and posts `/api/auth/logout` with its own session; the app waits a few seconds for the answer.
- The app then clears the WebView cookies on the phone (React Native's Networking `clearCookies`: Android's shared
  CookieManager) and the WebView's storage (`clearCache(true)`; on iOS this removes local storage and IndexedDB too).
- A sign-out that got no answer (server unreachable, or the cannot-reach screen had no page) is remembered; the next
  time the phone opens that team, its first page signs out first (the reinstall sign-out, with storage cleared too).
- Switch text: "You'll be signed out of {old} on this phone, and its notifications will stop." (en, ko).

Out: a native iOS module to drop WKWebView cookies without the server (the remembered sign-out covers the next visit).
On iOS the app's own clearing never reaches the WKWebView cookie store, so there only the server's 204 within 4 s
removes the cookie at the switch.

## Steps

1. `mobile/src/leave.ts`: the leave script, its answer, the remembered sign-outs (pure, tested).
2. `mobile/App.tsx`: TeamWeb offers the sign-out to App; `leave()` uses it, clears cookies and storage, remembers it.
3. Strings, unit tests, changelog fragment.

## Risks

Phone only, no server or migration change. The cookie clear removes every WebView cookie: the phone holds one team at
a time, and it runs before the new team's page loads. iOS with an unreachable old server keeps the cookie until the
next visit to that team, whose first page signs out.

## Result

Built as planned: `mobile/src/leave.ts`, `leave()` and TeamWeb in `mobile/App.tsx`, the remembered sign-out reuses
`ReinstallSignOut` with storage clearing, switch text in en and ko. Unit tests and the mobile typecheck pass; not yet
tried on a phone (QA with the next phone build).

After review: the owed sign-out keeps the page the person opened (an invite link) and reloads it on 204 instead of
going to /login; a leave sign-out always resolves (LeaveAsk) and only one switch runs at a time; Cancel / Back / Android
back are off while the switch waits; the sign-out is owed before the new team is saved (taken back if the save fails).
React Native exposes no CookieManager flush on Android.
