# Admin and Settings on phones: a list you tap into, and one set of phone patterns for every page

- Date (UTC): 2026-11-10 13:36
- Branch: `feat/phone-admin-list` (PR 1a); then `feat/phone-page-patterns` (PR 1b), `feat/phone-admin-lists` (PR 2),
  `feat/phone-admin-forms` (PR 3)
- Status: draft (reviewed once, see "Review")
- Where: trina-ax core web (`web/src/pages/admin/`, `web/src/components/settings/`, a new `web/src/components/phone/`,
  `web/src/lib/`). Why: phone navigation and the admin pages are core web UI; the phone app is this web app in a web
  view (see docs/REPOSITORY-RULES.md and DECISIONS "Phone navigation: four tabs").
- Version impact: minor (a visible change on phones; no API, data or permission change).

## Goal

The owner, about Admin on a phone: "Usually it's like iPhone Settings: a vertical scroll, and you tap into pages, no?"
and then, about Admin › Members & invites: "Not just that. All of the mobile settings are a problem."

Below 768 px today, Admin is a sideways strip of 13 links (1,634 px wide, most of it off screen), then "Home", then
big cards. Every page keeps the strip, a visible title, buttons that wrap onto two rows, filters on rows of their own,
three-line rows, and a sticky header that can take a third of the screen (Members: a 266 px header, the first member
about 450 px down a 844 px screen). Settings already opens on a list, but the phone's own Back skips that list. This
plan gives both the iPhone-Settings shape: a grouped list, a tap pushes the page, Back returns to the list. It also gives
every page the same phone patterns from shared components, not page-by-page fixes. Computers and tablets do not change.

## References (what we borrow, and what we do not)

