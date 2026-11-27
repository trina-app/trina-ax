# Desktop: the "Create a team for free" check and the sign-in token exchange send no cookies

- Date (UTC): 2026-11-27 16:34
- Branch: `fix/console-probe-omit-cookies`
- Status: done
- Where: `desktop/src/main/console-signin.ts`, `tests/unit/`. Why: the console calls of the desktop app live there
  (docs/REPOSITORY-RULES.md)
- Version impact: patch. A fix to an existing check; no new feature, setting or API.

## Goal

A freshly installed 0.20.2 on one Mac stayed on the old "Join your team" screen: `GET <console>/api/app/v1/me`
(`ConsoleSignIn.probe`) was cancelled by its 5 s timeout on every retry, with no DNS lookup or connect in the net-log.

Cause: the packaged app has Electron's cookie encryption fuse on, so the first request of the default session that
reads cookies waits for the cookie store, and the cookie store waits for the "Trina AX Safe Storage" key in the macOS
keychain. On that Mac the keychain item was made by an old test build and does not trust the real app, so macOS asks
"allow?" and the request waits for the answer (there: forever, the screen was locked). Reproduced with Electron 44.7.2
and the cookie encryption fuse on: the default fetch times out, the same fetch with `credentials: 'omit'` answers 401
in 0.6 s.

The probe sends no token and needs no cookies (a 401 or 404 is the answer). The token exchange
(`POST /api/app/v1/token`, code + PKCE verifier) needs none either. The e-mail and token API calls already omit them.

## Scope

In:
- `credentials: 'omit'` on the probe and on the token exchange, so they never wait on the cookie store or keychain.
- A unit test with a stub fetch: every console call `ConsoleSignIn` makes sends `credentials: 'omit'`.

Out:
- Team-origin calls in `app-window.ts`, `direct.ts`, `updater.ts`: they use the team's app session, which the team's
  page has already opened (its cookie store is loaded before they run), and some need the team's cookies
  (`/api/me`, `/api/connect-info`). `fetchHealth` already sets `useSessionCookies: false`.
- The keychain prompt itself (Chromium's, for any app whose Safe Storage item was made by another signature).

## Steps

1. console-signin.ts: `credentials: 'omit'` on the probe and the token exchange.
2. tests/unit/e-desktop-console-signin-omit.test.ts.
3. changes/console-probe-omit-cookies.md.
4. typecheck, check:prepush, desktop unit tests, desktop/e2e/create-team.spec.ts.

## Result

Done as planned. `credentials: 'omit'` on the probe and the token exchange; the new unit test fails on 2 of 3 cases
without the change. typecheck, check:prepush, the desktop unit tests (465 pass) and desktop/e2e/create-team.spec.ts
(11 pass) are green.
