# Admin › Connectors in the same layout as the Connectors page

- Date (UTC): 2026-11-12 05:42
- Branch: `feat/admin-connectors-member-ui`
- Status: in progress
- Where: `web/` (Admin › Connectors, `pages/admin/Integrations.tsx`, and the shared connector parts). Why: the web app's
  own screens; no server change (see docs/REPOSITORY-RULES.md).
- Version impact: patch. A new layout, and the members' switch is gone (its endpoints stay and change nothing); no
  API shape, data or migration change.

## Goal

An admin sees two different pages for the same connectors today: the member's Connectors page (a list, Discover, a
simple page per connector) and Admin › Connectors (big Discover tiles, grey boxed pages, the members' switch in a
bordered card). The owner decided: Admin › Connectors uses the member page's layout, with the admin-only parts inside
it. On a server whose Google sign-in comes from the hosting service, each Google connector's admin page says so plainly
and needs no setup, and the admin still sets who may use it.

## Owner feedback (2026-11-12, decided)

A. No members' switch: once a connector is set up everyone in the team may connect their own. Server: a stored "off"
   is ignored (no migration; the highest migration on dev is 701), the switch endpoints stay for older apps and change
   nothing, `members_off` is never sent. The "turn on and connect" variant (welcome steps, Drive's card) goes.
B. Team settings on a connector's admin page in the layout of Admin › Team settings (`SettingsSection`, `SettingRow`):
   a plain heading, rows with a hairline, no boxes, no "On" badge next to a switch.
C. Sharing every connector with the team: Google apps have no shared (team) connection on the server (connections are
   personal only), so this PR does not build it; a separate plan describes it (branch `plan/google-apps-team-shares`).

## Scope

In:
- The list: the same two sections as the member page. "Connected": the Google connectors that are on (members can
  connect, or a Drive is shared), the team's connections, its templates and the requests to members, one line each.
  "Discover": what is not on yet, in the member page's rows (logo, name, line, +), the first ten and "Show all".
- A Google connector's admin page (Google Drive, Gmail, Calendar, Docs, Sheets): the member page's simple layout
  (`AppDetail.tsx`): the header with its state and ⋯, a line under it, About, the tools as chips, the details, then a
  compact **Team settings** block.
- Set up: the primary action while not set up; **Change setup** in ⋯ once set up.
- Hosting service (source `service`, or blocked `hosted`): the line "Google sign-in comes from the hosting service.
  Nothing to set up or upload." No Set up, no ⋯ setup; Team settings stay.
- A team connection opens its own page, `/admin/connectors/mcp/<id>`, with its full row (who may use it, test, edit,
  delete, tools), as a member's own connection does on the Connectors page.

What moves where:
| Today | After |
| --- | --- |
| Drive/Gmail… page: grey box with state badge + Set up / Replace button | header: state on the right; Set up as the primary button, Change setup in ⋯ |
| "Members can connect their own …" bordered card with switch | removed (A); Team settings says "Who can use it: everyone, each with their own account" |
| Drive's team shares (title, Share button, list) | Team settings, under the switch |
| Gmail…: list of Google APIs to switch on | Team settings (only with its own Google client); still in the setup dialog |
| "Same Google app as Drive" / "set on the server" / "from the hosting service" small notes | one line under the header |
| Drive's "no public address" explanation | one line under the header (same words, same System link for the owner) |
| Team connection: a row that opens in place (address, key, tools, buttons) | a one-line row that opens its page with that row |
| Discover: tiles with "by …" and a count, "Top" / "More connectors" | the member page's rows, Show all |

Removed: the members' switch for Google Drive and each Google app (UI, its i18n keys, the welcome steps' "turn on and
connect"), the grey boxed connector header for Google connectors (`DriveAdminDetail`, `GoogleAppAdminDetail`), Discover's
tiles and its "Top connectors" / "More connectors" / count (`ConnectorDiscover` and its helpers), the old member
`DriveDetail` (unused), and i18n keys left unused, in all five languages.

Out: the listed MCP services' page (`ConnectorDetail`) stays as it is; templates and requests stay one-line rows in
the list (they have no page of their own today); the hosting console (trina-cloud).

## Plain words

Labels an admin reads: "Team settings", "Set up", "Change setup", "On", "Google sign-in comes from the hosting
service. Nothing to set up or upload." No "broker", "OAuth", "client" in new words.

## Steps

1. Plan (this file).
2. Shared parts: `AppDetail` takes a list link, Team settings (children) and an embedded mode; the member page's
   Discover row and `ConnectorRow` become shared (`ConnectorsView.tsx`).
3. Admin page: list, Google connector pages with Team settings, team connection page, routes.
4. i18n (five languages), unused keys out; unit and e2e tests; screenshots 1440/390, light and dark.

## Risks

No migration. Many e2e specs use Admin › Connectors: rows that opened in place now open a page. The phone: the admin
bar (phoneBar.ts) names the open connector; the list and pages must not overflow at 390.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the touched unit tests, and the e2e specs for admin
connectors, integrations, google-apps, drive, drive-team-share, phone-admin-pages and phone-connectors.

## Result

Filled in at the end.
