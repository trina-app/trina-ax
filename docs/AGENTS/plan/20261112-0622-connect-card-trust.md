# The chat's connect card trusts the app's list, not the AI's address

- Date (UTC): 2026-11-12 06:22
- Branch: `fix/connect-card-trust`
- Status: done
- Where: Team AX core (`server/src/chat/connect-service.ts`, `shared/src/`, `web/src/components/chat/ConnectCard.tsx`).
  Why: connecting a service from a chat is core (docs/REPOSITORY-RULES.md: AI connections go in the core first).
- Version impact: patch. A security fix and wording; the card request gains one optional field, no data change.

## Goal

QA (TC-135, TC-127/134 bugs 2, 4, 5, TC-137) found that the chat's "connect a service" card trusts whatever the AI
puts in `connect_service`:

1. **TC-135 / bug 4 (security).** The AI gave `https://notion-mcp.example.com/mcp` with the name "Notion", and the card
   said "Sign in to Notion". The only hint was the small address line. A person who trusts the name signs in at a
   server that is not Notion's, and that server gets the sign-in.
2. **Bug 2.** A member who already has their own Notion connection asks the AI to connect Notion and gets the team
   template's card. Finishing it would make a second Notion connection.
3. **Bug 5.** The template wording ("mcp.notion.com receives your sign-in token, even if the sign-in page is Notion's
   real one") reads oddly when the address is Notion's own, and the chat's template card says "your key" for a
   service you sign in to.
4. **TC-137 (check only).** The phone app says "Sign in from a computer" for every service but Google.

## Scope

In:

- **One list of known services, shared.** The Discover list (`web/src/lib/connectors.ts` CONNECTORS: id, name,
  official address) moves to `shared/src/service-catalog.ts` with `canonicalService`, `catalogAt(url)` and
  `catalogNamed(name)`. The web adds its logos to it; the server reads the same list.
- **Server (the tool handler), for a service the AI names:**
  - A name that names a listed service ("Notion", "Notion workspace", "notion") always gets the list's official
    address, kind and sign-in. The AI's address is never used for it. When the AI gave another address, the tool
    result says so (`note`), so the AI does not claim it connected the AI's address.
  - An address that is a listed service's gets that service's name, kind and sign-in, whatever name the AI wrote.
  - Anything else is an unlisted service: its name names no listed service, and the card marks it unlisted.
- **Server, a service this person already has (bug 2):** before the template lookup, the connections this person
  uses for the same service (the same address) are checked. A working one: no card,
  "already connected". Their own one that needs a sign-in or key: a **reconnect** card bound to that connection
  (`reconnect: true`; the card signs in again or takes a new key for it, never makes a second one, and Not now never
  removes it). A team one that needs attention: no card, an admin fixes it (as before).
- **Web card:**
  - Listed: a small "Official {name} address" line.
  - Unlisted (not a template): a warning box with the address in bold and plain words: the app does not know this
    service, check the address belongs to it. (The old host caution stays only on template cards: one warning, not two.)
  - A card whose name names a listed service but whose address is not the list's (an older server): the title shows
    the address, a red warning says it is not the official address, and there is no sign-in or connect button.
  - Reconnect: "Sign in to {name} again" / "New key for {name}" title and a line that it is already connected.
  - Template, sign-in: "Connect your own {name} account" and a note without "key".
- **Template dialog wording (bug 5)** in `components/integrations/AnswerDialog.tsx`: for the list's own address,
  "This is {name}'s official address…"; otherwise plain words without "sign-in token". Five languages.
- Tests that fail on the old code (server: made-up address with a known name, known address with a made-up name,
  existing own connection with a template, existing working connection; web: the warnings and the missing button).
- A `changes/` fragment and a DECISIONS.md entry (a rule changes: a known service's name means its official address).

Out:

- The phone app's sign-in for non-Google services (TC-137): findings below, no change to `mobile/`.
- The approval card, the outside-content gate and the Connectors pages (other branches).
- Settings' and Admin's add-by-address forms: a person typing an address there is not the AI.

## Steps

1. `shared/src/service-catalog.ts` + export; `web/src/lib/connectors.ts` builds CONNECTORS from it (same exports).
2. `connect-service.ts`: resolve the listed service before the template lookup; the existing-connection check; the
   reconnect card (kept.integrationId, version, created=false); the `note` in the result.
3. `shared/src/api/ws.ts` ConnectServiceRequest: optional `reconnect`. (The web finds a listed address itself from the
   shared list, so no `listed` field.)
4. `ConnectCard.tsx` + `lib/connectCard.ts` helpers; i18n keys in en, ko, ja, es, id.
5. AnswerDialog wording; the mock server's connect card uses the official Notion address.
6. Tests, checks, plan Result, PR.

## Risks

- Security: the AI chooses the name and the address. After this change the card's name is never a listed service's
  unless the address is that service's official one; the card request is built by the server, and the connect
  endpoint saves only what the card held. A look-alike name ("N0tion") is not caught by the name check: it is an
  unlisted service and gets the unlisted warning with the address in bold.
- A known service the person really wants at another address (a self-hosted GitLab, Stripe's plain HTTP API) can no
  longer be added from a chat under that name: the card offers the official one. An admin adds another address in
  Admin (unchanged); a different name ("Acme code server") still works as an unlisted service.
- Templates: an admin's template is trusted as before (its address is the admin's choice); a known name the AI gives
  with a made-up address is rewritten to the official address first, so a template at the official address is found.
- No migration. Five languages. Phone and desktop render the same card.

## TC-137: sign-in for other services in the phone app (findings, no change here)

- Web: `web/src/lib/mobile.ts` `openExternal(url, { purpose: 'google-oauth' })` refuses anything but
  `https://accounts.google.com/o/oauth2/v2/auth`. The card and `IntegrationRow` hide the sign-in button in the phone
  app and say "Sign in from a computer".
- Native: `mobile/src/protocol.ts` `parseMessage` drops an `external-open` whose purpose is not `google-oauth` or
  whose URL fails `googleOAuthUrl`; `App.tsx` opens only that URL with `Linking.openURL` (the system browser). Other
  https pages the WebView navigates to open in `WebBrowser.openBrowserAsync` (an in-app browser tab).
- Server: the sign-in's callback (`service.ts callback`) needs the browser that comes back to be signed in to the
  same Trina user (a live session), as the Google flow does. On iPhone the in-app browser tab does not share
  Safari's cookies, so a sign-in opened there comes back without a session and fails.
- What it would take:
  1. Native: a new purpose (say `service-oauth`, capability `external-service-oauth-v1`) whose URL must be https on a
     host of a listed service's official sign-in (the authorization addresses come from each service's OAuth
     discovery, e.g. `mcp.notion.com/authorize`, so the app needs the list of those hosts, or a rule "same site as
     the listed MCP address"), opened with `Linking.openURL` in the system browser like Google.
  2. Web: `openExternal` accepts that purpose when the app offers the capability; the card and the Connectors row
     show the sign-in button in the phone app, open the service's sign-in through it, and poll the flow as now.
  3. The person's system browser must be signed in to the same Trina user (as for Google today), or the server
     needs a one-time hand-off for the callback. That is a server design change of its own.
  4. **A store release is needed** (App Store and Google Play): the app has no over-the-air updates (no
     `expo-updates`), and the allowlist is in the app's code. Older apps keep "Sign in from a computer" because the
     web asks for the new capability first.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `tests/unit/connect-service.test.ts`,
`tests/unit/connect-continue.test.ts` (Bun 1.3.12), `web/test/unit/connect-card.test.tsx`,
`web/test/unit/connectors.test.ts`, the e2e `connect-continue.spec.ts`.

## Result

Built as planned, with these differences:

- No `listed` field on the card request: the web finds a listed address itself from the shared list.
- The existing-connection check compares whole addresses (as the old same-address check did), not
  `canonicalService`, which drops the query: two instances of one MCP server that differ only by a query are two
  services.
- The old "not on {name}'s own site" caution stays only on template and reconnect cards; an unknown service's card has
  the new warning box instead (one warning, not two).
- Korean or other translated names ("노션") are not matched to a listed service: the tool asks the AI for the
  service's own spelling, and such a card is an unknown service with the warning box.

Tests: server `connect-service` 33/0 (4 new, all 4 fail on the old handler), `connect-continue`,
`c-template-chat-schedule`, `schedule-connections`, `connected` 74/0 under Bun 1.3.12; web unit 2798/0; e2e
`connect-continue`, `integration-requests`, `integration-templates`, `connectors`, `connectors-hub`,
`phone-connectors` 52/0.
