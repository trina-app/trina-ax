# Read-only marks in shared chats: a change the name says asks on its card

- Date: 2026-11-18
- Status: accepted
- Supersedes: nothing; narrows "a read runs with no write card" of
  [Connected services in shared chats](20261118-shared-chat-connections.md) for marks the service alone gives
- Branch: fix/shared-readonly-tools (QA TC-4900, a follow-up of the #1276 review)

- **Ask:** in a shared chat a connection tool that the service marks read-only (MCP `readOnlyHint`) runs with no write
  card: after "Always in this chat" on the asker's own connection, or with no card at all on a team connection everyone
  may use. Nobody checks that mark. A service that marks a sending tool read-only (by mistake, or on purpose) let other
  people's words in the chat steer the AI into sending as the asker, or as the team, with no card.
- **Rule, the hint (every chat):** a tool is marked read-only only when it says `readOnlyHint: true` and not
  `destructiveHint: true` (`integrations/connections/mcp.ts`). A tool that says both is a change everywhere.
- **Rule, connection tools in a shared chat (default flipped after the security review of #1328):** a non-Google tool
  counts as a read only when all three hold (`integrations/connections/read-mark.ts` `readKind`):
  1. the hint above;
  2. its name, after NFKC, is plain ASCII with no invisible characters, and its first word (or the first word after a
     service prefix, `github_get_issue`) is a strict read verb: get, list, search, read, find, fetch, query, view,
     describe, show, count, lookup, retrieve (not export, download or check);
  3. no change word is anywhere in the name or title: short change verbs as a part of the name without its separators
     (send, post, creat, updat, delet…; so `sendmessage` and `resend_invoice` are caught), a few short ones as whole
     words only (put, set, add, run…).
  Everything else is a change: its own write card every time, as every change in a shared chat (no Always allow, no
  earlier yes). A marked tool that fails only rule 2 because its verb is not known (`scrape_as_markdown`) gets a
  separate "can't tell" card (`unsureGate`): Allow once (the rest of the answer), Always in this chat (that tool of that
  connection as it is now, `chat_card_approvals` kind `shared_unsure_tool`) or Don't run. The two cards stay apart, so a
  real change's card never offers Always and an Always on the "can't tell" card is final for that tool (the owner: no
  caps after an Always). Some reads now ask (`get_post`, `list_shared_files`): accepted, a card is the safe side. The
  AI's tool list, find_tools and call_tool say the same. A Google app keeps Trina's own list (`google-apps/catalog.ts`).
  First version (bd90411aa): a list of change words in the name. The review probed about 300 names; `resend_invoice`
  got through call_tool with no card, so the default was flipped to "a read only when the name plainly looks".
- **Rule, api_request:** in a shared chat a GET or HEAD asks on the request card like any other method: it is a read
  only by the AI's choice of method, and some APIs act on a GET (the room-read rule already treats it so). The tool's
  text says so there.
- **Not changed:** outside a shared chat the service's mark is taken as before (with the hint rule above). "Always in
  this chat" on the connection card still covers real reads. A tool whose name is a plain look-up and that secretly
  changes something is still a read: Trina cannot tell it apart, and the service is one the person or the team chose.
  Tools saved before this change keep the mark they were saved with until the connection's tools are read again.
- **Audit of the other "read" tools in a shared chat (no gap found):** every built-in tool in `SHARED_TOOLS` goes
  through `confirmSharedRead` with every team path it names (`PATH_ARGS`, nested in `edit_pdf` and `merge_pdfs`), so a
  read of a private folder asks the asker-only card; `skill` asks with the skill's own folder and a group skill some
  people may not use; `find_skills` lists only skills everyone in the chat may use; `who_can_open`, `answer_comments`,
  `share_with_person`, `stop_sharing` and `share_folder` read nothing into the chat by design; `box_shell` sees only
  folders everyone may open (20261118-devenv-shared-chats.md). Every connection call, read or write, passes
  `sharedGate` first (the asker-only card for their own connection, or for a team one that leaves someone out).
- **Tests:** `tests/unit/b-shared-readonly-tools.test.ts` (the review's probe names, look-alike and invisible
  letters, the kinds), `tests/unit/b-shared-readonly-calltool.test.ts` (find_tools and call_tool: `resend_invoice`,
  a tool marked read-only and destructive, look-alike names, the "can't tell" card and its Always).
- **Version impact:** patch (a card in a shared chat where none came).
