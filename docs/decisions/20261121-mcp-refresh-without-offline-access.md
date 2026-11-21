# Every MCP connection gets a refresh token, asked for `offline_access` or not

- Date: 2026-11-21
- Status: accepted
- Supersedes: "Left out" in [The MCP connector stays connected until it is disconnected](20261120-mcp-connector-session.md) (refresh tokens only for apps that ask for `offline_access`); the rest of that decision stands
- Branch: fix/mcp-refresh-without-offline-access (open item of #127)

- **Ask:** since #127 a connection lasts until the person disconnects it, with a 90-day sliding refresh. An app that did
  not ask for `offline_access` got an access token alone, so its person signed in again every hour.
- **Who leaves it out:** our 401 says `scope="mcp:read"`, and current MCP clients take that `scope` first (the MCP
  TypeScript SDK's scope selection, SEP-835: `WWW-Authenticate` scope, then the resource metadata's
  `scopes_supported`). ChatGPT asks for `mcp:read` alone (`tests/unit/remote-mcp-http.test.ts`, its recorded flow).
  SEP-2207 (final, 2026-02) says Cursor, Claude, VS Code and other major clients do not ask for `offline_access`
  because they cannot tell whether the server wants it, and it tells resource servers not to put it in the 401. Claude
  and Claude Code were seen asking for it on our server (#127 audit `asked`), so they were not affected; Codex asks
  for it (its recorded flow).
- **Options weighed:**
  - (a) a refresh token for every connection, with #127's rotation, retry window, replay revocation and 90-day slide.
    Plain OAuth 2.1 leaves this to the server (the client's `refresh_token` grant type); our registration answer
    already tells every app it is registered for `refresh_token`. Many MCP servers do this.
  - (b) `offline_access` added by default: the same effect for the token, but on its own a refresh that leaves the
    scope out could narrow it away.
  - (c) longer access tokens: the bearer sent on every call lives longer, with no rotation and no replay detection,
    and the person still signs in again when it ends.
- **Rule (a, recorded as b):** every new grant holds `offline_access` (the token answer's `scope` names it, RFC 6749
  3.3, as it does for `mcp:admin` and `mcp:rooms` that the app did not ask for), and every code exchange and refresh
  issues a refresh token. A refresh that narrows the scope keeps `offline_access`: narrowing limits what the app may
  reach, not how long it stays. The consent page always shows "Stay connected: renew access by itself until you
  disconnect". Access tokens stay 1 hour. Everything that ends a connection in
  [20261120-mcp-connector-session.md](20261120-mcp-connector-session.md) ends these too.
- **Why:** the `offline_access` gate protected no person's data from another's. A refresh token reaches only the data
  of the person who allowed the app, on the scopes they chose, only for that app's client id (PKCE, public client); it
  rotates, a replay ends the connection, and every way the person loses access ends it. Claude's own connectors stay
  connected until disconnected, so the floor is the same here ("Claude Code is the floor").
- **Left out:** an app that registers `grant_types` without `refresh_token` still gets one (registration is not
  stored, and the answer says `refresh_token` for every app). `offline_access` stays in the protected-resource
  metadata's `scopes_supported` (SEP-2207 says SHOULD NOT; no client is known to break on it). Grants made before
  this change that did not ask have no refresh token: their app signs in once more.
- **Tests:** `tests/unit/remote-mcp-oauth.test.ts` (an app without `offline_access`: refresh token, rotation, narrowing
  keeps it, 90-day slide, retry window, replay ends it, other app refused, disconnect and `/oauth/revoke` end every
  token; the read-only default and the consent defaults now get one), `tests/unit/remote-mcp-http.test.ts` (ChatGPT's
  flow refreshes), `tests/security/remote-mcp-connection-session.test.ts` (without `offline_access`: the person's own
  connection only, another app refused, a late replay ends only that person's connection, deactivation ends it).
- **Version impact:** patch (no migration, no API shape change).
