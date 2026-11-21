# A team's Google app signs in through the hosting service as "share", and a missing scope has its own error

- Date: 2026-11-20
- Status: accepted
- Supersedes: none
- Branch: fix/team-gmail-broker-redeem (QA TC-6064, TC-6065)

- **Ask:** an admin connected Gmail for the team on a server that signs in through the hosting service
  (account.trina.app). Google's sign-in finished, but Trina said "the Google sign-in did not finish" and recorded
  `broker_unavailable`; the hosting service's page said "This connects your own Gmail. Only you use this connection".
- **Rule:**
  - The Drive broker contract (shared/src/cloud-protocol/drive-broker.ts) allows `purpose: "share"` with an `app`: a
    connection the team uses. The scopes are the app's one set either way; the purpose only words the hosting
    service's page. A team sign-in sends "share"; when a control plane from before this refuses it
    (`invalid_request`), the team server starts again with "personal".
  - A Google answer without every scope of the sign-in's set is `scope_denied` (400), and the team server shows "allow
    every access" for it, as for a direct sign-in.
  - No broker error uses status 502 or 504: Cloudflare, in front of the console host, replaces an origin's 502 and 504
    with its own page and the team server loses the code. `provider_error` is 503.
- **Why:** the control plane answered a missing scope with `provider_error` 502; Cloudflare turned it into an HTML page,
  so every such sign-in read as "could not reach the hosting service", with no hint that a box on Google's screen was
  left unticked.
- **Left out:** the hosting service's "Gmail connected" page, shown before the redeem checks the scopes (a trina-cloud
  change); the Slack broker and push gateway contracts still use 502 for `provider_error` (same Cloudflare trap, their
  own PRs).
- **Tests:** tests/unit/c-google-apps-team-broker.test.ts.
- **Version impact:** patch (a fix; the contract change is additive and an older control plane still works).
