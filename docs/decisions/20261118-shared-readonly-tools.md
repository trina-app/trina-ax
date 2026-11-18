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
- **Rule, connection tools:** in a shared chat (`BuildCtx.shared`) the service's read mark counts only when the tool's
  own name and title do not say a change (`integrations/connections/read-mark.ts` `readsHere`, `namedAsChange`). A verb
  such as send, create, update, delete, publish, submit, revoke anywhere in the name (`slack_send_message`), or one
  that is also a noun (post, share, add, comment, invite, archive, pay, charge…) as the name's verb (`post_message`,
  `github_add_comment`, never after a read verb: `get_post_comments`), makes the call a change: it asks on its own write
  card every time, as every change in a shared chat does (no Always allow, no earlier yes). The AI's tool list,
  find_tools and call_tool say the same ("Changes something at the service"). A Google app keeps its mark: its tools are
  Trina's own list as well (`google-apps/catalog.ts`, a read only when both say so).
- **Rule, api_request:** in a shared chat a GET or HEAD asks on the request card like any other method: it is a read
  only by the AI's choice of method, and some APIs act on a GET (the room-read rule already treats it so). The tool's
  text says so there.
- **Not changed:** outside a shared chat the service's mark is taken as before. "Always in this chat" still covers real
  reads (the owner: no caps after an Always). A tool whose name gives no sign of a change and that the service marks
  read-only is still a read: Trina cannot tell it apart, and the service is one the person or the team chose to connect.
- **Audit of the other "read" tools in a shared chat (no gap found):** every built-in tool in `SHARED_TOOLS` goes
  through `confirmSharedRead` with every team path it names (`PATH_ARGS`, nested in `edit_pdf` and `merge_pdfs`), so a
  read of a private folder asks the asker-only card; `skill` asks with the skill's own folder and a group skill some
  people may not use; `find_skills` lists only skills everyone in the chat may use; `who_can_open`, `answer_comments`,
  `share_with_person`, `stop_sharing` and `share_folder` read nothing into the chat by design; `box_shell` sees only
  folders everyone may open (20261118-devenv-shared-chats.md). Every connection call, read or write, passes
  `sharedGate` first (the asker-only card for their own connection, or for a team one that leaves someone out).
- **Tests:** `tests/unit/b-shared-readonly-tools.test.ts`.
- **Version impact:** patch (a card in a shared chat where none came).
