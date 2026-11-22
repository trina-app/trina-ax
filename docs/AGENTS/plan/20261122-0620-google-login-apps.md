# Sign in with Google from the desktop app and the phone app

- Date (UTC): 2026-11-22 06:20
- Branch: `feat/google-login-apps` (parts C and D of [the umbrella plan](20261122-0454-google-login.md))
- Status: in progress
- Where: trina-ax (`server/src/auth/google-login.ts`, `shared/src/api/auth.ts`, `web/src/pages/Auth.tsx`, `desktop/`,
  `mobile/`). Why: the Google step must run in the system browser (Google refuses embedded windows with
  `disallowed_useragent`), and the result has to come back into the app's own sign-in.
- Version impact: minor. One endpoint, one optional start field, one add-only migration, a desktop bridge flag and a
  phone bridge capability; password sign-in and the web's Google sign-in do not change.

## Goal

People who connected their Google account (A1, Settings › Security in a browser) press **Sign in with Google** in the
Mac/Windows/Linux app or the phone app and are signed in there, without typing a password. The system browser that
does the Google step is never signed in.

## Scope

In:
- Server: an app sign-in bound to a secret the app keeps (the RFC 8252 / PKCE shape), not to a cookie. Google's return
  in the system browser makes a one-time code and sends it to the app; only the app's secret redeems it.
- Desktop (C): the button when the bridge says it can (`googleSignIn` flag), Google in the system browser, the
  `/login/google#code=` link for the team on screen without screen ④, redeemed in the team's window.
- Phone (D): bridge capability `google-signin-v1`, expo-web-browser `openAuthSessionAsync`, redeemed by the WebView page.
- The web sign-in page picks per client: web = A1's cookie flow; desktop and phone = the app flow when their flag is
  there. Six languages.

Out:
- **Connecting** a Google account from inside an app. Settings › Security keeps it web-only this round (A1 already
  hides Connect in the apps). A person connects once in a browser, then signs in with Google anywhere. The app connect
  (the held-then-claim pattern of the connectors) is a follow-up.
- Broker mode (part B): the app flow uses the same settle, so it works there once B lands; not tested here.

## How it works

- Start: the app's sign-in page makes a random secret (32 bytes, base64url), keeps it in that team page's
  `sessionStorage` with `next`, and sends only `appSecretHash` (SHA-256, hex) with `client: 'desktop' | 'mobile'` to
  `POST /api/auth/google/start`. The flow keeps the hash in `binding_hash` (for the web it is the binding cookie's
  hash) and `client` (migration `133_a_google_signin_apps.sql`). No binding cookie for app flows. The app start does
  not need the page to be at Google's return address (an office LAN address works): nothing is bound to a cookie.
- Return (`/api/integrations/google-drive/callback`, A1's settle): the same checks (state once, expiry, client
  unchanged, PKCE, id_token claims) minus the browser binding for app flows. It never signs the browser in. The account
  found by `sub` gets a one-time code in `google_signin_codes`: 32 random bytes, only its SHA-256 kept, 5 minutes,
  one use, the Google `sub`, the client kind and the secret's hash. A newer code for the same Google account voids the
  older one.
  - Desktop: a small page (own style, CSP, no-store) names the Trina account, says "open only in your own app", and
    opens `trina-ax://open?url=<team>/login/google#code=<code>` by itself and by a button. The code is only in the
    fragment. A refusal (not connected, account off, temporary password, cancelled, expired) is said on that page.
  - Phone: a 302 to `trina-ax://google-signin#code=<code>` (or `#error=<reason>`), the address the auth session waits
    for, so the session closes and the app gets it.
- Redeem `POST /api/auth/google/redeem { code, appSecret, client }` (public, cookie mode, CSRF like every cookie POST):
  refuse a malformed, unknown, used or late code, a wrong secret or another client kind (410, counted per IP like
  other tokens; a wrong secret or client spends the code), an app signed in as someone else (409, the code stays, the
  app-signin rule), a Google account no longer connected, an account turned off, deleted, a guest or under a forced
  password change. Then `AuthService.signIn` with that client. Audit `auth.login` with `method: 'google'`.
