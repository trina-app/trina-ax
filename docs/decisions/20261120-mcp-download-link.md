# App connectors: download links and raw reads

- Date: 2026-11-20
- Status: accepted
- Supersedes: none (the mirror of "App connectors: one-time upload links for big files" in [the archive](../DECISIONS.md))
- Branch: feat/mcp-download-link (QA TC-5589..5591)

- **Ask (user feedback):** There was `create_upload_link` but no download. `read` gives numbered lines (cat -n), so
  a client cannot write a file to disk as it is: fixing a .md with local tools took five `edit` calls, and a 19 KB HTML
  page would have had to be retyped. The loop people want is download, change locally, upload.
- **Rule:** A connector-only tool `create_download_link` (`remote-mcp/download-link.ts`), `mcp:read` (not in
  `WRITE`, `readOnlyHint: true`), in `CONNECTOR_ONLY` with the upload tools. Input: `path`. It runs the read tool's
  check (`authorize` 'read' with the current folder rules; a folder, a link, a file with more than one name, a
  quarantined output refused) and answers `{url, method: 'GET', path, size, uses, expiresAt, command}` with
  `curl --fail -o "<local file>" "<url>"`. The file joins the session's read scope as a read does (before the link is
  stored; a full scope refuses), so a later save to a wider place is judged by it.
- **Token and binding.** `tax_dl_` + 32 random bytes; only the sha256 is stored (migration
  `129_a_remote_mcp_download_links.sql`). A link is bound to the person, the grant, the path as authorized and the
  file's version at link time (inode, size, mtime). It is valid 10 minutes and answers at most 3 GETs (a retry or a
  resumed download: Range works); 10 links a minute and 20 open links per grant, as the upload links.
- **GET order.** Ingress rate limit (a live link not counted with anonymous traffic); a foreign `Origin` is refused
  before a use is taken; one use is taken in one statement (`UPDATE ... SET uses=uses+1 WHERE uses<max_uses AND
  expires_at>now RETURNING *`); then the grant (not revoked or expired, same person, `mcp:read`), the person's read
  permission now and the version are checked. Every refusal after the token is the same 404 `invalid_link`. The bytes
  go through `streamFile` (one descriptor of the very file the check saw, `O_NOFOLLOW`; `attachment` with the UTF-8
  file name, the type from the extension, `nosniff`, a sandbox CSP), with `no-store`.
  A Range answer carries the whole range asked for (`streamFile` `wholeRange`, never cut at `RANGE_MAX`: `curl -C -`
  takes a short 206 as the end of the file, and an overwrite upload of that copy would cut the team file). Conditional
  headers (If-None-Match, If-Modified-Since, If-Match, If-Unmodified-Since, If-Range) are dropped, so a GET always
  answers 200 or 206, never a 304 that uses up a GET. A Range past the end answers 416 with `Content-Range: bytes
  */<size>`, is audited (`reason: 'range'`) and gives the use back.
- **Audit.** Link: `remote_mcp.tool` `{tool: 'create_download_link', ok, path, size, expiresAt}`. Each GET:
  `remote_mcp.download` (actor = the person, target = the grant) `{via: 'connector_link', ok, path, use, size}` or
  `{ok: false, reason}`. Never the token or its hash; `loggablePath` hides it. Rows go with the account
  (account-removal.ts) and the grant (cascade); expired rows are purged with the upload links.
- **Raw read.** `read` gets `raw: true` (all callers, not only the connector): the exact text of a plain UTF-8 file
  (no NUL, valid UTF-8, a BOM kept) that fits one read (`READ_TEXT_CHARS` and `READ_TEXT_TOKENS`), with nothing
  added. Converted types (Office, PDF, Hangul, sheets, images, media), other bytes and longer files are refused with
  the way on. It counts as a whole read, so `write` and `edit` may follow.
- **Guide.** One line in the `initialize` instructions: "To edit a whole file with local tools: create_download_link
  and curl -o, then create_upload_link (overwrite)." The guide's length budget in its test goes from 1700 to 1800.
- **Tests.** `tests/unit/remote-mcp-download-link.test.ts`; `tests/security/remote-mcp-coverage.test.ts` lists the
  route.
