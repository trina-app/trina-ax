# Connectors: one simple page in the sidebar

- Date (UTC): 2026-11-11 09:57
- Branch: `feat/connectors-simple`
- Status: in progress
- Where: `web/`. Why: the page and its labels are web UI only; no server or API change (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a simpler layout and a new name for an existing page, nothing new to set up

## Goal

The Connectors page (`/connectors`, today titled "Connected apps") feels heavy: four sections that each look
different, one row with a chip, a red error, a dropdown and an orange link, Google Drive shown twice, cards a member can
do nothing with, and the same page again as a Settings tab. People who are not developers should see two plain lists:
what they have, and what they can add. It works like Claude's Connectors page (list with one status per row, a Discover list,
everything else on the connector's own page). Plugins are a different thing here and are not touched.

## Scope

In:
- Name: "Connected apps" becomes "Connectors" for members (sidebar, phone drawer, page title, back links, search,
  "Settings › Connected apps" texts) in all five languages.
- Settings: the Connectors tab is removed from the list (`pages/settingsTabs.ts`, the phone list's "더 보기").
  `/settings/connectors` and `/settings/integrations` keep forwarding to `/connectors`, so old links work.
- The page, top to bottom:
  1. Title row: "Connectors", search, "+ Add custom connector" (owners and admins only, as today).
  2. **Your connectors**: one list of every connection the person can use: their own, the team's, and Trina's built-in
     ones they connected. One row style: logo, name, a small "Team" label when it is the team's, and **one** thing on the
     right: `Connected`, `Connect`, `Reconnect` or `Needs attention`. The row opens the connector's page.
  3. **Discover**: only what is not connected yet (no ✓ cards, so nothing shows twice), each row with one `+`. The
     first 10, the rest behind "Show all (n)". Members do not see cards they cannot use ("Not set up yet"). An owner or admin
     sees those cards with one "Set up" link that goes to the admin page.
- Moved off the list onto the connector's own page: "Run without asking", the full error text, the privacy note (Keys
  and sign-ins are stored encrypted…). The team connections an admin may not use ("Off for you") are no longer listed
  here at all: they are not the admin's own, and Admin › Connected apps lists them.
- `/connectors/mcp/:id` also opens a team connection (today only one's own), so every row of Your connectors has a page.
- Removed from the list page: the "Connected" row of big icon tiles, the orange "Manage" link on "From <team>" (admins
  reach Admin from the sidebar), the footer note.

Out:
- Admin › Connected apps (`pages/admin/Integrations.tsx`): stays as it is, name included (the owner asked to leave it).
- "Use from other AI apps" stays in Settings (a different feature).
- Plugins, the connector detail pages' content, tool permissions, the composer's per-chat switches, the server.

## Picture

```
Before                                          After
Connected apps        [Search] [+ Add custom]   Connectors            [Search] [+ Add custom]*
From Potenlab                        Manage     Your connectors
 Higgsfield [Run without asking]                 [■] Google Drive               Connected
  The service did not answer…  Off for you ▾     [■] Higgsfield  Team      Needs attention
Connected                                        [■] Notion      Team              Connect
 [Drive]                                        Discover                     Show all (44)
Popular                         Show all (44)    [■] Gmail     Read and manage Gmail   [+]
 Drive ✓ · Gmail + · Calendar +                  [■] Calendar  See and plan…           [+]
 Docs "Not set up yet" · Sheets "Not set up yet" …
Keys and sign-ins are stored encrypted…         * owners and admins only
```

## Steps

1. i18n: `integrations.title` = "Connectors" (and ko/ja/es/id); the "Settings › Connected apps" texts say
   "Connectors"; `connectorsPage.desc` kept short or dropped; new keys for "Your connectors", "Needs attention", "Team",
   "Set up". `admin.integrations` is not changed.
2. `pages/settingsTabs.ts` and `SettingsDialog.tsx`: drop the `connectors` tab, keep the redirects.
3. `pages/Connectors.tsx`: build Your connectors from `list` (mine + team), Drive and the Google apps' sign-ins; one
   `ConnectorRow` component with one status; Discover from the cards that are not connected; hide `off` cards for
   members, one "Set up" link for admins.
4. `components/integrations/TemplatesView.tsx` (FromTeam) and `IntegrationRow.tsx`: the team block's rows move to the
   connector's page; templates shared with the person show in Your connectors as `Connect`.
5. `CustomConnectorPage`: accept team connections; the page keeps the row with "Run without asking", "Off for you", the
   error and the privacy note.
6. Update the e2e specs that say "Connected apps" or use the removed tab (`settings-ia`, `account-settings`,
   `sticky-headers`, `plugins`) and the connectors specs.
7. `changes/connectors-simple.md` with the user-visible note.

## Risks

- Templates and admin requests (`MyRequests`, `?template=`, `?request=`) must still land on a page with their Connect
  button; walk every exit (each row, back, Search's "Connect an app", old Settings links).
- Members with personal connections turned off by the team (`personalAllowed` false): Discover hides `+`, the note stays.
- Five languages: `bun run check:i18n`; Korean labels must stay short on a 390 px phone.
- No migration, no permission change: the server decides what each person may see, as today.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the web unit tests for connectors and settings, the
e2e specs named above, and a hands-on walk in the QA team as owner, admin and member at 1440 and 390 px, light and dark.

## Result

Filled in at the end.
