# A service that needs no sign-in, added with sign-in, is connected with no sign-in

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: fix/mcp-no-signin (QA TC-4771)

- **Ask:** adding a public MCP server that needs no sign-in (DeepWiki, `https://mcp.deepwiki.com/mcp`) as a custom
  connector failed with "This service does not offer sign-in to apps like this one. Try an API key instead." Is that by
  design? No: personal and team connections may need no sign-in (docs/INTEGRATIONS.md, the limits row). Only templates
  never take "no sign-in" (a personal key or sign-in is their point), and that stays. The form's default way in is
  sign-in, and "No sign-in" sits under Advanced, where nobody looked.
- **Rule:** Sign in on a connection that was never signed in, has no own app and is not from a template: when the
  service publishes no sign-in at all (no sign-in document answered anywhere, and none of those addresses was down),
  and it let the server start a session and list its tools with no key, the connection becomes one with no sign-in
  and is connected. Nothing opens. The change is written only while the connection is still as it was read (a sign-in
  that finished meanwhile, or a new address, wins), the answer says connected only when the check connected it, and
  the audit entry marks it as the server's own (`via: 'no_signin_probe'`). Sign-in documents that answered but cannot
  be used, a document address that is down, and a service that refuses its tool list without a key keep the old
  reason.
- **Why:** people who are not developers cannot tell a service that needs no sign-in from one that does. A new choice
  or a hint on the form would add words to every connector; this fixes the case where it happens.
- **Left out:** checking at Save (it would add requests to every sign-in connector's Save) and changing the default.
- **Tests:** `tests/unit/c-integrations-no-signin.test.ts` (also an unusable issuer, a 503 document address, a sign-in
  that finishes during the probe), `web/test/unit/integration-sign-in-state.test.tsx`.
- **Version impact:** patch.
