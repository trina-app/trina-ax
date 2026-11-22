# Slack sign-in and "Add to Slack" from the desktop app finish in the app

- Date: 2026-11-22
- Status: accepted
- Supersedes: none (extends [Connecting an app from the desktop app finishes in the app](20261121-connect-browser-handoff.md)
  to the gap it listed: Slack)
- Branch: fix/connector-desktop-handoff (owner 2026-11-22: connecting from desktop app 0.7.0 ended on "sign in to the
  team account in this browser")

Plan: [docs/AGENTS/plan/20261122-0016-connector-desktop-handoff.md](../AGENTS/plan/20261122-0016-connector-desktop-handoff.md).
Where: `server/src/integrations/slack/service.ts` (`holdFor`, `claim`, `signedIn`, `installed`),
`server/src/integrations/connections/return-page.ts` (the shared held page), `server/src/routes/{slack,drive,integrations}.ts`.
No desktop or web change, no migration, no contract change.

- **Which sign-ins:** "Sign in with Slack" with the team's own app (Slack's code) and through the hosting service (its
  handoff), and "Add to Slack" through the hosting service. Before, a return in a browser with no session went to
  `/login`, a dead end in the desktop app's system browser.
- **Rule:** the same as #279's for every other connector:
  - A return in a browser signed in as the starter finishes at once; one signed in as someone else is refused and ends
    the flow (unchanged for Slack).
  - A return in a browser with **no session**, for a flow started from a **desktop** session that is still live (an
    active person), is **held**: Slack's code or the hosting service's handoff is sealed in the flow (with its PKCE
    verifier, under the flow's own name), and a one-time code is made (32 random bytes, only its sha256 sealed). The
    flow stays `pending` with reason `held` (no migration); life `CLAIM_MS` (5 minutes).
  - **Not exchanged until the claim** (unlike connections, which exchange at once): Slack's code and the hosting
    service's handoff both live 10 minutes, longer than the claim. So a result never claimed holds no token and needs
    no revocation; the phished victim's account is never even asked.
  - The page is the connections' held page (shared helper, same words, same CSP, `no-store`, `no-referrer`): the code
    only in the fragment of `trina-ax://open?url=<team>/#code=…`, named for whose account it joins.
  - The desktop app posts it to `POST /api/integrations/google-drive/claim`, which tries Drive, the Google apps,
    connections, then Slack. Only the session that started the flow redeems it, once (atomic `held` → `used`), then
    the same finish as a browser return: the nonce, audience, issuer, workspace and person checks of a sign-in; for
    "Add to Slack" the owner-or-admin check runs again at the claim.
  - The same return opened again (any browser, the starter's included) gives no second code and finishes nothing
    ("This connection is waiting for the app"). A return after the app finished says how it ended (linked / added,
    while that is still so).
  - Cancel in the app, a new try (only the newest flow works) or 5 minutes end a held flow; its code is refused.
  - The phone app's in-app browser still signs in first (the phone app does not read a code from a link yet).
- **Security:** the properties of #279. Single use; bound to the starter's session (the claim needs it) and team (the
  code is only in this server's database); a phished victim's code reaches the victim's own app, whose session is not
  the starter's.
- **Residual risk:** as #279: a person who forwards the page's link to someone within 5 minutes hands over their
  Slack sign-in; the page says not to.
- **Tests:** `tests/unit/c-slack.test.ts` (own app), `tests/unit/c-slack-official.test.ts` (hosting service sign-in,
  Add to Slack, an admin demoted before the claim), `tests/security/slack-desktop-handoff.test.ts` (attacks A and B,
  replay, reload, another session, a late code, an unknown code, another team).
- Version impact: **patch** (a fix; no contract change; desktop apps since 0.6 already post every code to the claim
  address).
