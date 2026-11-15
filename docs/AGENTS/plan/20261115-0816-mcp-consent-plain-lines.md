# AI app connections: plain lines for an expired request, the connector off, and the Connect dialog

- Date (UTC): 2026-11-15 08:16
- Branch: `fix/mcp-consent-plain-lines`
- Status: done
- Where: server/src/connectors/remote-mcp, server/src/routes/remote-mcp.ts, web/src/pages (ConnectorConsent, AiApps),
  web/src/components/integrations/AiAppConnect.tsx. Why: core connector code and its web pages (docs/REPOSITORY-RULES.md)
- Version impact: patch, three wording and display fixes on existing pages; the API keeps its codes and only adds
  `params.reason` to one 404

## Goal

QA TC-2970, TC-2971, tracking TC-3032.

1. An app connection request that expired, or that another login session already opened, shows "This request expired
   or was opened in another login session. Connect again from the app." instead of "Not found or no access.", and the
   old request with Allow / Deny is hidden (also when it expires while the page is open and the person presses Allow).
2. With the connector off on the server, an old connection no longer says "Connect again to use conversations." (that
   cannot work while it is off); the page's off line already says why, and Disconnect stays.
3. The Connect dialog for one app (for example Claude Code) waits for that app. When a different app connects
   meanwhile, it says so in one separate line and keeps waiting, instead of "Connected: Claude".

## Scope

In: the three fixes, all six languages for the one new line.
Out: other consent or connector changes.

## Steps

1. Server: the consent request lookup throws its own OAuth code for "no such request / expired / opened by another
   session"; the browser routes answer it as `not_found` with `params.reason = 'request_expired'`. A real no access
   (guest, temporary login: 403) and the connector off stay as they are.
2. Consent page: that reason shows `connectors.expired` and hides the request; on Allow / Deny too.
3. AI apps page: the reconnect lines only while the connector is on.
4. Connect dialog: a new connection counts only when it belongs to the dialog's app (`appIdFor`); another app's new
   connection gets one line, "{name} connected. Still waiting for {app}.", and refreshes the list.
5. Unit test (server), web tests, e2e where specs cover these pages, screenshots 1440 and 390.

## Plain-words check

New line: "{name} connected. Still waiting for {app}." No internal words. Removed: the "Connect again …" line while
the connector is off; the generic error and the stale request on an expired consent page.

## Risks

No migration. The 404 keeps its status and code, so older apps behave the same. Six languages.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, tests/unit remote-mcp files, `bun run test:web`,
`bun run build:web`, e2e specs for the consent and AI apps pages.

## Result

Built as planned. The server keeps 404 / `not_found` and adds `params.reason = 'request_expired'`; the page hides the
request on that reason. One existing e2e check changed: the Claude dialog now waits for an app named Claude, so its
fake connection is called "Claude" instead of "Synthetic Claude" (which belongs to the Other apps row).
