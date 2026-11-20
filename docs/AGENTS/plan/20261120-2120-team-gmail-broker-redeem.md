# Team Google apps through the hosting service: say why a sign-in failed, and say it is the team's

- Date (UTC): 2026-11-20 21:20
- Branch: `fix/team-gmail-broker-redeem`
- Status: in progress
- Where: server/src/integrations/google-apps, server/src/integrations/google-drive/broker.ts,
  shared/src/cloud-protocol/drive-broker.ts. Why: the Google app flows and the broker client live there; the contract is
  shared with trina-cloud (docs/REPOSITORY-RULES.md).
- Version impact: patch. A bug fix; the contract change is additive (an older control plane keeps working).

## Goal

QA TC-6064 (P1): an admin connects Gmail for the team on qa.trina.app (a self-installed server that signs in through
account.trina.app). Google's sign-in works and the hosting service's page says "Gmail connected", but Trina then says
"The Google sign-in did not finish" and records `broker_unavailable`.

What the logs show (2026-11-20, CP 5738456, qa 0.5.23-dev b212f018c):

- the four team Gmail flows that reached Google (21:00:49, 21:01:57, 21:03:01, 21:03:54Z) each have a control plane line
  `drive broker google error ... reason: "google drive code: not every access granted"` 29 s later: Google's token
  answer did not hold every Gmail scope (a box left unticked on Google's consent screen), and the control plane
  refused the redeem with `provider_error`, status 502;
- account.trina.app is behind Cloudflare, which replaces an origin's 502 with its own HTML page. The team server
  cannot read the JSON error, so it records `broker_unavailable` ("could not reach the hosting service") instead of
  "you did not allow every access". Drive sign-ins (read-only, one scope) and earlier personal Gmail sign-ins on qa
  (11-14 to 11-17) redeemed fine.

TC-6065: the team server starts every Google app sign-in with purpose `personal`, even the team's (the contract allows an
app only with `personal`), so the hosting service's page says "This connects your own Gmail. Only you use this
connection".

## Scope

In:
- Contract: a new error code `scope_denied` (400) for a Google answer without every scope of the sign-in's set;
  `provider_error` moves from 502 to 503 (Cloudflare passes a 503 through); `purpose: 'share'` is allowed with an app
  (a connection for the team).
- Broker client: `scope_denied` → DriveError `scope_denied` (the app already shows "allow every access" for it).
- Google apps service: a team sign-in starts with purpose `share`; when an older control plane refuses that
  (invalid_request), it starts again with `personal`, so team connections keep working before the CP update.
- Unit tests for each.
- trina-cloud PR (separate repo): answer `scope_denied`, sync the contract, team wording on the start page for an app
  shared with the team.

Out: the CP's "Gmail connected" page that shows before the redeem's scope check (reported, not changed here).

## Steps

1. Contract changes and parser test.
2. broker.ts mapping, service.ts purpose + fallback.
3. Tests: tests/unit for the broker client and the Google apps team flow.
4. changes/ note, decision doc, PR into dev.

## Decisions

docs/decisions/20261121-google-broker-team-apps.md: purpose `share` for team app sign-ins, `scope_denied` code,
`provider_error` 503.

## Risks

No migration. Security: none (the purpose only changes wording on the hosting service's page; the scopes asked are the
same). Older control plane: share+app refused → fallback to personal (tested).

## Tests

`bun run typecheck`, `bun run check:prepush`, tests/unit for google apps and the drive broker.

## Result

(at the end)
