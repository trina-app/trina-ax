# The connect step line uses the card's trusted name; the warning names the official address

- Date (UTC): 2026-11-12 09:28
- Branch: `fix/connect-step-line`
- Status: done
- Where: Team AX core (`shared/src/service-catalog.ts`, `shared/src/step-labels.ts`, `server/src/chat/connect-service.ts`,
  `web/src/components/chat/ConnectCard.tsx`). Why: the chat's connect card is core (docs/REPOSITORY-RULES.md).
- Version impact: patch. Words on the step and the card, plus one optional field on the card request. No data change.

## Goal

QA retest of TC-135 (after #582 and #588). The AI calls `connect_service` with the name "Notion" at a made-up address.
The card is titled by the host, as #582 meant, but the step line above it still reads "Connect service · Notion" (the
AI's name). The card's warning also says only that the app does not know the address. It does not say that this is
not Notion's address, or what Notion's address is.

## Scope

In:

- One shared rule for the name a connection may be shown under, `trustedServiceName(name, url)` in the shared list
  module:
  - the list's name for exactly an official address, or for a listed name at its official host or with no address;
  - the host when the name is, looks like or holds a listed service's name, or mixes alphabets, and the address is
    not official;
  - otherwise the name itself.
- The step line (`stepLabel` for `connect_service`) uses that rule. Once the server has built the card, it sets the
  step's label to the card's own name, so the step and the card always match, reconnect and template cards included.
- When the AI's name matched a listed service but the address is not the official one, the card request carries
  `notOfficial: { name, url }`. The card's warning then says: "This is not Notion's official address. Notion's official
  address is mcp.notion.com. Connect only if you know and trust this one." Five languages. A reconnect card for an old
  connection under such a name gets it too.

Out: the Connectors pages; the template dialog (its address and name are the admin's).

## Steps

1. Add `trustedServiceName` to the shared list module and use it in `stepLabel` and in the server's naming.
2. The server patches the step label to the card's name and sets `notOfficial`.
3. Add the `notOfficial` field to `ConnectServiceRequest` (optional).
4. Card warning text in en, ko, ja, es, id.
5. Tests, DECISIONS and a changes fragment.

## Risks

- A step label shows the host instead of the AI's name. That is intended, and it is the same name as the card's.
- Old answers saved with the AI's name keep their stored label. Only new steps change.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/step-labels-tools.test.ts`,
`tests/unit/connect-service.test.ts` (Bun 1.3.12), `web/test/unit/connect-card.test.tsx`, `web/test/unit/connectors.test.ts`.

## Result

Built as planned, with one difference: a step takes one patch per call (`TurnExec.patchToolStep`). So the server does
not relabel the step when it opens the card. `stepLabel` already gives the trusted name from the AI's input while the
card is open, and the card's own name (for a template or reconnect card) goes with the outcome patch when the card
closes. The new tests fail on the dev before this change: the step label test, the step and `notOfficial`
checks in the editions test, and the old-connection reconnect test.
