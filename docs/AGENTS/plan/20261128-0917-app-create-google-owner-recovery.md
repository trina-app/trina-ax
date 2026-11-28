# A Google owner whose S5 link was lost gets a new one from the app; S5 shows the username to Google owners

- Date (UTC): 2026-11-28 09:17
- Branch: `fix/app-create-google-owner-recovery`
- Status: in progress
- Where: shared/src/cloud-protocol (MIT contract), desktop/, web/, server/src/auth. Why: the recovery is one flow
  across the app, the team server and the console (see docs/REPOSITORY-RULES.md)
- Version impact: patch (a new deep link the app answers, a new sign-in refusal word, screen text; no migration, no
  setting, the contract only adds a constant)

## Goal

Live QA of "Create a team for free → Continue with Google" (app 0.20.3, team servers 0.20.2): when the new team's first
screen (S5, `/app-setup#c=<claim>`) was reloaded or reopened before Continue, it said "This link has expired · Sign in
with your password". A Google owner has no password; the team's sign-in page then said "This Google account isn't
connected" and the console refused a new setup link. The owner was locked out of their own new team.

After this change the owner always has a way back that keeps the rule "an outside link cannot deliver a claim":

- S5 expired, inside the app: **Get a new link** asks the app, which asks the console with its own sign-in for a new
  claim (`POST /api/app/v1/teams/:id/owner-claim`, revokes the old ones) and loads the new S5. Outside the app: the
  page says how (Trina AX app → Create a team for free → Open it). "Sign in with your password" stays as a quiet link.
- The team's sign-in page, Google, on a team with no account yet: "This team's owner account isn't made yet. Finish
  it in the Trina AX app" (new refusal `no_owner`), with the same button in the app.
- The console (trina-cloud PR) shows the same steps and a button `trina-ax://finish-setup`
  (`appFinishSetupLink`, new in `shared/src/cloud-protocol/owner-claim.ts`). The link carries nothing: the app runs
  its own create flow (sign in to the console if needed, then the owner claim of the person's own team).
- S5 shows "Your username is …" with Copy to a Google owner too ("You can also sign in with Google or your email").

## Scope

In: the contract constant, the desktop link and bridge call, `CreateTeam.finishSetup`, S5's expired and username
lines, the Google `no_owner` refusal (web flow), i18n in all languages, tests.
Out: the console side (trina-cloud), which lands separately and re-pins this contract there. Teams that already run
0.20.2 get the team server part with their next update; the console part and the app part do not wait for it.

## Steps

1. Contract: `APP_FINISH_SETUP_HOST = 'finish-setup'`, `appFinishSetupLink(scheme)`, `isAppFinishSetupLink`.
2. Desktop: `trina-ax://finish-setup` (main.ts onLink, before screen ④) and the bridge call `finishTeamSetup()` from
   the team page in the app's window → `CreateTeam.finishSetup()`: the create flow, and for an active team not set up
   straight to the owner claim (no "You have a team" notice).
3. Web: S5 expired screen (`appSetup.gone*`), Google `no_owner` on `/login`, username line for Google owners.
4. Server: `signInWith` answers `no_owner` when the team has no account at all.
5. Unit tests (contract, desktop create-team, web open-app, server google-login), i18n check.

## Decisions

[20261128-owner-claim-recovery](../../decisions/20261128-owner-claim-recovery.md).

## Risks

- Security: the new link and the bridge call carry no claim and no address; the app only opens the claim page of the
  team the console names for its own token (`claimPage` checks it is that team's origin). A page that calls the bridge
  can only make the app open the person's own team setup in the app's window.
- `no_owner` says a team has no account yet. It tells nothing a visitor of a brand-new team's address cannot see
  (the sign-in page of an empty team), and only while no account exists.
- Every new key in every catalog (`bun run check:i18n`).

## Tests

`bun run typecheck`, `bun run check:prepush`, unit tests for the areas, `tests/security`, web e2e (open-app), desktop
`create-team.spec`.

## Result

(filled in at the end)
