# Connector sign-in: services that accept only approved apps, and failed sign-ins that fill the limit

- Date (UTC): 2026-11-13 10:27
- Branch: `fix/connector-signin-approved-apps`
- Status: done
- Where: `server/src/integrations/connections/` (oauth.ts, service.ts, text.ts), `server/src/routes/integrations.ts`,
  `shared/src/service-catalog.ts`. Why: connectors are core (see docs/REPOSITORY-RULES.md)
- Version impact: patch. Sign-in that failed now works where the service takes a client metadata document, and a
  refused sign-in says why. No new screen, setting or API change (one new public document, off the app's JSON API).

## Goal

Connect on a listed service saves the connection (needs sign-in), then asks the server for the service's sign-in
address. Several services refuse the app the server registers for itself (dynamic client registration):

- Canva registers the app, but its sign-in page answers "Invalid redirect URI." (HTTP 400) for any callback that is
  not localhost or claude.ai. The person sees an error page, the connection waits for a sign-in forever, and later the
  card says the service did not accept the key or sign-in.
- Figma (registration 403 for everyone), Vercel, Square, Intercom, Indeed (400: callback not allowed) and Railway
  (403: registration turned off) are told "This service does not offer sign-in to apps like this one. Try an API key
  instead." These services take no API key, so the advice is wrong.

And every Connect saves a connection first. Failed or abandoned sign-ins leave "Sign-in needed" rows that count toward
the 20 personal connections, so after a few tries the person cannot add anything.

## Scope

In:
1. A Client ID Metadata Document (MCP authorization 2025-11-25, draft-ietf-oauth-client-id-metadata-document) at
   `GET /api/integrations/oauth/client-metadata.json`: public, JSON, `client_id` is its own address, the product's name,
   our callback, authorization code + refresh token, no client secret.
2. Sign-in tries the app registration first (services that work stay as they are). When registration is refused (4xx)
   or the sign-in address refuses the app, and the service says it takes metadata documents, and this server's address
   is public https, it signs in with the document's address as the client ID. That client is stored like a registered
   one, so the token exchange and refreshes use it.
3. Before the sign-in address goes to the browser, the server opens it once (no redirects, 5 s). Only a clear refusal
   counts: HTTP 400, or another 4xx whose text names the redirect address or the client. 2xx, 3xx and a Cloudflare
   challenge pass; a timeout or a network error lets it through.
4. A new reason `oauth_approved_apps_only`: "This service lets only apps it has approved sign in, and it has not
   approved this one yet." with who can fix it. `oauth_no_registration` stays for a service without registration.
   The connection keeps the reason (Settings › Connectors and the chat card show the server's words).
5. Connections that never finished a sign-in do not count toward the personal limit, and Connect for the same address
   reuses the one that is waiting instead of saving another. They have their own cap (the same 20) so they cannot pile
   up without end. Nothing that was ever signed in is deleted or reused.
6. Catalog: Netlify's documented address is `https://mcp.netlify.com/mcp`; the old one stays in `otherUrls`.
7. Tests: unit tests with a fake service; a table over recorded metadata shapes; a network check of every listed
   address (`CONNECTOR_NETWORK=1`, `bun run check:connectors`), never in the normal unit run and never registering.

Out: per-service notes or buttons; Google's own-app work; the connector detail page; asking Figma, Canva and the
others to approve the app (a business step, not code).

## Steps

1. Plan (this commit).
2. oauth.ts: `CIMD_PATH`, `clientMetadata(origin)`, `metadataClient()`, `cimdSupported` from metadata, a registration
   refusal as `oauth_approved_apps_only` (4xx), `preflight()`. service.ts authorize: DCR → preflight → CIMD → preflight.
3. routes/integrations.ts: the document (origin from the request's public address), server-app route registry.
4. text.ts: the reason in five languages; KEY_REASONS.
5. service.ts create: limit counts signed-in or key connections; reuse a waiting connection for the same address.
6. Catalog: Netlify.
7. Tests, changes fragment, docs/INTEGRATIONS.md lines.

## Risks

- No migration. The client stored with a connection is the same shape (client ID, no secret, method none).
- The preflight sends the sign-in address (with state and code challenge, no secret) to the service once from the
  server; the browser sends the same address anyway. It fails open, so a slow service is not blocked.
- A metadata document is fetched by the service from this server: only offered when the address the person uses is
  public https (not localhost, an IP or a private name). Office mode and local dev keep the old path.
- Reusing a waiting connection changes what POST /api/integrations returns for a repeated Connect (the same id). The
  web and the chat card use the returned id, so the flow is the same.
- Five app languages: only server text (text.ts) changes; `bun run check:i18n`.

## Tests

`bun run typecheck`, `bun run check:i18n`, `bun run check:docs`, the integration unit tests
(`tests/unit/c-integrations-*.test.ts`, templates, requests, server-app route registry, connect-service), and the new
network check once.

## Result

Built as planned. `oauth.ts chooseClient` holds the client choice (the stored or a newly registered app, the
preflight, then the metadata document); service.ts calls it. The document is served by `routes/integrations.ts`
with the addresses of the configured public address that matches the request's host (so https behind a tunnel). A
registration 4xx is now `oauth_approved_apps_only` (it was `oauth_unsupported`, "try an API key"); a service with no
registration address but a metadata document gets the document too. Own apps skip the preflight (their refusals have
their own words). `net.ts` gained a test-only hook (`answerForTests`) so recorded metadata can be replayed.

Tests: `tests/unit/c-integrations-approved-apps.test.ts` (fake `/mcp-strict` service, the limit, the reason's words,
Netlify, and a table over all 41 recorded catalog probes in `tests/fixtures/connectors/sign-in-metadata.json`);
`tests/network/catalog-sign-in.test.ts` (`bun run check:connectors`): all 42 listed addresses answered 401 with
usable metadata on 2026-11-13. Which services the document fixes (Canva, Vercel, Railway and Indeed advertise it)
can only be shown on the deployed server, which the services must be able to reach.

Review changes (PR #734, requested by an independent review):
- The limit: a new connection always needs fewer than 20 own connections that work (or have a key); a sign-in one also
  fewer than 20 waiting. The callback refuses a first sign-in over 20 (`limit`, "remove one, then sign in again"), and
  an edit that makes a connection stop or start waiting is checked too. The chat's connect card counts the same way
  (`personalCounts`, `personalFull`).
- The preflight reads at most 4 KB with bounded patterns (a 64 KB page of "<" took 1.17 s before); a refused try is a
  failed flow, so it counts toward the 20 sign-in tries an hour.
- Reusing a waiting connection applies the new name, notes and write rule; a different short name makes a new one.
- Registration: only 400, 403 or an `invalid_redirect_uri` / `invalid_client_metadata` error mean "approved apps only";
  429 is `oauth_busy`; others keep `oauth_unsupported`.
- Only a clear refusal (the redirect address or the client named) stops a sign-in without a metadata document; a stored
  app that is refused gets one fresh registration first.
- The document answers 404 at a host that is not a configured public address; `Cache-Control: private`.
- `answerForTests` documents that it answers before the name lookup (offline tests only).
- After the re-review: only a refusal of the app (`oauth_approved_apps_only`) is kept as a failed flow, so a service
  that is down or busy never locks a person out of signing in; the sign-in offers the document only at an address the
  route serves it at (one shared helper, `documentOrigins` / `documentOriginAt`).

PR: https://github.com/trina-app/trina-ax/pull/734
