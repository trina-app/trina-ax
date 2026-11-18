# An office owner is told once when Claude Code connections were removed from the Mac

- Date: 2026-11-17
- Status: accepted
- Supersedes: none
- Branch: feat/office-mcp-removed-notice (QA TC-4470)

- **Ask:** in office "Mac login" mode (`authMode` local-login), the server empties the MCP settings of this Mac user's
  `~/.claude.json` at start and after every AI answer (engine/claude-json-guard.ts, by design since security round 4).
  It saves a copy to `config/claude-mcp-backups/` and audits it. A new install lists what would go and stops. An
  existing install that auto-updated into this got no notice, so an owner who also used Claude Code on that account lost
  their connections without being told.
- **Rule:** Admin › Home shows the owner one card, once: the title ("Trina removed Claude Code connections from this
  Mac"), why, the removed connections by name, the copies folder, and the two commands (`teamax configure
  --claude-token-file <file>` to switch to the sign-in token, `teamax claude-mcp restore <copy>` to put them back).
  Closed (✕ or "Got it"), it never shows again for that owner (`prefs.officeMcpNotice: 'seen'`). Admins and members do
  not see it. Outside office local-login mode, or before anything was removed, there is nothing to show.
- **Source:** what the server already records. Each removal's audit entry `engine.claude_json_mcp_removed` now carries
  `names` (the servers of `mcpServers` and `enabledMcpjsonServers`, at most 20). For entries written before that, the
  names come from the copy the entry names (only a file of the copies folder by its base name). There is no new table
  and no migration. Endpoint: `GET /api/admin/office-claude-mcp-notice` (owner).
- **Names are data an AI turn may have planted:** only names of plain letters, digits and a few signs (at most 80) are
  shown; others are counted. The card says that a copy saved after an AI answer may hold something the AI added, and to
  put back only connections the owner recognises (the restore command lists each one and asks again).
- **Words:** "Claude Code connections", never "mcpServers" or "MCP". The commands stay as they are: the owner of an
  office Mac ran the installer in Terminal, and the docs use the same commands.
- **Left out:** stopping the guard on update, or switching such installs to the token mode on their own. The guard is a
  security boundary, and the switch needs a token only the owner can make. The card also shows on a new install, after
  the installer already asked. Once is harmless there.
- **Retention:** the notice reads the audit list. If the audit cleanup removed every removal entry before the owner
  opened Admin, the card does not show. Accepted for a one-time notice.
- **Tests:** `tests/unit/office-claude-mcp-notice.test.ts`, `web/test/unit/office-mcp-notice.test.tsx`.
- **Version impact:** server and web; no migration. New screen text in six languages.
