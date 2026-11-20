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
  - Refresh tokens rotate. A spent one still works within 5 minutes of its first use (each time a fresh pair; the token issued first stays
    good, so two processes each keep their own chain); later it is taken as stolen and the whole connection ends, as
    before. Only the presented refresh token is spent; access tokens already given out end on their own (1 hour) or
    with the connection. Spent tokens are kept 7 days to recognise a replay, expired ones are deleted, so a connection
    in use for months stays far below the 4,096-token cap.
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
  swept, not a device, 90-day slide, expired refresh refused, token rows bounded, two processes, every revocation,
  the 51st connection, migration 130), `tests/unit/remote-mcp-oauth.test.ts` (rotation, retry window, replay),
  `tests/security/remote-mcp-connection-session.test.ts` (the row signs nobody in, other people, replay, other app,
  guests), `tests/unit/remote-mcp-guide.test.ts`.
- **Version impact:** patch (migration 130, reader 1).
