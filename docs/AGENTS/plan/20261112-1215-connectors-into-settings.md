# Connectors moves from the sidebar into Settings (QA TC-400)

- Date (UTC): 2026-11-12 12:15
- Branch: `fix/connectors-into-settings`
- Status: done
- Where: web/ (Sidebar, Settings dialog, the Connectors page, links), server/ (the links and texts that name the
  place). Why: where a person's own connections live is core navigation (see docs/REPOSITORY-RULES.md)
- Version impact: patch. The same page in another place; old addresses keep working; no API or data change

## Goal

The owner (2026-11-12, final): "설정안으로 옮기자". A person connects a service once and rarely comes back, and the
sidebar has 8 items. Claude.ai keeps connectors under Settings › Connectors. So the person's own Connectors leaves the
sidebar and the phone drawer and becomes a section of Settings, for every role.

## Scope

In:
1. Sidebar and phone drawer: no Connectors item.
2. Settings: a **Connectors** section, first of the Connections group, for everyone, with the same content as today's
   page (the components are reused, not redesigned). A connector's page opens inside Settings as a page under the
   section (like the account deletion page under Profile): on a computer the list stays on the left with Connectors
   marked and the page has its way back ("Connectors › Gmail", "← Connectors"); on a phone the bar says "‹ Connectors".
3. Addresses: `/settings/connectors`, `/settings/connectors/<id>`, `/settings/connectors/mcp/<id>`. Old ones lead
   there with their query: `/connectors`, `/connectors/<id>`, `/connectors/mcp/<id>`, `/settings/integrations`
   (→ the list), `/settings/drive` (→ Google Drive's page). `/connectors/authorize` (outside apps' consent) stays.
   An old `/connectors…` link opens Settings over the page it came from (Home when opened directly), not over itself.
4. Every link and text that sends a person to their own connections says and opens **Settings › Connectors**, on the
   web (notices, search, the + menu, onboarding, Slack pages, schedules, Admin's "Just for me") and on the server (the
   AI's hints and refusals, notices, Slack, request links), in all five languages.
5. Phones: the 나 list gets the Connectors row in Connections; the phone app keeps "status and Disconnect only"
   (#564) and no duplicate row or loop (#469).
6. Docs: docs/site pages that say where Connectors is, DECISIONS (supersedes "Connectors: the page is in the sidebar"
   and plan decision 12 of #366), `changes/connectors-into-settings.md`.

Out: Admin › Connectors (the team's) does not change. No redesign of the list, the cards or the pages.

## Steps

1. Plan (this file).
2. Settings: the section and the pages under it (settingsTabs.ts, SettingsDialog.tsx, Settings.tsx, App.tsx routes,
   the old addresses), Connectors.tsx as a section (its state kept across the list and a page).
3. Sidebar and drawer; lib/tabs.ts and lib/screens.ts (the phone's parents: a connector → Settings › Connectors →
   Settings).
4. Links and texts on the web and the server; five languages.
5. Tests: unit (sidebar, screens, notices, settings), e2e of sidebar, settings, connectors, phone drawer; the specs
   that clicked `nav-connectors`.
6. Docs, DECISIONS, changes fragment; hands-on QA on QA-Acme (owner and member, 1440 and 390, one dark shot).

## Risks

- The Settings dialog is a modal: the add dialog, the request answer and the ⋯ menus open over it (Settings already
  has modals inside: Memory's edit sheet).
- The page state (Google's sign-in started from a Discover +) must survive the list → page move: one provider for the
  section and its pages.
- Many e2e specs open `/connectors`; the redirect keeps them working, the ones that click the sidebar item change.
- Five languages for every text that names the place.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run test:web`, `bun run build:web`, the touched
server unit tests, and the e2e specs of the sidebar, Settings, Connectors and the phone drawer.

## Result

Built as planned, PR #609. Additions from the independent review: a connector's page opens at the top on a computer
too; Settings stays open against a stray click or Esc while a Google sign-in waits for its confirm step; a Google app's
page is an h2 in Settings and takes focus; an unknown address under Settings opens the list; ⌘K offers Connectors to
everyone. Connectors is first in Settings' Connections group (before Providers). Hands-on QA on a private copy of
QA-Acme (owner and member, 1440 and 390, light and dark).
