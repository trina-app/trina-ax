# Connectors QA pass: one place per connector, names that fit, plain team wording, Google first

- Date (UTC): 2026-11-12 07:25
- Branch: `fix/connectors-qa-pass` (on top of `feat/admin-connectors-member-ui`, PR #586)
- Status: in progress
- Where: `web/` (Connectors and Admin › Connectors). Why: the web app's own screens (see docs/REPOSITORY-RULES.md).
- Version impact: patch. Fixes on the Connectors pages; no API, data or migration change.

## Goal

QA rows from the 2026-11-12 pass on the Connectors pages:

- **TC-179 / bug 1**: a team template the member has not connected yet is in Your connectors ("Connect") and again in
  Discover. Rule: Your connectors is what you have (or what the team set up for you); Discover is the rest. So a
  service a team template (or a team connection) covers is not offered again in Discover.
- **TC-266**: at 390 px a Google page's name is cut ("Google D…") and the state squeezes it. The name wraps; the state
  and ⋯ go on their own line on a phone.
- **TC-138**: Discover starts with the Google ones, in their order (Drive, Gmail, Calendar, Docs, Sheets), also when
  one is not set up yet; Drive is no longer last.
- **Bug 3**: a team connection's page tells the person "Connect … with your own account". A team connection uses the
  team's account: its page says so.
- **TC-134**: Admin › Connectors, a listed service's page: the main button is "Connect for the team" (one key, the
  admin chooses who), the ⌄ has "As a template" and a clear "Just for me" (the admin's own connection, from their
  Connectors page).
- **TC-132**: a listed service's page before connecting: instead of only "Its tools show here once you connect it", a
  plain line on what happens, and the service's address. A verified tool list per service needs the services' own
  documentation checked one by one; that is out of this PR (see Out).

## Scope

In: the six items above.

Out (own PRs, plan each first):
- TC-133: asking an admin for a listed service (Notion, …) like the Google ones. The server only accepts Google
  services today (`service-requests.ts` RequestableService), so it needs a server change (what "set up" means for a
  listed service: a team connection or template covering the member, or members allowed to add their own).
- TC-132's tool lists: each popular service's official tool list, checked against its own documentation.

## Plain words

New words: "Connect for the team", "Just for me", "{name} is connected for the team: the AI uses the team's account in
the chats of the people it's for."

## Steps

1. Plan (this file).
2. Discover filter (templates' and team connections' addresses), Google order, AppDetail name and phone header.
3. Team connection wording; Admin listed page Connect menu; TC-132 line.
4. i18n (five languages), unit and e2e tests, screenshots at 1440 and 390, light and dark.

## Risks

None on the server. The e2e specs that count Discover cards or read the Connect menu.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the touched unit tests, and the connectors e2e specs.

## Result

Filled in at the end.
