# Sign in with your own OAuth app (client ID) at services that do not register apps themselves

- Date (UTC): 2026-11-09 15:30
- Branch: `feat/oauth-own-client`
- Status: in progress
- Where: trina-ax core (`shared/src/api/integrations.ts`, `server/src/integrations/connections/`, `web/src/`). Why:
  connecting outside services for the AI is core (see docs/REPOSITORY-RULES.md)
- Version impact: minor. A new optional field on the connection and template API, one add-only migration.

## Goal

Signing in at an MCP server works today only when the service lets apps register themselves (dynamic client
registration, RFC 7591). Google's own MCP servers (Gmail, Calendar, Drive, Docs, Sheets, Chat: `*mcp.googleapis.com`)
and HTTP APIs such as NAVER WORKS (`www.worksapis.com`) do not: they need an app made in their console (Google Cloud,
NAVER WORKS Developer Console) and its client ID and secret. docs/INTEGRATIONS.md lists this under "Not in phase 1".

After this change an admin (or a member, for a personal connection) enters that app's client ID and secret once:

- MCP server: client ID, secret and optionally the scopes; the sign-in and token addresses are found from the server's
  address as today. Google's Gmail and Calendar MCP servers then sign in.
- HTTP API: sign-in by OAuth becomes a choice next to a key, with the client ID, secret, sign-in address, token address
  and scopes. `api_request` then sends the person's token, refreshed when it runs out.
- A template carries the app: each member it is for signs in with their own account through the team's app, and never
  sees the app's secret.

## Scope

In:
- Contract: `oauthClient` (clientId, clientSecret write-only, authorizationUrl, tokenUrl, scope) on connection and
  template input and patch; a view without the secret (`hasSecret`) for whoever manages it.
- Server: stored like keys (the secret sealed in the connection key directory, its own AAD); the sign-in uses the given
  app instead of registering one; manual addresses skip discovery; no `resource` for an HTTP API; Google gets
  `access_type=offline` and `prompt=consent` (no refresh token otherwise); `expires_in` given as text is read;
  `api_request` refreshes once after a 401. A new app (ID, secret, addresses, scopes) drops the sign-in, as a new address
  does; on a template it drops the members' connections.
- Web: the add/edit dialog shows the app's fields when sign-in is chosen (MCP: behind "use my own app"; HTTP: always),
  with the address to register at the service (this team's `/api/integrations/oauth/callback`) to copy.
- Docs: INTEGRATIONS.md section with the Google and NAVER WORKS steps, DECISIONS.md, CHANGELOG, API docs.

Out (later):
- Requests to one member stay with self-registering services (a template covers the own-app case).
- Revocation addresses for manual setups, Discover entries for Google, a built-in NAVER WORKS bot (rooms).
- Real Google and NAVER WORKS sign-ins: no app exists yet; tests use the fake services.

## Steps

1. Contract and migration 338 (add-only: `oauth_client`, `oauth_client_enc`, `oauth_client_key_version` on
   `integrations` and `integration_templates`; the policy triggers also watch the new columns).
2. oauth.ts and service.ts: the own app in create, update, authorize, callback, refresh; HTTP sign-in; retry after 401.
3. templates.ts: the app on a template, used for its members' sign-ins, a change drops their connections.
4. Web dialog, form logic and the five languages.
5. Tests: a fake authorization server without registration, a fake OAuth REST API, secret canaries.
6. Docs.

## Risks

- Security: the client secret is a new secret. It must never appear in a response, log, audit entry, flow or tool
  result (canary tests), members of a template never see it, and it is hidden in what services send back like tokens.
- A sign-in made with one app must never be used with another: any change of the app drops the stored tokens.
- Migration 338 on top of 337 (highest on `dev`); add-only, reader level unchanged.
- Five app languages for every new word; phone (the fields are in the same dialog) and desktop.
- Existing self-registering sign-ins must work unchanged (the existing OAuth, template and request tests).

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, `bun run docs:api` + `tests/unit/docs-site.test.ts`,
every `tests/unit/c-integration*` file and the new one, `bun run test:web`, `bun run build:web` and the full web e2e.

## Result

Filled in at the end.
