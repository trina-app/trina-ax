# The welcome steps survive the hand-off to the desktop app

- Date (UTC): 2026-11-19 18:12
- Branch: `fix/welcome-steps-in-app`
- Status: in progress
- Where: server/src/auth, server/src/onboarding, shared/src/api, web/src (core). Why: the welcome steps and setup are core onboarding (docs/REPOSITORY-RULES.md).
- Version impact: patch, a fix of onboarding (one optional field in the setup request, nothing removed)

## Goal

The owner of a new hosted team who pressed "Continue in the Mac app" after /setup saw only "Connect AI" and skills,
then nothing. Home resumes the welcome steps only when a welcome-progress row exists, and the server made that row only
when /welcome was opened once (in the browser tab the owner left). The company website from the setup link stayed in
that tab too. An owner who takes the app route gets the same steps in the app, from where they left off.

## Scope

In:
- `POST /api/setup` creates the welcome-progress row for the new owner (fresh steps), with the setup link's website
  (`site`, optional, normalized; dropped when it is not an http(s) address). Never fails the setup.
- The setup page sends the link's website with the setup request.
- The app's /app-signin → Continue lands on Home with the landing state, which now resumes the steps (no change there).
- e2e: a fresh owner in the app lands in the welcome steps; the Company profile step has the website.
- Unit tests for the row made at setup (fresh steps, the site, a bad site, idempotent, no row when setup fails).
- Docs: get-started/team-setup (all languages) if the description changes; a decision file.

Out:
- Teams made before this fix that never opened /welcome get no row (an old team must not be sent into the steps).
- The no-AI card on Home still stands in for the setup row while no AI answers (unchanged rule).

## Steps

1. shared: `SetupBody.site` (optional string, max 300).
2. server: `startWelcomeAtSetup(ctx, site)` in onboarding/welcome.ts; called from auth/accounts.ts setup.
3. web: Setup sends `site`; mock server mirrors it.
4. Tests, docs, decision file, screenshots.

## Decisions

docs/decisions/<day>-welcome-steps-in-app.md

## Result

(filled in at the end)
