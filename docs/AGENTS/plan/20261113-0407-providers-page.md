# Admin › Providers: provider logos, a simple view like Team settings, and the new name

- Date (UTC): 2026-11-13 04:07
- Branch: `fix/providers-page`
- Status: in progress
- Where: web/src/pages/admin (Engines.tsx, Credentials.tsx), web/src/i18n, docs/site. Why: web UI only (see docs/REPOSITORY-RULES.md)
- Version impact: patch: a clearer screen and a renamed menu item; no API, data or behaviour change

## Goal

QA TC-191 / TC-192. Admin › AI accounts shows a grey key on every account, every model name and a check time on each
provider, plan names in brackets, two or three badges, long problem sentences, up/down/refresh/menu buttons on every row
and a two-line "Order of use" note. Office workers read it as a wall of text. The page should read like Team settings:
per provider its logo, name, one state and the switch; per account its logo, name, plan and one state; details one
click away. The menu item and every hint that points at the page say "Providers".

## Scope

In:
- Logos: the Claude and Codex (OpenAI) marks already in web/public/icons/connectors (claude.svg, codex.svg) on a
  white tile (LogoTile, as on Connected apps), so they read in dark mode; the API engine gets a plain plug icon.
- Provider row: logo, name, one state badge, switch. Removed from the row: the dim "how it signs in · all models ·
  checked at" line and the Experimental badge (both in the opened row), the refresh button (in the opened row as
  "Check again"). The API engine's orange sentence becomes one short muted line with "Set up".
- Account row: logo, name, plan in short ("Claude subscription · Max"), one state badge; one short line only when it
  has a problem ("Refused · replace the key"). Who uses it, tokens this month, last used and the server's long
  explanation open under the row. Move up / down and Check again go into the ⋯ menu.
- "Accounts, in the order they are used" → "Accounts"; the bottom note → a "How order works" link that opens it.
- Rename: "AI accounts" → "Providers" in the sidebar, page title and every hint (en.ts admin.providers,
  settings.providers, admin.team.providers, members.noAi*, welcome.ai.enginesLine, fileList.problem.no_ai,
  handover.*), the four other languages (ko "AI 제공사", the word the Korean strings already use for Anthropic/OpenAI),
  docs/site pages, e2e and unit tests that assert the old words.

Out: the URL stays /admin/providers; no server change; Settings › own accounts layout.

## Steps

1. Plan (this file).
2. Rename strings in 5 languages + docs/site; update tests.
3. Provider and account rows as above.
4. typecheck, check:i18n, check:docs, unit tests of the area, test:web, build:web, full web e2e; screenshots
   1440/390 light and dark.

## Risks

Shared CredentialRow is also used by the members' own accounts list (Team settings) and Settings; their delete button
stays. Plain-words check: no "token", "engine" or "model" on the closed rows; "Providers" in English, plain words in the
other languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit for admin/credentials/engines,
`bun run test:web`, `bun run build:web`, full web e2e.

## Result

