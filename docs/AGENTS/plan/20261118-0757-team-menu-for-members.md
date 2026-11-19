# The team menu opens for every role, also in a plain browser

- Date (UTC): 2026-11-18 07:57
- Branch: `fix/team-menu-for-members`
- Status: done
- Where: Team AX core (`web/src/components/TeamMenu.tsx`, `web/src/lib/teamSwitch.ts`, the 나 tab in
  `web/src/components/settings/SettingsDialog.tsx`). Why: the app's own navigation (see docs/REPOSITORY-RULES.md).
- Version impact: patch (a menu that was inert for members now opens; no API, data or permission change)

## Goal

The owner (2026-11-18): the team tile on top of the rail cannot be clicked by a member or guest in a browser. Everyone
should be able to open it and get to another team. In the desktop app it already opens for everyone ("Switching teams
from the logo menu and 나", 2026-11-13); a plain browser offered nothing, so a member's tile was a logo only.

## Scope

In:
- A plain browser gets "Switch team" too: a small dialog (the shared `promptDialog`) that takes another team's address,
  its name under the hosted domain, or an invite link, read by the apps' own parser (`shared/src/team-link.ts`
  `parseTeamInput`), and opens it in this tab. This team stays signed in (its own address keeps its cookie).
- So the tile is a menu button for every role: the team (logo, whole name, address), then Invite people and Admin for
  owners and admins only (unchanged), then Switch team for everyone.
- Phones: the 나 tab's team group gets the same row in a browser (the phone's ☰ drawer is the AI's history and has no
  team header: unchanged).
- The phone app without `change-team-v1` keeps no row (a web view must not navigate to another team itself).

Out: a list of the person's other teams in a browser (a team page never learns them), creating a new team (the hosted
sign-up is on the website, waiting-list mode), any server change.

## Steps

1. `teamSwitch.ts`: a third way `browser`; `switchTeam()` opens the dialog there; a pure `browserTeamTarget()`.
2. `TeamMenu.tsx`: drop the member-only plain header; the menu for everyone.
3. `SettingsDialog.tsx`: the row follows `useTeamSwitchWay()` (now set in a browser).
4. i18n in the six languages; unit tests; e2e spec; changelog fragment; decision file.

## Decisions

`docs/decisions/20261118-team-menu-for-members.md`, amends
[Switching teams from the logo menu and 나](../../DECISIONS.md#switching-teams-from-the-logo-menu-and-나-featnav-ux-fix-b-2026-11-13-navigation-redesign-ux-review-s6)
("a plain browser: no item") and "The team menu" ("a member's header is not a button").

## Risks

No permission change: the admin items keep `isAdmin`; the invite endpoints stay admin-only. Navigation goes only to an
http(s) origin the parser accepted (no credentials, https except this machine in development). Five app languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `web/test/unit/nav-menus.test.tsx`,
`web/test/unit/sidebar.test.tsx`, a team-link unit test for the target, e2e `team-menu-members.spec.ts`,
`bun run check:prepush`.

## Result

Built as planned. Root cause: `TeamMenu.tsx` drew a plain logo (no button) when the person was not an admin and the
window had no team-switch way, and `teamSwitch.ts` gave a plain browser none. Now a browser has the `browser` way
(the address dialog) and the menu opens for every role; admin items keep the `isAdmin` check. No server change: the
menu calls no endpoint beyond `GET /api/me`, which every role reads. Creating a new team stays on the website.
