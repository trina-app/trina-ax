# A member asks an admin to add any listed connector, and can take the request back

- Date (UTC): 2026-11-12 09:30
- Branch: `feat/request-any-connector`
- Status: done
- Where: server `integrations/service-requests.ts` and its routes, shared contract, web Connectors pages (member and
  Admin). Why: connector permissions and team setup are core (see docs/REPOSITORY-RULES.md)
- Version impact: minor — new requestable services, new routes (withdraw, the admins' list, dismiss) and new screens

## Goal

QA TC-133. Today a member can ask an admin to add only Google Drive and the Google apps. A member who opens Notion,
Linear or any other service in the app's list that the team has not set up gets either Connect (their own) or nothing.
After this, every listed service can be asked for, the same way: "Ask admin to add it" → "Request sent" (and the member
can take it back), the owner and the admins get the notice in Activity, see the open requests in Admin › Connectors with
Add and Dismiss, Add opens the usual "Connect for the team" for that service, and each member who asked is told when they
can use it.

## Scope

In:
- The requestable services: the five Google ids plus the ids of `shared/src/service-catalog.ts`. Only those ids; never
  an address or free text from a member.
- A listed service "is added" for a member when a team connection to its official address exists that they may use;
  then their request closes ('added', a 'service.ready' notice) and a new ask is refused (`can_connect`). Checked after a
  team connection is made or changed, and on the 30-second check.
- A member who may add their own connections still sees Connect; the ask (for the team's) sits under it as a line.
- Withdraw: `DELETE /api/integrations/service-requests/:service` (the member's own open request). Closed with no reason
  (`closed_reason` NULL: the column's CHECK allows it, a table is never rebuilt, so no migration). It still counts
  toward the 10-a-day limit, so asking and taking back cannot flood the admins.
- The admins' list: `GET /api/admin/service-requests` (open requests by service: who asked, when) and
  `POST /api/admin/service-requests/:service/dismiss` (closes them, no reason, nobody is told; they may ask again).
  Audited. In Admin › Connectors a small "Asked by members" section: Add (a listed service: the team connect dialog; a
  Google one: its setup) and Dismiss. The Activity notice opens the service's page in Admin › Connectors.
- Names in notices and lists for listed services; i18n in five languages (English first).

Out: requests for services outside the list; changing who may use a team connection from the request.

## Steps

1. Plan (this file).
2. Shared contract: requestable ids, new endpoints. Server: catalog state, withdraw, list, dismiss, settle after team
   connection changes. Mock server for e2e.
3. Web: `AskAdmin` withdraw; member's listed page; Admin › Connectors section; notice names and links.
4. Tests: server unit, web unit, e2e (member asks → admin adds → member told). DECISIONS, INTEGRATIONS.md, changes/.

## Risks

- No migration (highest on dev: 346). Permissions: members only ask and take back their own; admins list and dismiss;
  the permission matrix gets the new routes. A member never sees who the admins are.
- The admin Connectors page and Connectors.tsx are being edited elsewhere: small inserts only.
- Five languages; phone and desktop.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the service request and connector unit tests, web
unit tests for the touched components, e2e for the request flow.

## Result

Built as planned, with no migration. Tests: `tests/unit/c-service-requests-catalog.test.ts` (5), the permission matrix
for the three new routes, web `service-requests.test.tsx` (new cases), e2e `request-connector.spec.ts` (2).
