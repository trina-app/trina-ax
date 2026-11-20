# The MCP connector stays connected until it is disconnected

- Date: 2026-11-20
- Status: accepted
- Supersedes: the connection's end in [the remote MCP connector](../DECISIONS.md) (a grant bound to the browser sign-in that allowed it, at most 30 days); the open item "a refresh token for a client that does not ask for `offline_access`" stays open
- Branch: fix/mcp-connector-session (user feedback, QA TC-5592..5596)

- **Ask:** a user of Trina AX MCP in Claude / Claude Code: "the connector was registered, but the token was dead and
  reviving it needs a trip to the browser; the server description says the connection ends when the team app session
  ends, so I'll hit this often." The owner's rule: Claude Code is the floor; Claude's own connectors (Google Drive,
  Notion) stay connected for weeks or months on a refresh token until the person disconnects.
- **Cause (code on dev before this):** `remote_mcp_grants.session_id` pointed at the browser sign-in that allowed the
  app, `REFERENCES sessions(id) ON DELETE CASCADE` (migration 107). So signing out in that browser deleted the grant
  and its tokens; that sign-in expiring (30 days fixed, not sliding) ended it too (`grant()` joined the session's
  `expires_at`); and `decide()` capped the grant at `min(now + 30 days, browser sign-in's end)`. On top of that a
  refresh token used a second time ended the whole connection at once, with no allowance for an answer lost on the
  network or two processes of one app (several Claude Code sessions on one computer) refreshing with the same token.
  The live potenlab server shows both: every grant's end equals its browser sign-in's end, and a grant revoked 84 s
  after a successful refresh with no disconnect in the audit log. Claude and Claude Code ask for `offline_access`
  (audit `asked`), so they do get refresh tokens; the client was refreshing.
- **Rule:**
  - Each grant gets its own `sessions` row (`connector = 1`, migration 130, additive): no token exists for it
    (`token_hash` is `connector:<grant id>`, never a sha256), it is not in **Settings › Security & devices** and cannot be signed
    out there. Live grants of live sign-ins are moved to such a row by the migration.
  - Access token 1 hour (unchanged). A connection ends 90 days after its last refresh (was: at most 30 days, often less);
    every refresh moves the grant's, its row's and the new refresh token's end.
  - Refresh tokens rotate, one live chain per connection. A token issued by a refresh records the token it came from
    (`remote_mcp_token_links`, migration 130, a side table because an older build inserts tokens without column names),
    and an access token records its first use. A spent refresh token may be presented again only while it is within
    5 minutes of being spent **and nothing it issued has been used yet** (the answer to the refresh never arrived, or a
    second process of the app refreshed with the same stored token at the same moment): what it issued is replaced and
    a fresh pair comes from it. Any other reuse is a replay and ends the whole connection, inside the window too.
  - The loser of such a race: the pair it got was replaced before it used it, so its next call is refused and its
    refresh token gets `invalid_grant`, without ending the connection. It reads its stored token again (Claude Code
    keeps one credential store for all its processes) or signs in again. It does not get another retry: that would let
    two chains live side by side.
  - Spent refresh tokens are kept (hashes only) until the connection ends, so a replay of any of them, however late,
    ends it. Expired or replaced access tokens and expired unused refresh tokens are deleted. The 4,096-token cap counts
    live tokens only. A spent refresh token inside the 5 minutes counts as a live credential for the rate limits, so a
    genuine retry is not slowed down.
  - Accepted gap: someone who copies a refresh token and uses it within 5 minutes of the app's own refresh, before the
    app used its new pair, replaces the app's pair. The app is then signed out (it shows) and the connection stays
    listed in Settings, where the person can disconnect it.
  - Still ends it: disconnect in Settings, the client's `/oauth/revoke`, a password change or reset, an admin signing
    the person out everywhere, removal from the team, deactivation (and turning the person back on does not revive it),
    becoming a guest, `must_change_password`, and 90 days without use. Signing out of one browser, or one sign-in
    expiring, does not.
  - A person's 51st connection ends their oldest one (audit `remote_mcp.disconnected`, `reason: 'too_many'`) instead
    of refusing the sign-in: connections now outlive sign-ins, and an app that signs in again leaves its old one behind.
  - Wording: the server's `initialize` instructions say "This connection stays until the person disconnects it or loses
    access." (was "ends when its authorizing team app session ends"); the consent page and Settings say the app stays
    connected until disconnected, what else ends it, and "Ends if unused by <date>". "Allowed in the current login" and
    the `currentSession` field are removed: no connection belongs to a login any more.
- **Why:** none of the session binding protected one person's data from another: the browser that allowed the app
  belongs to the same person, and every way a person loses access still ends the connection. The reuse window keeps the
  stolen-token defence for anything replayed later than a retry.
- **Left out:** refresh tokens for apps that do not ask for `offline_access` (ChatGPT may not; they sign in again every
  hour), tracked as before.
- **Tests:** `tests/unit/remote-mcp-lifetime.test.ts` (refresh after sign-out and after the sign-in expired and was
  swept, not a device, 90-day slide, expired refresh refused, live tokens bounded, two processes resolve to one chain,
  every revocation,
  the 51st connection, migration 130), `tests/unit/remote-mcp-oauth.test.ts` (rotation, retry window, replay),
  `tests/security/remote-mcp-connection-session.test.ts` (the row signs nobody in, other people, replay, other app,
  guests; review of #127: a reuse after the new pair was used ends the connection inside the window, 20 reuses leave one
  live chain, a replay of a token spent 8 days earlier still ends it), `tests/unit/remote-mcp-guide.test.ts`.
- **Version impact:** patch (migration 130, reader 1).
