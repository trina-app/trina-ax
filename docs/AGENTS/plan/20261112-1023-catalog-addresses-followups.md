# Catalog addresses (Atlassian v2, Canva), Figma's Weave tools, who a team connection is for

- Date (UTC): 2026-11-12 10:23
- Branch: `fix/catalog-addresses-followups`
- Status: done
- Where: `shared/src/service-catalog.ts` (the one list), `server/src/chat/connect-service.ts`, `web/` (Connectors and
  the add dialog). Why: the core's connectors (see docs/REPOSITORY-RULES.md).
- Version impact: patch. Atlassian's listed address moves to its current one and the old one stays official, so
  nothing saved stops working; no API shape, data or migration change.

## Goal

1. **Atlassian and Canva addresses**, checked on their current official pages (2026-11-12):
   - Atlassian: https://developer.atlassian.com/cloud/rovo-mcp/ gives `https://mcp.atlassian.com/v2/mcp`; its tool list
     is "only available with Atlassian MCP v2" (support page); the changelog says users outside the v2 cohort keep the
     v1 tools until their cohort moves, so v1 still works. v2 signs in with dynamic client registration (its
     authorization server publishes a registration endpoint). → New connections use v2; v1 stays an official
     Atlassian address, so a connection saved at v1 keeps working and is still "Atlassian" on cards and pages.
   - Canva: Canva's MCP announcement (https://www.canva.dev/blog/developers/canva-mcp-ga/, 2026-10-27) gives
     `https://api.canva.com/connect/v1/mcp`, signed in with "your app's OAuth client" (its authorization server
     publishes no registration endpoint). The list only holds services that sign in without an app of their own, and
     `https://mcp.canva.com/mcp` still answers with dynamic client registration. → The list keeps
     `mcp.canva.com/mcp` for new connections and also accepts `api.canva.com/connect/v1/mcp` as an official Canva
     address (someone who adds it with their own app sees it as Canva, not as an unknown service).
   - The connect card's rules (#582/#588/#597) treat every official address of a service as that service: the card's
     name, "official", and "already connected" (a connection at the old address is the same service, never a second
     one).
   - Tools on the page: none for Atlassian (its default v2 address offers discover/execute tools, the full list is
     only behind `?tools=all`) or Canva (its tool list is not tied to the address the list uses); their links stay.
2. **Figma**: the nine `weave_*` tools from https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/.
3. **Who a team connection is for, outside Advanced**: the add dialog (Connect for the team, Add by address) shows
   one line "For: Everyone · Change" under the address; Change opens Advanced at the chooser.

## Scope

In: the three items. Out: other services' addresses.

## Plain words

"For: Everyone", "For: Finance, Bob", "Change".

## Steps

1. Plan (this file).
2. `otherUrls` in the list; `officialService`, `catalogAt`, `trustedServiceName`, a `sameListedService` check in
   connect-service, the web's `connectorFor`/`isConnected`; tests.
3. Figma's Weave tools; the dialog's "For" line (5 languages); tests; DECISIONS entry (adds to "The chat's connect
   card trusts the app's list", reverses nothing).

## Risks

A changed listed address: covered by keeping the old one official. The Weave tools' page does not say they are on
the remote server (listed as the page lists them).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, shared and server catalog/connect-service tests, web
unit tests, connector and connect-card e2e specs.

## Result

Built as planned. Checked on 2026-11-12 also by asking each address's OAuth metadata: Atlassian v2's authorization
server publishes a registration endpoint; Canva's api.canva.com one (www.canva.com) does not, mcp.canva.com does. A
DECISIONS entry ("A listed service can have more than one official address") adds to the connect card's trust rule.
