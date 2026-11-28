# A lost owner claim comes back through the app, never through a link that carries one

- Date: 2026-11-28
- Status: accepted
- Supersedes: none
- Branch: fix/app-create-google-owner-recovery (live QA of the desktop "Create a team for free" with Google, 2026-11-28)

- **Ask:** a Google owner whose new team's first screen (S5, `/app-setup#c=<claim>`) expired had no way in: no
  password, Google "not connected", the console's new setup link refused.
- **Rule:**
  - The only way to a new claim is the app's own console sign-in (`POST /api/app/v1/teams/:id/owner-claim`). The app
    answers `trina-ax://finish-setup` (contract `appFinishSetupLink`) and the team page's bridge call
    `finishTeamSetup()` by running that flow; neither carries a claim, an address or a code.
  - The console's page of an app team with no owner shows the app's steps and that link, never a claim or the old
    setup link. The team's S5 expired screen and its Google sign-in on a team with no account (`no_owner`) say the same
    steps; inside the app they have the button.
- **Why:** [20261126-desktop-create-team](20261126-desktop-create-team.md) keeps claims out of links so that nobody can
  hand another person a team. Recovery keeps that: the claim still goes from the console to the app's window only.
- **Left out:** a web-only setup for a person without the app (the old setup link): an outside browser cannot prove it
  is the person's own, and the app can be installed again.
- **Version impact:** patch.
