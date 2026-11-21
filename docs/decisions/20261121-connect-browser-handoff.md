# Connecting an app from the desktop app finishes in the app, never by signing in again in the browser

- Date: 2026-11-21
- Status: accepted
- Supersedes: none (extends [A Drive sign-in from the desktop app finishes in the app](20261120-drive-connect-return-to-app.md) to every app connection's sign-in; narrows "the callback needs the same person's live browser session" of [External-service connections](../DECISIONS.md#external-service-connections-mcp-servers-and-http-apis-featintegrations-server-2026-10-28) for sign-ins started in the desktop app)
- Branch: fix/connect-browser-handoff (the owner's report with a screenshot, 2026-11-21)

Where: `server/src/integrations/connections/{service,text}.ts` (`hold`, `claim`, `stillFor`, `keep`),
`server/src/routes/{integrations,drive}.ts`. No desktop or web change, no migration.

- **Ask:** the owner pressed Connect on an app in the desktop app. The system browser came back from the service to
  the team and showed "The sign-in could not be completed. Close this window, sign in to the same team account in this
  browser, then start again from the app." The person is signed in to the app; asking them to sign in again in a
  browser is a dead end for people who are not developers.
- **Why it happened:** `GET /api/integrations/oauth/callback` finished only in a browser signed in as the person who
  started (stops connection CSRF: an attacker's sign-in address finished by a victim would put the victim's account on
  the attacker's connection). The system browser has no session of the app.
- **Which sign-ins:** every one that ends at that callback: MCP connectors (dynamic registration, the metadata-document
  client), GitHub through the server's GitHub App, an own app or a template's app (MCP and HTTP APIs), and the desktop
  app's 127.0.0.1 return address (its listener sends the browser on to the same callback). Google Drive and Gmail,
  Calendar, Docs and Sheets were already fixed this way (20261120, 20261121). Slack ("Sign in with Slack", "Add to
  Slack", own app or through the hosting service) still sends a browser without a session to sign in first: next.
- **Rejected:** the design first asked for, a one-time handoff the app puts in the browser's address so the server
  starts the sign-in for that person. Anyone can mint one for their own account (any member, or a `client: 'desktop'`
  login made with curl) and phish a victim: the victim's account lands on the attacker's connection. Short life and
  single use do not help (the attacker mints a fresh one). The same reason the security review of #98 removed it for
  Drive.
- **Rule:**
  - A return in a browser signed in as the same person finishes at once, as before.
  - A return in a browser signed in to the team as **someone else** is refused and nothing is exchanged, as for Drive
    and the Google apps (coordinator, 2026-11-22: one behaviour across connectors, and no phished victim's tokens to
    revoke). The page says "This browser is signed in as someone else. Sign out here, or go back to the app and press
    Connect again."; the flow stays pending.
  - A sign-in started from a **desktop** session whose return comes in a browser with **no session** is **held**: the code is exchanged now (a service's code may live only a minute), the tokens
    stay sealed in the flow (`exchanging`, reason `held`, nothing on the connection, 5 minutes), and a one-time code is
    made (32 random bytes, only its sha256 in the sealed secret).
  - The page gives the code only in the **fragment** of the desktop app's link (`trina-ax://open?url=<team>/#code=…`):
    no server, proxy or log sees it. It opens the link by itself (meta refresh) and with "Back to the app", names whose
    account it joins ("@username"), and says "Open this link only in your own app. Don't send it to anyone." No script
    runs; `no-store`, `no-referrer`.
  - The desktop app posts every such code with **its own session** to `POST /api/integrations/google-drive/claim`
    (since 0.6, 11-20); the route tries Drive, the Google apps, then connections. Only the session that started the
    flow redeems it, once (atomic), then the same checks as a direct return (the connection unchanged, still the
    person's or an admin's, the template still for them, the app unchanged, under the limit) and the same store.
  - A phished victim's browser without a session hands the code to the victim's own computer, whose app has the
    victim's session, not the attacker's: nothing connects. A victim browser signed in as the victim is refused before
    anything is exchanged.
  - The same return opened again never gives a second code ("This connection is waiting for the app").
  - Cancel, a new try, or 5 minutes without the code revoke the held tokens at the service (best effort).
  - A web or phone sign-in still needs the person's browser session (the phone app does not read a code from a link
    yet). Its page says plainly "This link expired. Go back to the app and press Connect again." with no sign-in link.
- **Pages (QA TC-6921):** every page of this return is one card with the product mark (`/favicon.svg`, `img-src 'self'`),
  light or dark as the system is, readable at phone width: the Google return page's own style (`RETURN_STYLE`,
  allowed by its hash). A heading, plain words and one next step: "Back to the app" for a desktop sign-in, "Open
  Connectors" for a web one, words only for the phone app or an address nobody knows. "Connected" still closes itself.
- **Residual risk:**
  - A person who forwards the page's link to the attacker within 5 minutes hands over their account; the page names
    the account it joins and says not to send it on, as Drive's does.
  - A phished victim whose browser has no session: their tokens are exchanged and, unclaimed, revoked after 5 minutes
    (before, the flow stopped before the exchange). A service that ends the whole grant on one revocation (RFC 7009
    allows it) can cut off the victim's other connection with the same app: an outage, nothing taken. Accepted, as for
    Drive. A victim signed in to the team in that browser is refused before the exchange, so this cannot happen there. A held result whose
    app's token address moved meanwhile is dropped without revoking (the client secret never goes to the address that
    lost); one deleted with its person's account is dropped without revoking.
- **Review:** independent security review on the branch: nothing blocking; two LOW findings fixed (a refused claim whose
  app moved no longer revokes; a session that ended during a claim ends the flow instead of a 500), two accepted above. A third (holding for a browser signed in as someone else) was decided away: that case is refused.
- **Tests:** `tests/unit/c-connect-app-return.test.ts` (held then claimed, a colleague's browser, web and phone, the
  same person's browser, a colleague's browser refused, a changed connection, replacement) and `tests/security/connect-app-return.test.ts` (attack A:
  curl desktop session and a victim browser without a session; attack B: a victim browser signed in as the victim, refused with no exchange;
  replay; another session; a late code; another team; unknown code).
- Version impact: **patch** (a fix; no contract change; older desktop apps since the claim address finish it).
