# A token refresh no longer counts as a team policy change

- Date (UTC): 2026-11-11 17:20
- Branch: `fix/audit-small-server-1`
- Status: in progress
- Where: `server/migrations/`. Why: the safe-operations policy generation is a trigger on `integrations` (core, AI connections; see docs/REPOSITORY-RULES.md)
- Version impact: patch, a bug fix with no new behaviour or setting

## Goal

11-11 code audit, row 18. The policy trigger of `integrations` (redefined last in 341) advances
`safe_ops_policy.generation` when `secret_enc`, `key_version` or `status` change. A token refresh rewrites
`secret_enc`/`key_version` and a call that fails or recovers rewrites `status`; none of those changes who may use the
connection or where its key goes. Each one still bumps the generation, so a protected publish (safe-ops
`publishArtifact`) that is waiting for its approval fails with "changed" whenever anybody's connection refreshes a token.

## Scope

In: a new migration that redefines `safe_ops_integrations_update` without `secret_enc`, `key_version` and `status`
(like `drive_team_shares`, 337, whose sealed tokens are bookkeeping). Every deliberate change of a connection's key or
sign-in (a new key, a sign-in, a sign-out, an address move, the Google apps' sign-in) also moves `version`, which stays
audited, so it still advances the generation.

Out: the other audit rows of this batch that are not about the policy trigger (row 17 is fixed by PR #407; rows 12,
19 and 20: see the PR).

## Steps

1. `server/migrations/344_c_policy_token_refresh.sql` (342 and 343 are taken by open PRs): drop and recreate the
   trigger with the 341 column list minus the three columns.
2. `tests/unit/safe-ops-policy-epoch.test.ts`: move the three columns to bookkeeping; a new test refreshes a real OAuth
   connection's token through the fake service and checks that the generation does not move, and that a sign-out
   still moves it.

## Risks

Migration number (342/343 used by open PRs #430/#446). Security: a key or sign-in change without a version bump would
no longer invalidate approvals; every such UPDATE in the server was checked (all bump `version`). No UI text.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/safe-ops-policy-epoch.test.ts`, the
`safe-ops*` and `c-integrations*` tests.

## Result

Filled in at the end.