- Apple HIG: grouped lists with a leading image, and a disclosure chevron on rows that open more
  (https://developer.apple.com/design/human-interface-guidelines/lists-and-tables, inset grouped:
  https://developer.apple.com/documentation/uikit/uitableview/style-swift.enum/insetgrouped). The back button shows the
  previous screen's title (https://developer.apple.com/documentation/uikit/uinavigationitem/backbuttontitle). One primary
  action, the rest in a menu only when needed
  (https://developer.apple.com/design/human-interface-guidelines/toolbars,
  https://developer.apple.com/design/human-interface-guidelines/pull-down-buttons). Segmented controls switch related
  views of one thing, about 5 segments at most on an iPhone
  (https://developer.apple.com/design/human-interface-guidelines/segmented-controls).
- Android: list items carry a leading icon and trailing meta text or a switch
  (https://developer.android.com/reference/kotlin/androidx/compose/material3/ListItem.composable); a settings root links
  to sub-screens (https://developer.android.com/develop/ui/views/components/settings/organize-your-settings); more than
  10 to 15 rows is too many (https://source.android.com/docs/core/settings/settings-guidelines). "Up and Back are
  identical within your app's task", and a deep link builds the back stack "that could have been achieved by organically
  navigating through the app" (https://developer.android.com/guide/navigation/principles).
- Other apps' official help pages: Slack, Notion, GitHub and Linear keep a short personal settings list on the phone
  and send admin work to the computer (https://slack.com/help/articles/218124397-Change-a-members-role,
  https://www.notion.com/help/notion-for-mobile, https://docs.github.com/en/get-started/using-github/github-mobile,
  https://linear.app/docs/get-the-app). The Google Admin app has Users, Groups, Devices and activity, and a user
  opens as a details page with its actions under More
  (https://knowledge.workspace.google.com/admin/mobile/manage-user-accounts-from-an-ios-device).
- Not verified (no sign-in, no public page): where iOS Settings puts "needs attention" rows (Apple documents only the
  red badge on the Settings icon, https://support.apple.com/guide/deployment/software-update-process-dep02c211f3e/web),
  the Google Admin app's home layout, Slack's admin on mobile, and any official rule on filters in a sheet versus inline.
- Ours, not copied: the rows keep this app's type scale, hairlines and warn badge; no iOS-grey inset cards (the owner
  asked for fewer frames).

## Audit at 390 px (fixture team, English)

Screenshots of every page, first screen and whole page, were taken against the mock server (not committed). Measured on
every page: nothing overflows the screen sideways (Admin's strip scrolls inside itself; Activity log's kinds would in
Spanish); the sticky headers; tap targets under 40 px. Browser (Settings) exists only in the desktop app, so it was not seen.

| Page | Problems on a phone | Fix (shared pattern) | PR |
| --- | --- | --- | --- |
| Admin root (/admin, "Home") | 1,634 px strip with cut-off links (38 px tall); "Home" and "Overview" headings; 7 cards of ~100 px with second lines of names; attention buttons 36 px, the checklist's ✕ 31 px | Phone root list (below) | 1a |
| Members & invites | 3 buttons on 2 rows, the line under them; search on its own row, then "Role All" alone on a row; rows of 3 lines (name, username, role); header sticks at 266 px; the first member about 450 px down | Page actions (Invite ⌄), search + Filters on one row, compact rows, only the search row sticks | 1b |
| Groups | Rows of 4 lines (name, description, faces, count and names); the face stack's fixed slot leaves a gap before "1 member"; header sticks at 134 px | Compact rows (name + "N members" chip, description only if set; the names leave the row, they are in the group's dialog) | 2 |
| Folder permissions | "Only folders with rules" switch alone on a row; header sticks at 193 px; the tree uses 2 lines per folder | The switch goes into Filters; By folder / By person stays segmented. The tree keeps its 2 lines: the second line is who can see it, the page's content | 2 |
| Providers | Status chip, refresh and switch crowd the name; the description is cut mid-list; an "Add account" button per engine | Compact rows; an engine's accounts open on tap | 2 |
| Connectors | Search and Add ⌄ already share a row; directory tiles are framed blocks of ~100 px with a 32 px "+" | Compact rows, no frames, 44 px "+" | 2 |
| AI apps | Description cut to "More"; Copy is 31 px | 44 px targets | 2 |
| Plugins | Frames inside frames; each plugin shows every paragraph and 4 checks (1,427 px for 2 plugins) | Flat cards; one line per plugin, details on tap | 3 |
| Slack | One framed card; "Replace tokens" is 18 px tall | Flat card, 44 px targets | 3 |
| Usage | 6 selects on 3 rows (5 filters and "Group by"); 4 framed stat cards; two header actions (Usage limits, CSV) | Range stays; 4 filters in Filters; Group by moves to the breakdown's heading; stat grid without frames; Usage limits with CSV in its ⌄ | 2 |
| Activity log | Its own "Filters" pattern and sticky header (145 px); kind segments 29 px tall, and in Spanish about 550 px wide | The shared Filters, with the kind inside it on phones; only the search row sticks | 2 |
| Team settings | 6,694 px; each of ~25 switches sits under its text; a save bar that Back can leave behind | Setting rows keep a switch or short field on the right (as Notifications does); the draft survives Back | 3 |
| System | 2,609 px; every value under its label (2 lines each); text buttons under 40 px | Info rows (label left, value right; long values such as the team address wrap under the label) | 3 |
| Settings root | Already list → page, but no chevrons or values; "Connections" shows only a "More" row; rows replace history, so the phone's Back from a section leaves Settings (checked: /settings → Security → Back lands on /) | Same phone list as Admin; rows push | 1a |
| Profile | 6 language chips on 2 rows; "Choose a photo" 36 px | 44 px targets | 3 |
| Security & devices | Fine | None | |
| Usage (mine) | Period select squeezed beside a 4-line description; 3 stat cards one per row; Refresh 30 px | Period under the line; stat grid; 44 px | 2 |
| Memory, Allowed for Trina, About | Fine (empty fixture lists) | None | |
| Providers (mine) | The bar says "Settings", not "Providers"; framed card titled "Providers" | Bar title and a flat card together, so the name never shows twice | 2 |
| Connectors, AI apps (mine) | Title shown twice (bar and page; they draw their own headers); Connectors' header sticks at 104 px | Their headers follow the phone header rule | 1b |
| Notifications | Fine: already switches on the right | None | |
| Apps | A QR code to scan with your phone, shown on the phone | No QR below 768 px | 3 |

## Scope

In:

**1. Breakpoint.** Phones are below 768 px (`max-md`, `useMediaQuery('(max-width: 767.98px)')`, the same as the tab bar
and the phone top bar), in a browser and in the phone app. From 768 px nothing changes: 768 to 1023 px keeps today's
title and strip, 1024 px and up keeps the sidebar (`lg:`). (The brief said "the sidebar from 768 px"; in the code it
starts at 1024 px.) Components this plan touches that switch at 640 px today (`SettingRow`, `OneLine`'s two lines,
`SearchBox`, `Card`'s header, Activity log's Filters) switch at 768 px, so 640 to 767 px is not half phone, half not.

**2. The Admin root on a phone (/admin).**
- Top: the team logo (28 px) and "<team> admin" (20 px semibold, at most 2 lines, then cut), the scope line under it.
- "Needs attention": Home's rows (warn icon, text, chevron; the update and after-update rows keep their buttons, at
  44 px). Until the sources have loaded, one placeholder row; nothing when there is nothing to fix. "Not everything
  could be checked" stays.
- The owner's setup steps: one row, "Before you start · 2 left", that opens its steps in place (`DisclosureRow`), so
  the groups stay on the first screen.
- Then the sidebar's groups as grouped rows (People, Connections, Activity, Team): icon, title, a short value or a warn
  badge on the right, chevron. Values come from what Home already reads, through one cached `useAdminOverview()` hook
  for Home and the phone root:
  Members & invites: active members ("7"); Providers: the default engine ("Claude Code"); Connectors: the number of
  connections, when any; Plugins: installed, when any; Usage: the 30-day estimate ("$0.47"); Activity log: the latest
  entry's time ("5 min ago"). Groups, Folder permissions, AI apps, Slack and Team settings have no value (Home reads
  nothing for them; no new requests).
- Badges ("2 to fix") are counted from the attention rows themselves, by the page each row opens, so a badge and the
  rows above can never disagree (Home's System card also counts warnings; the phone does not). A badge replaces the
  value. A value whose source failed shows "—" (read out as "Unavailable"); Providers shows "—" only when the engines
  failed (credentials or people failing is covered by "Not everything could be checked").
- The privacy line ("Admins can't see other people's chats or memories") as the list's footer.
- Removed on phones: the strip, the "Home" row, the "Home" and "Overview" headings, the overview cards and their second
  lines (member names, "Default: … · 0 team connections"), the "Nothing needs attention" line, the checklist's rows
  (behind one row). Slack stays the owner's; System stays storage-only for admins.

**3. Navigation.**
- A row pushes its page full screen. One shared `PhonePageBar` draws every phone bar with ‹: Admin's pages and root,
  Settings' sections, and the phone top bar's page branch (Skills, Projects, …), so there is one bar style. Admin's
  pages: "‹ Admin" on the left, the page's name in the middle. The root: "‹ Settings" (see the back label below).
  When the label and the title do not both fit (Spanish: "‹ Administración" and "Miembros e invitaciones"), ‹ shows
  alone; the title is cut last.
- The bar holds no page actions in this plan; a page's actions stay in the page, under the bar (see 5).
- ‹ is `useGoBack(fallback)` (lib/back.ts): back in history when there is app history, else the fallback in place of
  this entry. Fallback: `/admin` on a page, `/settings` on Admin's root and on Settings' sections. Android's back, the
  iPhone app's edge swipe and the browser's back walk the same history.
- **The list under a page.** When an Admin page is entered from outside Admin (by a push or a replace whose previous
  path was not under `/admin`), or is the first entry of the document (a pasted address, a push opening the phone app,
  `history.state.idx` 0), its entry is replaced by the list and the page is pushed again, before paint, keeping `?query`
  and `#hash` (`/admin/settings#ai-limits`, `/admin/members?member=`). Back then goes page → list → where you were (the
  Android "synthetic back stack"). Never on Back or Forward (POP), except the document's first entry (idx 0, which the
  router also reports as POP, with no insertion marker yet); never on a page change inside Admin, never on a resize,
  never on computers, and only once the section is final: after the old-address redirects (`/admin/engines` →
  providers, …), after the owner-only check (Slack), never for a member (their `/admin/...` still goes home). Settings'
  sections do the same with `/settings`, once the section is final there too (not while Providers is still loading).
- "The previous path" is one app-level copy of the last real path (App.tsx already passes the real path down as
  `RealPath`, the Settings overlay's `/settings/...` included), read before it is updated and used only at the moment of
  a push or replace. It never drives Back: Back stays the router's history (DECISIONS "Phone navigation" rejected
  tracking the previous page for that, and still does).
- The back label is recorded per history entry at that same moment (in `sessionStorage`, so a reload keeps it) and
  names where Back goes: "Admin" over the list, "Settings" over the 나 list, the admin page it came from when one page
  opened another (Members → Team settings' usage limits: "‹ Members & invites"). ‹ shows alone when Back goes anywhere
  else (Admin's root opened from ☰ › Search on Home goes back to Home) or to the same page (Folder permissions' rule
  editor and its way back). At the first entry the label names the fallback.
- In-page view switches do not add history on phones: Folder permissions' By folder / By person replaces its entry.
- Scroll: a pushed page starts at the top (the Admin layout stays mounted, so today the scroll would carry over),
  unless it has a `#hash` or a focus query, which scroll themselves. Back to a list or to a page (Members ← Team
  settings) puts its scroll back, per history entry; the root after it has drawn from the cached overview (no jump when
  the attention rows come in).
- Data on Back: the overview is cached in memory and shown at once, then read again in the background; the owner's
  diagnostics are not asked again within 60 s.
- Inner tabs: only Folder permissions' By folder / By person stays a segmented control (two views of one tree, fits
  360 px in all five languages). Activity log's kinds go into Filters on phones (Spanish needs ~550 px).

**4. Settings on phones (the 나 tab).** It already is list → page, so it keeps its structure and gets the same parts:
the shared phone list (chevrons; the Inbox count as the row's value), rows that push instead of replace (computers
keep replace, so closing the dialog still steps back once: `App.tsx` `useSettingsOverlay` counts pushes), ‹ via
`useGoBack('/settings')`, the shared bar ("‹ Settings" and the section's name), the list under a section opened from a
link, the list's scroll kept. The Connections group shows its rows (Providers when allowed, Connectors, AI apps)
instead of a lone "More" row. Removed: the ← arrow, the "More" row.

**5. Shared phone patterns** (in `components/phone/` and `pages/admin/common.tsx`; the desktop markup stays as it is):
- `PhoneList`, `PhoneListGroup`, `PhoneListRow`: grouped rows, 48 px, hairlines from the text's edge, value or badge,
  chevron; a group heading and footer. Both roots.
- `PhonePageBar` (above), `useListUnderPage(listPath, final)`, `useKeptScroll(ref)` in `lib/`.
- The phone header rule, in `AdminPageHeader` and in the pages that draw their own header (Connectors in Admin and
  Settings, `ConnectorsView.tsx`; Settings › AI apps, `pages/AiApps.tsx`; Activity log, `Audit.tsx`): the title for
  screen readers only (the bar shows it), the line kept to one line with More, nothing sticky but the search and
  filter row (at most 56 px). Kept: the scope line ("Applies to everyone in <team>"). Removed on phones: the count
  badge after the title (the root's row shows it).
- `PageActions`: one primary button, the others in its ⌄ menu (`SplitAction` and its menu move from
  `integrations/ConnectorsView.tsx` to `components/ui.tsx`), at the end of the search row, or of the line when a page
  has no search. On computers all buttons show, as today. Members: "Invite to team" ⌄ "Add directly", "Team invite
  link". Usage: "Usage limits" ⌄ "Download CSV".
- `PhoneFilters`: search and a "Filters" button with the number turned on, on one row; the filters open under it
  (Activity log's way, extracted). A view choice is not a filter and is not counted (Usage's "Group by" sits in the
  breakdown's heading).
- `CompactRow`: line one is the name, a chip and ⋯; line two only when it says something (a member's username when it
  is not the name, their email when the search matched the email, a status; a group's description). The chip can be a
  control: the owner's member ↔ admin choice stays a select, drawn as a chip with ⌄ and a 44 px target.
- PR 3: `SettingRow` keeps a switch or a short field on the right on a phone (as `PrefRow`); `InfoRow` (label left,
  value right, a long value wraps under the label); `Card` is flat below 768 px in Admin; `StatGrid` (2 or 3 values, no
  frames); every button 44 px on a phone. A page with a save bar (Team settings, the folder rule editor) keeps its
  draft in memory when Back leaves it and shows the bar again on return; ‹ asks first. (Leaving with unsaved changes
  loses them silently today too: strip links, ‹, the tab bar.)

**6. Copy.** English first, then ko, id, ja, es. New strings: `members.inviteMore` ("More ways to invite", the ⌄'s
name), `common.filtersOn` ("{count} filters on", read out with the Filters button), `adminHome.setupLeft` ("Before you
start · {count} left"). "Filters" reuses `activity.filters`; everything else reuses today's strings.

Out: tablets (see Open questions), Team settings split into pages, the desktop layouts, any API or permission change.

## Steps

PR 1a (`feat/phone-admin-list`), navigation: `PhoneList`, `PhonePageBar` (also for the phone top bar's pages),
`useListUnderPage`, `useKeptScroll`, back labels, `useAdminOverview` (cached) out of Home, the Admin phone root and bar
in `AdminLayout`, Settings' list, bar and pushes. DECISIONS entry ("Admin and Settings on phones: a list
you tap into"), CHANGELOG fragment, 5 languages, full web e2e.

PR 1b (`feat/phone-page-patterns`): the phone header rule (with Connectors' and AI apps' own headers), `PageActions`
(moving `SplitAction`), `PhoneFilters`, `CompactRow`, and Members using all of them.

PR 2 (`feat/phone-admin-lists`), list pages: Groups, Folder permissions, Providers (both), Connectors (both, rows),
AI apps (both), Usage (both, with `StatGrid`), Activity log.

PR 3 (`feat/phone-admin-forms`), document pages: `SettingRow`, `InfoRow`, flat cards, kept drafts; Team settings,
System, Plugins, Slack, Profile, Apps.

Each PR: screenshots at 1440 and 390, light and dark, as owner and as admin, plus 900 px to show tablets unchanged; one
independent review.

## Risks

- Back order. The list insertion is decided by how the page was entered (previous path, POP, idx 0), after redirects
  and permission checks, never on computers; `?` and `#` survive it. Tested from inside and from outside the app.
- iPhone app edge swipe: the inserted list entry was never drawn, so the swipe's preview may show the page before it or
  nothing. Checked on a device before PR 1a merges; if it looks broken, the list draws once before the page is pushed.
- The Settings overlay counts pushed entries to close: phone rows push now; computers still replace; the insertion is
  replace + push, so the count stays right.
- Long names: the team name in the root title (2 lines then cut), the bar's label drops before the title is cut, row
  values are cut before titles.
- Many e2e specs open Admin or Settings at phone width (admin, admin-home, phone-nav, settings-ia, account-settings,
  sticky-headers, ux-quick-check, a11y, …): PR 1a runs the full web e2e.
- No migration, no API change, no permission change: a member never reaches /admin, Slack stays the owner's, System
  stays storage-only for admins.

## Tests

- Always: `bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`.
- Unit: the phone list (values, badges, names read out), the Admin phone root for owner, admin, nothing-to-fix and a
  failed source; badges equal the attention rows per page; `useListUnderPage` (inserts once; not on POP, not inside
  Admin, not before a redirect, not for a member, not on computers; keeps `?` and `#`); the back label; Settings' rows
  push on a phone and replace on a computer.
- e2e, new `phone-admin.spec.ts` at 390 px: root rows and values; tap → page (at the top) → ‹ and browser Back to the
  list with its scroll; `/admin/connectors` opened directly → Back → list → Back leaves; an Inbox notice → page → Back
  → list → Back → Inbox; Members → Team settings' usage limits → "‹ Members & invites"; `/admin/settings#ai-limits`
  keeps its place; `/admin/slack` as an admin who is not the owner → the list, one entry; a member gets no list;
  By folder ↔ By person adds no history; no page wider than the screen in en and es; 1440 and 900 px unchanged.
  Settings: section → Back → list; a section opened from a link → Back → list.
- PR 1a: the full web e2e once. Later PRs: the specs of the touched pages.

## Review

One independent product/UX review of this plan and the audit (2026-11-10). Must-fix items and what changed:

1. The list insertion keyed on a `fromList` flag would fire again on in-Admin pushes (Folder permissions' view switch,
   the access editor's way back, links between admin pages) and loop. Now decided by how the page was entered
   (previous path outside Admin, or the first entry), never on POP; the view switch replaces its entry.
2. "‹ is `history.back()`" would leave the app at the first entry. Now `useGoBack` with a fallback, as everywhere else
   (DECISIONS "Phone navigation"); the back label names where Back goes.
3. The insertion ran before the redirects (old addresses, Slack for a non-owner, an unknown section). Now only for a
   final section.
4. The Admin layout stays mounted, so a page would open at the list's scroll, and Back reloaded all of Home's sources
   and jumped. Now pages start at the top, the overview is cached and the scroll is put back after it draws;
   diagnostics are not asked again within 60 s.
5. Connectors, Settings › AI apps and Activity log draw their own headers. Named in PR 1b and PR 2.
6. Where actions go was not said, Usage has two, and the owner's in-row role select had no place. Actions stay in the
   page; Usage's CSV goes under ⌄; the role select is the row's chip.

The same reviewer re-checked the revision: 4 resolved, 2 with gaps, 1 new. Fixed: the first entry is a POP too, so
"never on POP" now excepts idx 0; where the previous path comes from (one app-level copy, used only at the moment of a
push); "‹ Settings" on Admin's root opened from ☰ › Search (‹ alone there); Settings' "final" waits for Providers;
pages get their scroll back too; new: a back label naming the same page (‹ alone).

Should-fix items taken: Group by is not a filter; Activity log's kinds go into Filters; the setup steps fold into one
row; badges come from the attention rows; when Providers shows "—"; ‹ alone when the label does not fit; one bar for
the whole phone; 640 to 767 px; drafts kept on Back (PR 3); what is removed on pages; the iPhone swipe preview checked on
a device; PR 1 split in two; Settings › Providers moved whole into PR 2; screenshots in both themes and
both roles plus 900 px; no duplicate "Filters" string. Audit corrections taken: Activity log's 29 px segments (not its
rows), the root's 36 and 31 px buttons, Connectors' 32 px "+", Slack's 18 px link, Settings › Connectors' 104 px header,
Settings › Usage's 30 px Refresh, the folder tree's 2 lines (kept on purpose), Groups' 4-line rows, System's long values.
Not taken: tapping 나 while inside it pushes /settings again, so Back returns to the admin page. That is today's
behaviour on every tab; replacing the entry only moves the oddity (Back would then open the list). A separate fix.

## Open questions for the owner

1. Tablets (768 to 1023 px) keep the cut-off strip. Recommend the sidebar from 768 px in a follow-up.
2. Team settings is one long page (6,694 px today, shorter after PR 3). Split it into pages on phones (General, Data,
   Members and AI, Voice, AI defaults, Usage limits, Knowledge graph)? Not planned now.

## Result

Filled in at the end.
