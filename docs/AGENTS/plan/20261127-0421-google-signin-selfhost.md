# Sign in with Google on self-installed servers through the hosting service's sign-in broker

- Date (UTC): 2026-11-27 04:21
- Branch: `feat/google-signin-selfhost` (on top of `fix/google-signin-hosted-ux`, PR #678, head 85e13b870)
- Status: in progress
- Where: server/src/auth, server/src/routes, shared/src/api, web/src/pages/admin, docs/site. Why: sign-in, its admin
  page and its docs live there (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A self-installed server gains Google sign-in through the hosting service, a new admin page,
  a new team setting (`googleSignInDomains`) and a new admin endpoint; nothing is removed from the API.

## Goal

A self-installed server's admin who only wants "Sign in with Google" today has to make a Google Cloud project, a
client and paste a JSON file under Google Drive (about 10 steps on 10 Google pages). Once Drive goes through the hosting
service, sign-in would vanish on its own, because the sign-in broker serves hosted teams only. This change lets a
self-installed server with a public address use the hosting service's sign-in broker, like Drive's broker
(owner decision 2026-11-27, plan AX2 of the Google sign-in plan for self-installed servers), and gives the admin one
page for it: Admin › Sign-in methods.

## Scope

In:
1. `google-login-broker.ts` `build()`: a self-installed server (selfhost or office, a public address, the variable
   left out) uses the edition's console with its own address, as `driveBrokerFor` does (`selfInstalledDefault`); an
   operator's `MYCEL_GOOGLE_DRIVE_BROKER_URL` counts on any server. Hosted rules stay as they are.
2. Registration no longer depends on Drive: when the console answers `not_hosted`, the sign-in broker registers this
   server itself with the same signed `register` call Drive uses (`{ v: 1, origin }`, no contract change; trina-cloud
   opens `register` while either `CP_DRIVE_BROKER_SELF_REGISTER` or `CP_GOOGLE_SIGNIN_SELF` is on), backing off like
   Drive. The key route (`GOOGLE_BROKER_KEY_PATH`) answers while Drive's broker or the sign-in broker registers itself.
3. Admin › Sign-in methods (People group), replacing the Google row in Team settings: a Password row; a Google row with
   an On/Off switch, one status line (through the hosting service's sign-in service / through your company's Google
   app / needs a public web address, with a How link / not available yet / can't be reached), an optional
   "Only Google Workspace accounts from" domain field, and a "Try it" button. "Set up on the Google Drive page" goes.
4. Domain restriction: team setting `googleSignInDomains` (empty by default: personal Gmail and any team work). When set,
   Google's `hd` claim must be one of them, never the e-mail suffix. Applied to sign-in, connect and sign-up (setup,
   invite, team link); a re-check only confirms an account already connected and is not refused by it.
5. "Try it": an admin opens Google; the return says "Works: x@acme.com" (and whether the domain list lets it in)
   without signing anyone in or connecting anything. The team switch does not count for it.
6. Outage: when the hosting service cannot be reached and someone here has no password, the button stays; a click says
   "Google sign-in can't be reached right now. Try again in a few minutes, or ask your admin for a temporary password."
7. Docs: docs/site/use/sign-in-with-google.md, docs/site/operate/google-own-app-self-installed.md, a decision file, a
   changes file.

Out: "Require Google" (later, owner); the hosting console side (trina-cloud CP1, another branch); the privacy policy
(trina-cloud).

## Steps

1. Server: the broker's self mode and self-registration; the key route; `googleClientKind` reasons for the admin page;
   `GoogleSignInAdminStatus` gains `via` and `reason`; the domain check in `settle`; the test flow (a connect flow whose
   `next` marks it as a test, no new intent, no migration); the outage message.
2. Shared: `TeamSettings.googleSignInDomains`, the status fields, `POST /api/admin/google-login/test`.
3. Web: `SignInMethods.tsx`, the menu item, the Team settings row removed; the `wrong_domain` words on every page that
   reads `?google=`.
4. i18n: en.ts first, then es, id, ja, ko, zh; the server's messages too.
5. Tests: a-google-login-broker (self mode, registration, hosted-only rules kept, outage), a-google-login (the `hd`
   check on sign-in, connect, join; the test flow), web e2e for the admin page.
6. Docs.

## Decisions

docs/decisions/20261127-google-signin-selfhost.md: self-installed servers use the hosting service's sign-in broker
behind its own console flag; passwordless Google accounts are allowed there; the domain restriction reads `hd` and is
off by default. It extends docs/decisions/20261122-google-login-client.md and 20261127-google-signin-hosted-ux.md.

## Risks

- No migration. The test flow reuses intent `connect` (the CHECK of migration 131 allows no new intent).
- Security: the console sends the browser only to the origin it proved (trina-cloud); the team server still checks
  Google's signature, audience and nonce. A domain list never lets in more people, only fewer.
- A passwordless person on a self-installed server is locked out while the console is down; the outage message says to
  ask for a temporary password.
- Five app languages; phone (the admin list gains an item) and desktop.

## Tests

`bun run typecheck`, `bun run check:prepush`, `bun run check:i18n`, `bun run check:docs`, the auth unit tests
(`tests/unit/a-google-*.test.ts`), web e2e `google-login.spec.ts`, `google-signup.spec.ts` and the new admin page spec.

## Result

Filled in at the end.
