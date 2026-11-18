# Every role opens the team menu; a plain browser switches teams by address

- Date: 2026-11-18
- Status: accepted
- Supersedes: the "plain browser" line of [Switching teams from the logo menu and 나](../DECISIONS.md#switching-teams-from-the-logo-menu-and-나-featnav-ux-fix-b-2026-11-13-navigation-redesign-ux-review-s6) and the "Who sees it" line of [The team menu](../DECISIONS.md#the-team-menu--the-team-on-top-of-the-sidebar-me-at-the-bottom-featteam-menu-2026-11-10-product-owner)
- Branch: fix/team-menu-for-members (the owner, 2026-11-18)

- **Ask:** the owner found the team tile on top of the rail inert for anyone who is not an admin: "어드민 아니어도 팀
  바꾸고 할 수는 있어야 하는 거 아냐?" In a plain browser a member's tile was the logo and name only, because the menu
  held only admin items there; the desktop app already gave everyone "Switch team".
- **Rule:** the tile is a menu button for every role (owner, admin, member, guest). The menu: the team (logo, whole
  name, address), then **Invite people** and **Admin** for owners and admins only (unchanged: the invite endpoints stay
  admin-only), then **Switch team** for everyone. Where it leads:
  - the desktop app: its own team screen (unchanged);
  - the phone app with `change-team-v1`: its own "connect to another team" screen (unchanged); a phone app without it
    has no item (its web view does not leave the team by itself), so there a member's tile stays the logo and name;
  - a plain browser, computer or phone: a small dialog (the shared prompt dialog) that takes the other team's address,
    its name under the hosted team domain, or an invite or team link. It is read by the apps' own parser
    (`shared/src/team-link.ts` `parseTeamInput`: https only, except this machine from a page on this machine; no
    credentials; no other scheme), and the browser opens that team's first page in the same tab. This team stays
    signed in at its own address.
  - Phones: the 나 tab's team group shows the same **Switch team** row in a browser. The ☰ drawer stays the AI's
    history (no team header there, as decided in "The team menu").
- **Why:** Slack and KakaoTalk users look under the workspace logo for other workspaces; a member had no way at all in
  a browser. A team page never learns the person's other teams, so the browser cannot show a list: typing or pasting
  the address (or the invite link people already have) is the one way that needs no new server data.
- **Left out:** a list of the person's other teams in a browser (no cross-team data on a team server); creating a new
  team from here (hosted sign-up lives on the website, in waiting-list mode); any server or permission change; a
  Switch team action in ⌘K. Accepted: someone could tell a member to paste a look-alike address into Switch team; that
  is no worse than sending them the link, and the dialog opens only what the person typed.
- Tests: `web/test/unit/nav-menus.test.tsx` (member in a browser: the button, Switch team only, the dialog's errors and
  the address it opens; owner and admin: Invite, Admin, Switch team; the keyboard over three items; a phone app without
  its team screen: no button), `web/test/unit/team-switch.test.ts`, `web/test/unit/phone-nav.test.tsx`,
  `web/test/unit/rail-badges.test.tsx`, e2e `team-menu-members.spec.ts` (member and owner at 1440, member at 390), and
  the member checks in `rail.spec.ts`, `admin.spec.ts`, `guest-invite-people.spec.ts`.
- Version impact: patch (a menu that opens for more people; no API, data or permission change).
