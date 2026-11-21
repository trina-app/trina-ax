# Connecting an app from the desktop app never asks to sign in again in the browser

- Date (UTC): 2026-11-21 18:33
- Branch: `fix/connect-browser-handoff`
- Status: done
- Where: trina-ax `server/src/integrations/connections/`, `server/src/routes/{integrations,drive}.ts`. Why: the
  owner pressed Connect on an app in the desktop app and the system browser ended on "The sign-in could not be
  completed … sign in to the same team account in this browser".
- Version impact: patch (a fix; no contract field removed, the desktop app needs no update).

## Goal

A person signed in to the desktop app connects any app with an OAuth sign-in (MCP connectors, GitHub through the
server's GitHub App, an own app or a template's app, HTTP APIs with an own app, the 127.0.0.1 loopback and the
metadata-document client) without signing in again in the system browser.

## Why it happens

The desktop app gets the service's sign-in address from `POST /api/integrations/:id/authorize` (its own session) and
opens it in the system browser. The service sends that browser back to `GET /api/integrations/oauth/callback`.
`connections/service.ts callback` finishes only when the browser has a live session of the **same person** who
started: that stops "connection CSRF" (an attacker starts a sign-in on their account, sends the address to a victim, the
victim signs in at the service, and the victim's account would land on the attacker's connection). The system browser
has no session of the app, so it always gets the refusal page.

## Not the design first asked for

A one-time handoff the browser carries to the OAuth start (or any address that gives the browser the right to finish)
was rejected by the security review of trina-ax #98 (docs/decisions/20261120-drive-connect-return-to-app.md): anyone
can mint one for their own account and phish a victim; short life and single use do not help. Instead the pattern
already used for Google Drive and Gmail/Calendar/Docs/Sheets (google-drive/app-return.ts) is reused.

## Steps

1. `callback`: a browser signed in as someone else is refused ("This browser is signed in as someone else …"). A
   return in a browser with no session, for a flow a
   **desktop** session started that is still live: exchange the code now, keep the tokens sealed in the flow
   (`exchanging`, reason `held`, life CLAIM_MS), make a one-time code (32 random bytes, only its hash sealed).
2. The page names whose Trina account the app joins, says "open only in your own app", and gives the code only in
   the fragment of the desktop app's link (`<scheme>://open?url=<team>/#code=…`), opened by itself (meta refresh) and
   by a button. `no-store`, `no-referrer`, CSP with no script but the hashed style.
3. The desktop app already posts every such code to `POST /api/integrations/google-drive/claim` with its own session;
   that route tries Drive, Google apps, then connections (`claim`): only a held flow of that same user and session,
   atomic single use, then the same store and checks as a direct return.
4. The owner's poll reads a held flow as `pending`; Cancel ends it; an unclaimed one is swept and its tokens revoked
   (best effort).
5. Web or phone flows without the person's browser session: unchanged refusal, reworded plainly ("This link expired
   … go back to the app and press Connect again"). Same person signed in: finishes at once as before.

## Decisions

docs/decisions/20261121-connect-browser-handoff.md (extends 20261120-drive-connect-return-to-app.md to every
connection sign-in).

## Risks

Security: login-CSRF (attack A curl desktop session + victim browser without session; attack B victim browser signed in
as the victim), code replay, late code, another session's code, cross-user. No migration (reason column carries
`held`). Older desktop apps: the claim route and link exist since 0.6 (11-20).

## Tests

`tests/unit/c-integrations-oauth.test.ts` (or a new `c-connect-app-return.test.ts`), security matrix, typecheck,
check:prepush, QA on a private copy of the QA team with a browser without a session.

## Result

Built as planned. No desktop or web change: the desktop app already posts every code to the Drive claim address, which
now tries connections last. A browser signed in as another person is refused in plain words, as for Drive and the Google
apps (coordinator 2026-11-22); first built as held, changed after review. Independent security review: nothing blocking; two LOW findings fixed, two accepted in the
decision. Tests: tests/unit/c-connect-app-return.test.ts, tests/security/connect-app-return.test.ts. QA on a private
copy of the QA team (port 19843) with a stand-in OAuth service and a browser with no session: held, claimed by the
desktop session, connected; replay, other person, attack and web-flow wording checked. Slack still asks a browser
without a session to sign in first (follow-up).
