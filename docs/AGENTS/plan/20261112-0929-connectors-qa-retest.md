# Connectors QA retest: team connection for everyone, last tried, admin Drive words, sign-in wording, catalog links

- Date (UTC): 2026-11-12 09:29
- Branch: `fix/connectors-qa-retest`
- Status: done
- Where: `web/` (Connectors, Admin › Connectors, the add and template dialogs) and one line in
  `server/src/integrations/connections/service.ts`. Why: the core's connectors (see docs/REPOSITORY-RULES.md).
- Version impact: patch. Fixes and words; no API shape, data or migration change.

## Goal

QA retest on dev 4db2b851d:

1. **Bug.** Admin › Connectors › a service › "Connect for the team": who can use it starts as "Choose groups and
   people" with only the admin ticked. "For the team" means the whole team: it starts as Everyone, still editable.
2. A connection's details say "Not used yet" right after a call was tried and failed. A failed call now counts as
   tried (the server keeps when), and while the connection is failing the line says "Last tried {date}"; "Not used yet"
   only when nothing was ever tried.
3. Admin › Connectors › Google Drive uses the member's words ("Connect your own … Only you use this connection"). It
   gets admin words: what the team gets.
4. The template connect dialog's last line talks about storing a key for a sign-in (OAuth) service. For a sign-in
   service it says you sign in on the service's own page and Trina keeps the sign-in; the key words stay for key
   services. All five languages.
5. TC-132: a listed service's page before connecting shows only the address. It shows links (privacy, terms, docs) and
   the tools, only values checked on each service's own pages (the page cited in a code comment next to each entry):
   at least Notion, Linear, Atlassian, Figma, Canva, Stripe, Supabase; one that cannot be checked shows the links and a
   plain line.

## Scope

In: the five items. Out: anything not in the retest list.

## Plain words

"Everyone in the team", "Last tried {date}", "You sign in on {service}'s own page; Trina keeps the sign-in, not your
password", "Privacy", "Terms", "Help".

## Steps

1. Plan (this file).
2. Items 1–4 (web; the one server line for item 2), i18n in five languages.
3. Item 5: check each service's pages, add the verified links and tools to `web/src/lib/connectors.ts`, show them.
4. Unit tests (item 1's default, item 2's line, item 4's words, item 5's data), e2e for item 1, screenshots.

## Risks

Item 1 changes a default: a team connection now reaches everyone unless the admin narrows it. That is what "For the
team" says; the dialog still shows who.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the touched unit tests, the connector e2e specs.

## Result

- 1: `TEAM_DEFAULT_ACCESS` (the whole team) for a team connection and a template; the old "only you" switch-back is gone.
- 2: a failed call sets `last_used_at` (service.ts noteFailure); the details say "Last tried {date}" while failing.
- 3: `gapps.admin.driveAbout` on Admin's Drive page. 4: `integrations.asked.mineNoteSignIn` for a sign-in service.
- 5: `CONNECTOR_DOCS` (lib/connectors.ts) with privacy, terms and help for Notion, Linear, Atlassian, Figma, Canva,
  Stripe and Supabase, and the tools Notion, Figma, Stripe and Supabase list on their own pages (first 12 shown, the
  rest on the service's page). Left out: Linear's tools (none listed), Atlassian's (its list is for its v2 address),
  Canva's (its pages give another address than the catalog's `https://mcp.canva.com/mcp`: to check separately).