- Desktop: `bridge:info` says `googleSignIn: 1`; the preload exposes it. The page opens Google with `window.open`
  (the window handler sends it to the system browser) and shows "Continue in your browser". The main process takes
  `trina-ax://open?url=<team>/login/google#code=…` only for the team on screen (its address or the office address the
  window shows), loads `<shown origin>/login/google#code=…` in that team's window (its partition, its sessionStorage),
  and the page redeems with its secret, then takes the fragment out. The office (LAN) address keeps the session the
  same way app-signin's does: `loadOrigin` copies the cookie to the other address when the window switches. An update
  restart never reopens `/login/google`.
- Phone: `google-signin` message `{ url }` (Google's authorization address only) → `openAuthSessionAsync(url,
  '<scheme>://google-signin')` → the reply carries `{ googleCode }` or `{ googleError }` or a cancel. The page redeems
  in the WebView, so the cookie lands in the WebView's own store. `team-link.ts` keeps refusing links with a fragment;
  the App's link handler never reads `google-signin` (not `open`).

## Steps

1. Plan (this commit).
2. Server: migration 133, start field, settle branch, code table, redeem endpoint, sweeper, account cleanup, demo
   fence, security matrix, http-api docs, unit tests.
3. Web: per-client decision, app start and `/login/google` page, phone bridge call, six languages, unit tests.
4. Desktop: bridge flag, link reader (`googleSignInCode`), window load, resume guard, unit tests.
5. Phone: protocol capability and message, receiver, App wiring, tests.
6. Decision file superseding the relevant part of `docs/decisions/20261116-desktop-first-onboarding.md`;
   `changes/google-login-apps.md`.

## Decisions

- `docs/decisions/20261122-google-login-apps.md`: an app's Google sign-in is bound to a secret the app keeps; the
  system browser gets only a one-time code for that app; the desktop takes `/login/google#code=` for the team on screen
  without screen ④ (supersedes that part of `20261116-desktop-first-onboarding.md`).

## Risks

- **App Store guideline 4.8**: an app that offers a third-party sign-in must also offer an equivalent privacy-focused
  one (Sign in with Apple). The exemption for apps that sign in to an existing company or education account (the
  person's team account here, Google only as a shortcut to an account the company made) must be checked with App
  Review notes **before the phone release**. If it does not hold, the phone button stays off (no capability) until
  Sign in with Apple exists.
- **The phone part needs a store release** (iOS and Android). Builds without `google-signin-v1` show no button.
  Desktop builds without the `googleSignIn` flag keep password only.
- The phone return address uses the phone app's scheme; the server uses `PRODUCT.linkScheme`. They are equal for the
  Trina edition (`trina-ax`, tested); an edition with another phone scheme must keep them equal.
- Android Custom Tabs: Chrome follows a server redirect to a custom scheme when the redirect chain began with a tap
  (Google's Continue). To check on a real phone in the store release QA (not done here: no real device).
- Code interception: another program that registers `trina-ax://` could receive the code, but it cannot redeem it
  without the app's secret (in the app page's memory and sessionStorage only). An attacker who starts a flow with their
  own secret and phishes a victim through Google would need that program on the victim's device (the same accepted
  risk as app-signin and the connectors' hand-off).
- Login CSRF into an app: an attacker's code fails without the attacker's secret in the victim's app page.
- Migration 133 (132 and 134 are other agents'). A1's `google-login.ts` is changed (settle split for app flows); merge
  with A2/B planned.

## Tests

`tests/unit/a-google-login-apps.test.ts` (redeem per client, wrong secret, replay, late, wrong client, other person,
bad-code counting, phone redirect, desktop page, account changes), `tests/unit/e-desktop-common.test.ts` (link reader),
`tests/unit/mobile-bridge.test.ts` (capability, message), web unit tests for the per-client decision and the return
page; `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, mobile `typecheck` and `test`,
`bun run check:prepush`.

## Result

Filled in at the end.
