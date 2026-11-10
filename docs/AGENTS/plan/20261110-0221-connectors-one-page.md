# Connectors: Yours and Discover on one page, and titles that say whose they are

- Date (UTC): 2026-11-10 02:21
- Branch: `feat/connectors-one-page`
- Status: in progress
- Where: trina-ax core, `web/src/components/integrations/` and the two Connectors pages (`web/src/pages/Integrations.tsx`,
  `web/src/pages/admin/Integrations.tsx`). Why: the screen is shared by Settings and Admin and is core UI (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch. A screen layout change; no API or data change.

## Goal

The owner missed the Discover tab: Admin › Connectors with one connection showed one row and blank space. They also
read Admin's list as their own ("Connectors", a small grey "For the whole team" and a "Yours" tab). The page becomes one
scrolling list, connections first and Discover under them, and its title says whose connectors they are.

## Scope

In:
- Remove the Yours / Discover tabs (and the tab state) from both pages. One list: the connections under a small heading
  ("Connected for the team" in Admin, "Your connections" in Settings), then a "Discover" section with the Top connectors
  grid and Show all.
- Nothing connected yet: no empty box and no heading; one quiet line (the existing empty text), then Discover.
- The search filters both sections; a section without matches hides; nothing anywhere gives one "no results" line.
- `?drive=1` and the other ways into Discover (a card, Drive's +, back from a connector's page) scroll to Discover and
  focus its heading; adding from Discover shows the new row in the connections and focuses their heading.
- Titles: Admin "Team connectors" (the grey "For the whole team" goes), Settings "My connectors". The menus keep
  "Connectors".
- Admin: one line under the title instead of the description: shared with the team, and a link to My connectors. Each
  team connection and template has one quiet chip after its name with who may use it ("Everyone", "Design +2",
  "3 people"); a template's line no longer repeats who it is for.
- Settings: team connections keep their "Team" chip.
- Strings in all five languages; the tab strings and the empty-state hints that nothing uses any more are removed.

Out: a person without adding rights still sees only their connections (no Discover), as today. No change to the
dialogs, Drive's own pages or request rows.

## Steps

1. `ConnectorsView.tsx`: header without tabs; Discover with its own section heading (focusable), a match helper for the
   search, and helpers to scroll to a section and focus its heading.
2. Admin and Settings pages: one list, the empty and search rules above, the deep links.
3. Titles, the cross-link line and the audience chip; strings in en, ko, id, ja, es.
4. e2e specs that clicked the tabs; screenshots at 1440 and 390, light and dark.
5. CHANGELOG, a DECISIONS entry that replaces the tab part of "External services: Connected and Discover".

## Risks

Specs and the docs screenshot script click the tabs by name. The sticky header must still keep the title, search and
Add. Focus after a dialog closes. Five languages. Phone width.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, and the e2e
specs of Settings and Admin Connectors, Drive, templates, requests, sticky headers, the a11y sweep and Settings IA.

## Result

Filled in at the end.
