# Admin › Plugins looks and works like Connected apps

- Date (UTC): 2026-11-11 08:43
- Branch: `feat/plugins-page-like-connectors`
- Status: in progress
- Where: `web/src/pages/admin/Plugins.tsx`. Why: plugins are a core admin screen (see docs/REPOSITORY-RULES.md)
- Version impact: patch, a screen is laid out again; no API, data or behaviour of installing changes

## Goal

Admin › Plugins is two bordered boxes today: an empty "Installed" box, and "Official plugins" where each plugin is a
long block of text (description, platforms, four permission lines) with a small Install button under it. The owner
asked for it to follow the Connected apps page. An admin should see at a glance what there is and what is on, and read
the details of one plugin on its own page.

## Scope

In:

- The title row of Connected apps: title, search, and "Install from file" on the right (servers that take files).
- "Installed": cards (icon, name, on or off, Turn on / Turn off, a ⋯ menu with Update, Roll back and Remove). Not shown
  while nothing is installed (no empty box), as on Connected apps.
- "Discover": cards of the official list (icon, name, official check, two lines of description, "by <publisher>",
  Recommended), with + to install, ✓ when installed, or why it cannot be installed here.
- A plugin's page in place of both sections, like a connector's page: back, a big icon, name, version and publisher, the
  main action on the right, then the description, what it will do (permissions), skills and details (kind, platforms,
  licences). `?focus=<id>` opens that plugin's page.
- Installing still always goes through the same permission prompt (PlanDialog); it is not changed.

Out: the server, the API, the permission prompt's content, plugin logos in the package format.

## Steps

1. Rebuild `Plugins.tsx`: header, cards, the plugin's page, search.
2. Texts in the five languages; remove the two that are no longer used.
3. Update `web/test/e2e/plugins.spec.ts` and the licence check in `ux-quick-check.spec.ts` to the new places.

## Risks

- Five languages: every new text in ko, en, id, ja, es (`bun run check:i18n`).
- Phone: cards are one column; the action buttons must not squeeze the name.
- Keyboard: back from a plugin's page returns the focus to the card that opened it.
- No migration, no permission change: the routes stay owner/admin-only.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run --cwd web test`, and the Playwright specs `plugins.spec.ts` and
`ux-quick-check.spec.ts`.

## Result

(filled in at the end)
