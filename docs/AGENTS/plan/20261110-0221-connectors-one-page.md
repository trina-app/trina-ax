# Connectors: Yours and Discover on one page; the container says whose a page is

- Date (UTC): 2026-11-10 02:21
- Branch: `feat/connectors-one-page`
- Status: done
- Where: trina-ax core, `web/src/components/integrations/` and the two Connectors pages (`web/src/pages/Integrations.tsx`,
  `web/src/pages/admin/Integrations.tsx`). Why: the screen is shared by Settings and Admin and is core UI (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch. A screen layout change; no API or data change.

## Goal

The owner missed the Discover tab: Admin › Connectors with one connection showed one row and blank space. They also
could not tell the team's pages from their own: Admin and Settings use the same names (Providers, Connectors, AI apps)
and Admin said "For the whole team" only in small grey type. The page becomes one scrolling list, connections first and
Discover under them, and the Admin shell says whose its pages are, so the titles keep the same nouns as Settings'.

## Scope

In:
- Remove the Yours / Discover tabs (and the tab state) from both pages. One list: the connections under a plain
  "Connected" heading, then a "Discover" section with the Top connectors grid and Show all.
- Nothing connected yet: no empty box and no heading; one quiet line in Settings (the existing empty text), then
  Discover.
- The search filters every section; a section without matches hides; nothing anywhere gives one "no results" line.
- A connector's page (a card, Drive's +, `?drive=1`) still takes the place of the list; its way back scrolls to Discover
  and focuses its heading. Adding from Discover shows the new row in the connections and focuses their heading.
- The Admin shell carries the scope: the menu's title is the team's logo and "`<team>` admin", and one line above every
  Admin page says "Applies to everyone in `<team>`", the pair of Settings' "Just for you". The grey "For the whole team"
  beside each title goes. Titles stay plain nouns ("Connectors" in both).
- Settings › Connectors: what the team provides as one block, `From <team>`, above the person's own: the team's
  connections they may use (read-only, "Ready"), the templates shared with them ("Connect your account"), for admins
  also the ones not for them ("Off for you") and one Manage link to Admin › Connectors. It replaces "Team connections"
  (with its Team chip) and "From your team".
- Admin: each team connection and template has one quiet chip after its name with who may use it ("Everyone",
  "Design +2", "3 people"); a template's line no longer repeats who it is for.
- Strings in all five languages; the strings that nothing uses any more are removed.

Out: a person without adding rights still sees only their connections (no Discover), as before. No change to the
dialogs, Drive's own pages, request rows, or the Providers and AI apps pages beyond the shell's line. Moving Admin into
a team-name menu is a separate change (the main sidebar is not touched).

## Steps

1. `ConnectorsView.tsx`: header without tabs; Discover with its own section heading (focusable), a match helper for the
   search, and helpers to scroll to a section and focus its heading.
2. Admin and Settings pages: one list, the empty and search rules above, the deep links.
3. The Admin shell's title and line (`AdminLayout`, `AdminScope`), Settings' `From <team>` block (`FromTeam`,
   `IntegrationRow readOnly`), the audience chip; strings in en, ko, id, ja, es.
4. e2e specs that clicked the tabs or read the titles; screenshots at 1440 and 390, light and dark.
5. CHANGELOG, a DECISIONS entry that replaces the tab part of "External services: Connected and Discover".

## Risks

Specs and the docs screenshot script click the tabs by name. The sticky header must still keep the title, search and
Add. Focus after a dialog closes. Five languages. Phone width.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, and the e2e
specs of Settings and Admin Connectors, Drive, templates, requests, sticky headers, the a11y sweep and Settings IA.

## Result

Built in PR #289 (https://github.com/trina-app/trina-ax/pull/289). What differs from the first plan:

- The first version put "Team connectors" / "My connectors" in the titles, with "Connected for the team" / "Your
  connections" headings and a cross-link line under Admin's title. The owner chose the pattern most products use
  instead: the container says the scope (the Admin shell's title and line), the pages keep the same nouns. Those titles,
  headings and the line were removed.
- Admin with nothing connected shows no empty line of its own; Discover comes right under the title.
- Each page makes its own section heading ids (`useSectionIds`): Settings opens over the page it came from, so Settings ›
  Connectors can be on screen over Admin › Connectors (found in review).
- Settings hides, not unmounts, the blocks above the list while a connector's page is open, and waits for
  `From <team>`'s first answer before it says nothing is connected (review).
- Add pressed over a connector's page returns to the list after saving.
- "Off for you" is shown to admins only: a member's list has only what they may use, and nothing here widens that.
- The docs site's three MCP images were taken again from the mock server (`scripts/docs/screenshots.ts --only mcp`).
