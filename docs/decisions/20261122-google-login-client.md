# Sign in with Google uses the server's own Google client and returns through the Drive callback address

- Date: 2026-11-22
- Status: accepted
- Supersedes: none
- Branch: feat/google-login (part A1 of [the plan](../AGENTS/plan/20261122-0454-google-login.md); broker mode is part B)

- **Ask:** Google accepts only exact return addresses (no `*.trina.app`), and every team has its own address.
- **Rule (the client):** the server's own Google client, `googleDriveOf(ctx).config`: the client file
  (`MYCEL_GOOGLE_DRIVE_CLIENT_FILE`, or Drive's `client.json` that the in-app setup `admin-setup.ts` or the company's
  own Google app `own-app.ts` writes). Without one there is no button and a start answers `unavailable`
  (`googleLoginAvailable` in `server/src/auth/google-login.ts`). A server that reaches Google for Drive only through the
  hosting service has no Sign in with Google until part B.
- **Rule (the return address):** Google returns to the address that client already registered for Drive,
  `/api/integrations/google-drive/callback` (`CALLBACK_PATH`; the client's `redirectUri` must be exactly this path on
  https). That route asks `ownsGoogleState` first (the state's hash is in `google_signin_flows`, a used one too) and
  serves Drive as before for any other state (`server/src/routes/drive.ts`).
- **Rule (where the button shows):** `GET /api/setup` says `googleSignIn: true` and `GET /api/me/google` says
  `available: true` only when there is a client, the page's origin is the origin of the client's return address, the
  server is not a demo, and (for the sign-in page) the team is set up. The web shows the button and Connect only in a
  plain browser (`clientKind() === 'web'`). People on an office, Tailscale or LAN address sign in with the password
  there: the binding cookie lives on one address.
- **Rule (what is asked):** `scope=openid email profile`, `response_type=code`, PKCE (`S256`), a nonce and
  `prompt=select_account`. No `access_type=offline`, so no refresh token. Nothing from Google is kept but the identity
  row (`sub`, `email`, `hd`).
- **Rule (the id_token):** the code goes to Google's token endpoint over TLS with the client secret and the PKCE
  verifier (the Drive transport, which only talks to Google's own addresses; at most 32 KB). Its signature is not
  checked: Google's OpenID Connect guide allows that for an id_token received straight from Google over HTTPS. Its
  claims are: `iss` is Google, `aud` holds the client id and `azp` equals it (when present, or when `aud` has several),
  `exp` is in the future, `nonce` is the flow's, `email_verified` is true, `sub` is printable ASCII (`googleClaims`).
- **Rule (the flow):** a row in `google_signin_flows` for 10 minutes with only the SHA-256 of the state and of the
  browser binding; the PKCE verifier and the nonce sealed with the Drive store's vault (context `google-login`); the
  client's `config_key`, so a client replaced mid-flow fails; `next`, a checked path of this site. The binding cookie
  (`__Host-gsi` on https, `mycel-dev-gsi` on plain http; HttpOnly, SameSite=Lax, 10 minutes) is checked before the
  state is spent and cleared on the return; a state works once. Starts count per IP (`perGoogleStart`, 30 per 15
  minutes) and the server holds at most 500 open flows; a return with a wrong binding counts per IP (`tokenGuard`).
- **Rule (broker mode, part B, not built):** a hosted team without a client of its own borrows the hosting service's
  client through account.trina.app, which has one fixed return address. The hosting service hands back Google's raw
  id_token, and the team server checks its signature against Google's keys plus `iss`, `aud` (the broker's client id),
  `azp`, `exp` and the nonce it set itself, so the hosting service can relay a sign-in but not make one up. The
  contract (`shared/src/cloud-protocol/google-signin.ts`) gets its own signing string, so a Drive signature never counts
  there.
- **Why the Drive callback:** a company that set up Google for Drive, with its own Google app or in the app, registered
  exactly this address already, so Sign in with Google works without a change in the Google console. A new path would
  have to be added by every company.
- **Why no signature check in direct mode, and one in broker mode:** in direct mode the token comes from Google itself,
  in answer to a request made with the client secret over TLS. In broker mode it passes through the hosting service,
  which must not be able to sign anyone in.
- **Left out:** the desktop app (part C) and the phone app (part D); the hosting service for self-installed servers; the
  Admin › Team settings row to turn it off (part A2).
- **Tests:** `tests/unit/a-google-login.test.ts` (scopes, PKCE, nonce, the registered return address, binding, once,
  expiry, cancel, the client's claims, the Drive callback still serving Drive, the per-IP limit, `next`),
  `web/test/e2e/google-login.spec.ts`.
- **Version impact:** minor (a new optional way to sign in; nothing new to register at Google).
