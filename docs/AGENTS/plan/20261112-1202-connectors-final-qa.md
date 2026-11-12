# Connectors final QA: all tools in place, an open request stays, one word for it

- Date (UTC): 2026-11-12 12:02
- Branch: `fix/connectors-final-qa`
- Status: in progress
- Where: `web/` (Connectors' listed service page and the ask for a service). Why: the web app's own screens (see
  docs/REPOSITORY-RULES.md).
- Version impact: patch. Fixes on one page and one word; no API, data or migration change.

## Goal

Final QA on 9ecefea21:

1. A listed service's page before connecting shows 12 tools and "and N more." as plain text. "and N more" becomes a
   button that shows every tool in place (Figma's `weave_*` tools are then visible); the link to the service's page
   stays.
2. A member's open request disappears from their page (Notion) once the team has a connection to it that is not
   connected yet or that they may not use: the page shows only Connect. While their request is open the page keeps
   "Request sent" and "Cancel request", whatever team connections exist; a team connection they can use and that
   works is what ends the ask.
3. The same request says "Request sent" after the tap and "Already asked" after a reload. One word everywhere:
   "Request sent" (five languages); the old key goes.

## Scope

In: the three items. Out: anything else.

## Plain words

"Show all {count} tools", "Request sent", "Cancel request".

## Steps

1. Plan (this file).
2. ConnectorDetail: "and N more" expands in place (`connectors.toolsShowAll`).
3. ListedPage: the ask shows while the member's request is open, and while no team connection they may use works.
4. AskAdmin: one label for an open request; `serviceRequest.already` removed in all five languages.
5. Unit and e2e tests (request flow, connectors-hub).

## Risks

None on the server.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the touched unit tests, and the e2e specs for
requests and connectors-hub.

## Result

Filled in at the end.
