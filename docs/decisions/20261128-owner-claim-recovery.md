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
  - Any web page can open the link, so it never claims by itself: it is ignored while S5 is on screen or within
    2 minutes of a claim, and otherwise stops at the app's own confirm screen ("You already have a team · Open it");
    only the person's press there asks for a claim. The team page's own button (the bridge call) claims at once, but
    not within 30 seconds of a claim. One claim request at a time; the console's hourly limit (`rate_limited`) has its
    own words and no button that asks again.
  - The console's page of an app team with no owner shows the app's steps and that link, never a claim or the old
    setup link. The team's S5 expired screen and its Google sign-in on a hosted team with no account (`no_owner`) say the same
    steps; inside the app they have the button.
- **Why:** [20261126-desktop-create-team](20261126-desktop-create-team.md) keeps claims out of links so that nobody can
  hand another person a team. Recovery keeps that: the claim still goes from the console to the app's window only.
- **Left out:** a web-only setup for a person without the app (the old setup link): an outside browser cannot prove it
  is the person's own, and the app can be installed again.
- **Version impact:** patch.
