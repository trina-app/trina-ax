# The desktop and phone apps sign in with Google through the system browser, with a code only the app's secret redeems

- Date: 2026-11-22
- Status: accepted
- Supersedes: the "asks first on its screen ④" part of [After setup in a computer's browser, a one-time code signs the desktop app in](20261116-desktop-first-onboarding.md), for the Google sign-in link only (that decision stays as it is for `/app-signin`)
- Branch: feat/google-login-apps (plan: docs/AGENTS/plan/20261122-0620-google-login-apps.md; parts C and D of docs/AGENTS/plan/20261122-0454-google-login.md)

Where: `server/src/auth/{google-login,google-login-apps}.ts`, migration `133_a_google_signin_apps.sql`,
`shared/src/api/auth.ts` (`GoogleSignInBody.client`/`appSecretHash`, `redeemGoogleSignIn`, `googleAppSignIn`),
`web/src/lib/googleSignIn.ts`, `web/src/pages/Auth.tsx` (`GoogleSignIn`, `GoogleReturn`), `desktop/src/common/address.ts`
(`googleSignInCode`), `desktop/src/main/app-window.ts`, `mobile/src/{protocol,bridge}.ts`, `mobile/App.tsx`.

- **Ask:** "Sign in with Google" (A1) works only in a browser. Google refuses to sign in inside embedded windows
  (`disallowed_useragent`), so the desktop and phone apps must do the Google step in the system browser, which has
  none of the app's cookies, and get the result back into the app's own window.
- **Rule:**
  - The app's sign-in page makes a random secret (32 bytes), keeps it (sessionStorage of that team's page on the desktop,
    in memory on the phone) and sends only its SHA-256 with `client: 'desktop' | 'mobile'` to
    `POST /api/auth/google/start`. The flow keeps that hash where a browser flow keeps its binding cookie's hash. No
    cookie is set. The app start works at any address the app shows (an office LAN address too): nothing is bound to a
    cookie of one address. `GET /api/setup` says so with `googleAppSignIn`; each app shows the button only with its own
    flag (desktop bridge `googleSignIn`, phone capability `google-signin-v1`), so older builds keep the password only.
  - Google's return runs the same checks as a browser's (state once, 10 minutes, the client unchanged, PKCE, the
    id_token's claims) minus the browser binding. It **never signs the system browser in.** The account found by
    Google's `sub` gets a one-time code: 32 random bytes, only its SHA-256 kept, 5 minutes, one use, with the `sub`,
    the client kind and the secret's hash; a newer code for the same Google account voids the older one.
    - Desktop: a page names the Trina account ("Account it signs in to: Olga (@olga)"), says to open it only in one's
      own app, and opens `trina-ax://open?url=<team>/login/google#code=<code>` by itself and by a button.
    - Phone: a redirect to `trina-ax://google-signin#code=<code>`, the address the auth session
      (`openAuthSessionAsync`: ASWebAuthenticationSession, Custom Tabs) waits for, so the session closes.
    - A refusal (not connected, turned off, temporary password, cancelled, expired) is said on the desktop page, or
      sent to the phone as `#error=<reason>`. The code is only ever in a fragment.
  - `POST /api/auth/google/redeem { code, appSecret, client }` (cookie mode, CSRF-checked): the secret must hash to the
    flow's and the client kind must match, else the code is spent and refused (410); an app signed in as someone else
    is refused with 409 and the code stays (the app-signin rule); the account is looked up again by its `sub`
    (disconnected, turned off, deleted, a guest or a forced password change since: nobody). Bad codes count per client
    IP like other tokens. Then `AuthService.signIn` with that client, audit `auth.login` with `method: 'google'` and
    the client. Never a code, secret, id_token or address in logs or audit.
  - **Desktop link without screen ④:** the app takes `/login/google#code=` only for the team on screen (the link's
    origin is the team's address or the address the window shows), with that exact page, no query and the code alone
    in the fragment. It loads that page in the team's own window at the address it shows, so the cookie lands in the
    team's partition and the page there has the secret. Nothing else is fetched; no team is connected. Any other link
    goes the usual way (④). An update restart never reopens `/login/google`. The office address gets the session as
    for any sign-in: `loadOrigin` copies the cookie when the window switches address.
  - **Phone:** the reply carries the code only to the document that asked (its nonce); the page redeems it itself, so
    the session lands in the WebView's own cookies. `team-link.ts` keeps refusing links with a fragment, and the
    return address is not `open`, so the app's link handler never reads it.
- **Why not screen ④ for this link:** ④ guards against a link that connects the app to a server the person did not
  choose. This link connects nothing new: it is only taken for the team already on screen, and it does nothing without
  the secret that window's page kept. Asking "Connect to {host}?" for the team the person is looking at would be a
  second confirm after Google's own.
- **Risks we accept:**
  - Another program that registers `trina-ax://` can receive the code, but cannot redeem it without the secret; an
    attacker who starts a flow with their own secret and phishes a victim through Google would also need that program
    on the victim's device (the same bound as the app sign-in code and the connectors' hand-off).
  - Whoever sees Google's return address in the system browser can spend the state first (no browser binding for an
    app's flow); they get a code for the victim's app only, which their own app cannot redeem. The person tries again.
- **Left out:** connecting a Google account from inside an app (Settings › Security keeps Connect web-only; a person
  connects once in a browser). App Store guideline 4.8 (Sign in with Apple, or the business-app exemption) is checked
  before the phone release.
- **Tests:** `tests/unit/a-google-login-apps.test.ts`, `tests/unit/e-desktop-common.test.ts` (link reader, ④ order,
  resume), `tests/unit/mobile-security.test.ts` (google-signin-v1), `web/test/unit/google-sign-in.test.ts`,
  `web/test/unit/mobile.test.ts`, the security matrix (`redeemGoogleSignIn`).
- **Version impact:** minor (a new endpoint, an optional start field, an add-only migration, a desktop bridge flag and a
  phone capability; older apps keep the password only).
